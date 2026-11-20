// Файловый API интерфейса Study поверх Syne Cloud.
//
// Интерфейс файлов (дерево, вкладки, рабочая область) устроен вокруг пар «владелец + путь».
// В облаке у файлов есть id и родитель, а чужих папок и прав доступа нет, поэтому здесь
// пути переводятся в id, а владелец всегда «свой» (пустая строка).
import * as cloud from "../lib/api";
import { ApiError } from "../lib/api";
import type { CloudFile } from "../types";
import type {
  AclRule,
  ConflictPolicy,
  DownloadResult,
  FileAction,
  FileEntry,
  FileText,
  QuotaInfo,
  Ref,
  RuleMode,
  UploadResult,
} from "./types";

import { TRANSFER_EVENT } from "./useTransfers";

export function newTransferId() {
  return crypto.randomUUID();
}

const segments = (p: string) => p.split("/").filter(Boolean);
const join = (parent: string, name: string) => (parent ? `${parent}/${name}` : name);
const parentOf = (p: string) => segments(p).slice(0, -1).join("/");
const nameOf = (p: string) => segments(p).slice(-1)[0] ?? "";

const notFound = () => new ApiError("Файл или папка не найдены.", 404, "not_found");
const exists = () => new ApiError("Такое имя уже занято.", 409, "exists");

function toEntry(f: CloudFile, path: string): FileEntry {
  return {
    name: f.name,
    path,
    is_dir: f.is_dir,
    size: f.size ?? 0,
    mod_time: Date.parse(f.updated_at) || 0,
    owner: "",
    owner_name: "",
  };
}

// ── кэш списков папок: путь → id проходит по дереву сверху вниз ──
const TTL_MS = 2500;
const listCache = new Map<string, { at: number; files: CloudFile[] }>();

async function children(parentId: string | null): Promise<CloudFile[]> {
  const key = parentId ?? "";
  const hit = listCache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.files;
  const files = (await cloud.listFiles(parentId)).filter((f) => !f.deleted_at);
  listCache.set(key, { at: Date.now(), files });
  return files;
}

function invalidate() {
  listCache.clear();
}

/** null — корень облака; undefined — такого пути нет. */
async function resolve(path: string): Promise<CloudFile | null | undefined> {
  let current: CloudFile | null = null;
  for (const seg of segments(path)) {
    const list = await children(current?.id ?? null);
    const next: CloudFile | undefined = list.find((f) => f.name === seg);
    if (!next) return undefined;
    current = next;
  }
  return current;
}

async function folderId(path: string): Promise<string | null> {
  const f = await resolve(path);
  if (f === undefined) throw notFound();
  if (f !== null && !f.is_dir) throw new ApiError("Это не папка.", 400, "invalid_path");
  return f?.id ?? null;
}

async function fileAt(path: string): Promise<CloudFile> {
  const f = await resolve(path);
  if (!f) throw notFound();
  return f;
}

async function listEntries(path: string): Promise<FileEntry[]> {
  const id = await folderId(path);
  return (await children(id)).map((f) => toEntry(f, join(path, f.name)));
}

// ── избранное и состояние окна: хранится на этом компьютере ──
const FAV_KEY = "syne-desktop.files.favorites";
const UI_KEY = "syne-desktop.files.ui";

function readFavs(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(FAV_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeFavs(list: string[]) {
  localStorage.setItem(FAV_KEY, JSON.stringify(list));
}

// ── передачи ──
const jobsByTransfer = new Map<string, string[]>();

function emit(id: string, name: string, jobs: cloud.TransferJob[]) {
  const total = jobs.reduce((a, j) => a + j.total, 0);
  const done = jobs.reduce((a, j) => a + j.done, 0);
  const running = jobs.some((j) => j.state === "running");
  const failed = jobs.find((j) => j.state === "error");
  const state = running ? "running" : failed ? "error" : "done";
  window.dispatchEvent(
    new CustomEvent(TRANSFER_EVENT, {
      detail: { id, name, done, total, state, error: failed?.error },
    }),
  );
}

/** Ждёт завершения заданий сервиса и пересылает прогресс интерфейсу. Возвращает итоговые задания. */
async function track(transferId: string, name: string, jobIds: string[]): Promise<cloud.TransferJob[]> {
  jobsByTransfer.set(transferId, jobIds);
  try {
    for (;;) {
      const all = await cloud.getTransfers();
      const mine = all.filter((j) => jobIds.includes(j.id));
      emit(transferId, name, mine);
      if (mine.length === 0 || !mine.some((j) => j.state === "running")) return mine;
      await new Promise((r) => setTimeout(r, 300));
    }
  } finally {
    jobsByTransfer.delete(transferId);
  }
}

async function startJobs(start: () => Promise<unknown>): Promise<string[]> {
  const before = new Set((await cloud.getTransfers()).map((j) => j.id));
  await start();
  return (await cloud.getTransfers()).map((j) => j.id).filter((id) => !before.has(id));
}

const sep = (p: string) => (p.includes("\\") ? "\\" : "/");

// ── копирование (в облаке нет операции «копировать»: читаем и пишем заново) ──
const MAX_COPY_BYTES = 32 * 1024 * 1024;

async function freeName(parentId: string | null, name: string): Promise<string> {
  const taken = new Set((await children(parentId)).map((f) => f.name));
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 1; ; i += 1) {
    const candidate = `${base} (копия${i > 1 ? ` ${i}` : ""})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

async function copyInto(src: CloudFile, destId: string | null, name: string): Promise<CloudFile> {
  if (src.is_dir) {
    const dir = (await cloud.createFolder(destId, name)).file;
    for (const child of await children(src.id)) await copyInto(child, dir.id, child.name);
    return dir;
  }
  if (src.size > MAX_COPY_BYTES) {
    throw new ApiError("Файл больше 32 МБ: скопируйте его скачиванием и загрузкой.", 413, "quota_exceeded");
  }
  const blob = await cloud.fileBlob(src.id);
  const res = await cloud.createFile(destId, name, blob);
  if (!res.file) throw new ApiError("Не удалось скопировать файл.", 500, "internal");
  return res.file;
}

export const filesApi = {
  /** Групп в облаке нет. */
  async listGroup(_group: string): Promise<FileEntry[]> {
    return [];
  },

  async shareGroup(_owner: string, _path: string, _group: string) {
    throw new ApiError("В облаке нет общего доступа к файлам.", 400, "invalid_request");
  },

  /** Чужих папок в облаке нет. */
  async listOwners(): Promise<FileEntry[]> {
    return [];
  },

  async list(_owner: string, path: string) {
    return { entries: await listEntries(path), truncated: false };
  },

  async stat(_owner: string, path: string): Promise<FileEntry | undefined> {
    const f = await resolve(path);
    return f ? toEntry(f, path) : undefined;
  },

  async mkdir(_owner: string, parent: string, name: string) {
    const parentId = await folderId(parent);
    if ((await children(parentId)).some((f) => f.name === name)) throw exists();
    const f = (await cloud.createFolder(parentId, name)).file;
    invalidate();
    return toEntry(f, join(parent, name));
  },

  async createFile(_owner: string, parent: string, name: string) {
    const parentId = await folderId(parent);
    if ((await children(parentId)).some((f) => f.name === name)) throw exists();
    const res = await cloud.createFile(parentId, name, new Blob([]));
    invalidate();
    if (!res.file) throw new ApiError("Не удалось создать файл.", 500, "internal");
    return toEntry(res.file, join(parent, name));
  },

  async rename(_owner: string, path: string, name: string) {
    const f = await fileAt(path);
    if ((await children(f.parent_id)).some((x) => x.name === name && x.id !== f.id)) throw exists();
    const next = (await cloud.renameFile(f.id, name)).file;
    invalidate();
    return toEntry(next, join(parentOf(path), name));
  },

  async remove(_owner: string, path: string) {
    const f = await fileAt(path);
    await cloud.trashFile(f.id);
    invalidate();
  },

  /** Копирование: src вставляется в папку dest. */
  async paste(src: Ref, dest: Ref, onConflict?: ConflictPolicy) {
    const from = await fileAt(src.path ?? "");
    const destPath = dest.path ?? "";
    const destId = await folderId(destPath);
    const taken = (await children(destId)).find((f) => f.name === from.name);
    let name = from.name;
    if (taken) {
      if (onConflict === "skip") return { entry: undefined, skipped: 1 };
      if (onConflict === "replace" && !taken.is_dir && !from.is_dir) {
        await cloud.trashFile(taken.id);
      } else {
        name = await freeName(destId, from.name);
      }
    }
    const copy = await copyInto(from, destId, name);
    invalidate();
    return { entry: toEntry(copy, join(destPath, name)), skipped: 0 };
  },

  async duplicate(_owner: string, path: string) {
    const f = await fileAt(path);
    const name = await freeName(f.parent_id, f.name);
    const copy = await copyInto(f, f.parent_id, name);
    invalidate();
    return toEntry(copy, join(parentOf(path), name));
  },

  // ----- права: в облаке все файлы принадлежат владельцу -----

  async rulesGet(_owner: string, _path: string): Promise<AclRule[]> {
    return [];
  },

  async ruleSet(_o: string, _p: string, _a: FileAction, _m: RuleMode, _u: string[] = []): Promise<AclRule[]> {
    return [];
  },

  async ruleClear(_o: string, _p: string, _a: FileAction): Promise<AclRule[]> {
    return [];
  },

  async quota(_owner = ""): Promise<QuotaInfo | undefined> {
    const q = await cloud.getQuota();
    return { used_bytes: q.used_bytes, limit_bytes: q.limit_bytes, unlimited: q.limit_bytes <= 0 };
  },

  // ----- избранное и состояние интерфейса -----

  async favAdd(_owner: string, path: string) {
    const list = readFavs();
    if (!list.includes(path)) writeFavs([...list, path]);
    return this.stat("", path);
  },

  async favRemove(_owner: string, path: string) {
    writeFavs(readFavs().filter((p) => p !== path));
  },

  async favList(): Promise<FileEntry[]> {
    const out: FileEntry[] = [];
    for (const path of readFavs()) {
      const e = await this.stat("", path).catch(() => undefined);
      if (e) out.push(e);
    }
    return out;
  },

  async uiGet<T>(): Promise<T | null> {
    try {
      const raw = localStorage.getItem(UI_KEY);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  },

  async uiPut(state: unknown) {
    localStorage.setItem(UI_KEY, JSON.stringify(state));
  },

  // ----- поиск -----

  /** Поиск по именам во всём облаке (по содержимому облако не ищет). */
  async search(query: string, opts: { content?: boolean; owner?: string; limit?: number } = {}) {
    const all = await cloud.listTree();
    const byId = new Map(all.map((f) => [f.id, f]));
    const pathOf = (f: CloudFile): string => {
      const parts = [f.name];
      let p = f.parent_id ? byId.get(f.parent_id) : undefined;
      while (p) {
        parts.unshift(p.name);
        p = p.parent_id ? byId.get(p.parent_id) : undefined;
      }
      return parts.join("/");
    };
    const needle = query.trim().toLowerCase();
    const hits = all
      .filter((f) => !f.deleted_at && f.name.toLowerCase().includes(needle))
      .map((f) => toEntry(f, pathOf(f)));
    const limit = opts.limit && opts.limit > 0 ? opts.limit : 200;
    return { entries: hits.slice(0, limit), truncated: hits.length > limit };
  },

  async send(_owner: string, _path: string, _toUser: string): Promise<FileEntry | undefined> {
    throw new ApiError("Отправка файлов из облака в чат не поддерживается.", 400, "invalid_request");
  },

  // ----- содержимое -----

  /** Байты файла (для просмотра картинок). */
  async blob(_owner: string, path: string): Promise<Blob> {
    return cloud.fileBlob((await fileAt(path)).id);
  },

  async readText(_owner: string, path: string): Promise<FileText> {
    const f = await fileAt(path);
    if (f.is_dir) throw new ApiError("Это папка.", 400, "invalid_path");
    return { entry: toEntry(f, path), text: await cloud.readText(f.id) };
  },

  /** baseModTime не нужен: конфликт определяет версия файла в облаке. */
  async writeText(_owner: string, path: string, text: string, _baseModTime: number) {
    const f = await fileAt(path);
    const res = await cloud.writeText(f, text);
    invalidate();
    if (res.conflict) {
      throw new ApiError("Файл изменили в другом месте: ваш текст сохранён отдельной копией.", 409, "conflict");
    }
    return res.file ? toEntry(res.file, path) : toEntry(f, path);
  },

  /** Скачать на диск. Папка скачивается как папка (с вложенными файлами). */
  async download(p: {
    owner: string;
    path: string;
    dir: boolean;
    dest_dir?: string;
    dest_path?: string;
    transfer_id?: string;
  }): Promise<DownloadResult> {
    const transferId = p.transfer_id ?? newTransferId();
    const root = await fileAt(p.path);
    const s = sep(p.dest_dir ?? p.dest_path ?? "/");
    const targets: { file: CloudFile; dest: string }[] = [];
    const walk = async (f: CloudFile, dest: string) => {
      if (f.is_dir) {
        for (const c of await children(f.id)) await walk(c, `${dest}${s}${c.name}`);
      } else {
        targets.push({ file: f, dest });
      }
    };
    const rootDest = p.dest_path ?? `${p.dest_dir}${s}${root.name}`;
    await walk(root, rootDest);

    const ids = await startJobs(async () => {
      for (const t of targets) await cloud.downloadFile(t.file, t.dest);
    });
    const jobs = await track(transferId, root.name, ids);
    const failed = jobs.find((j) => j.state === "error");
    if (failed) throw new ApiError(failed.error ?? "Не удалось скачать.", 500, "internal");
    return { path: rootDest, bytes: jobs.reduce((a, j) => a + j.total, 0) };
  },

  /**
   * Загрузить файлы и папки с компьютера. Если имена заняты и политика не выбрана,
   * вернётся conflicts без загрузки.
   */
  async upload(p: {
    owner: string;
    path: string;
    local_paths: string[];
    on_conflict?: ConflictPolicy;
    base_mod_time?: number;
    files_only?: boolean;
    transfer_id?: string;
  }): Promise<UploadResult> {
    const transferId = p.transfer_id ?? newTransferId();
    const parentId = await folderId(p.path);
    const existing = await children(parentId);
    const base = (lp: string) => lp.split(/[\\/]/).filter(Boolean).slice(-1)[0] ?? lp;

    const clashes = p.local_paths.filter((lp) => existing.some((f) => f.name === base(lp)));
    if (clashes.length > 0 && !p.on_conflict) {
      return { uploaded: 0, skipped: 0, conflicts: clashes.map(base) };
    }
    let paths = p.local_paths;
    let skipped = 0;
    if (p.on_conflict === "skip") {
      paths = paths.filter((lp) => !clashes.includes(lp));
      skipped = clashes.length;
    }

    const replaced = new Set<string>();
    const ids = await startJobs(async () => {
      for (const lp of paths) {
        const clash = existing.find((f) => f.name === base(lp));
        if (clash && !clash.is_dir && p.on_conflict === "replace") {
          replaced.add(lp);
          await cloud.uploadReplace(lp, clash.id, clash.version);
        } else {
          await cloud.uploadPaths([lp], parentId);
        }
      }
    });
    const label = paths.length === 1 ? base(paths[0]) : `файлов: ${paths.length}`;
    const jobs = await track(transferId, label, ids);
    invalidate();

    const failed = jobs
      .filter((j) => j.state === "error")
      .map((j) => ({ path: j.name, error: j.error ?? "Не удалось загрузить" }));
    // Новые записи: то, чего не было в папке до загрузки (с учётом копий «… (конфликт …)»),
    // и файлы, у которых заменили содержимое.
    const oldIds = new Set(existing.map((f) => f.id));
    const names = paths.map(base);
    const replacedNames = new Set([...replaced].map(base));
    const fresh = (await children(parentId)).filter(
      (f) =>
        (replacedNames.has(f.name)) ||
        (!oldIds.has(f.id) && names.some((n) => f.name === n || f.name.startsWith(`${stem(n)} (`))),
    );
    const items = p.files_only
      ? fresh.filter((f) => !f.is_dir).map((f) => toEntry(f, join(p.path, f.name)))
      : fresh.map((f) => toEntry(f, join(p.path, f.name)));
    return {
      uploaded: jobs.filter((j) => j.state === "done").length,
      skipped,
      failed: failed.length ? failed : undefined,
      items,
    };
  },

  async cancelTransfer(transferId: string) {
    for (const id of jobsByTransfer.get(transferId) ?? []) await cloud.cancelTransfer(id).catch(() => undefined);
    return { ok: true };
  },
};

function stem(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}
