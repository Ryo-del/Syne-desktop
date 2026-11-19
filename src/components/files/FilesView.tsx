import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import { isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { iconUrl } from "../../files/icons";
import * as api from "../../lib/api";
import { formatBytes, formatDate } from "../../lib/format";
import type { CloudFile, FileVersion, Quota, Transfer } from "../../types";
import "./files.css";
import "./desktop.css";

interface Crumb {
  id: string | null;
  name: string;
}

type Modal =
  | { kind: "folder" }
  | { kind: "rename"; file: CloudFile }
  | { kind: "delete"; file: CloudFile }
  | { kind: "versions"; file: CloudFile }
  | { kind: "trash" }
  | { kind: "edit"; file: CloudFile };

const errText = (e: unknown) => (e instanceof Error ? e.message : "Что-то пошло не так");

const TEXT_EXT = new Set(["txt","md","markdown","json","yaml","yml","toml","ini","cfg","conf","env","log","csv","tsv","xml","html","htm","css","scss","js","jsx","ts","tsx","mjs","py","go","rs","java","kt","c","h","cpp","hpp","cs","php","rb","sh","bat","ps1","sql","swift","lua","gitignore","dockerfile","makefile"]);
const MAX_TEXT = 1 << 20;
function isText(f: CloudFile): boolean {
  if (f.is_dir || f.size > MAX_TEXT) return false;
  const name = f.name.toLowerCase();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
  return TEXT_EXT.has(ext);
}

export default function FilesView({ quota, onQuota, tick }: { quota: Quota | null; onQuota: () => void; tick: number }) {
  const [path, setPath] = useState<Crumb[]>([{ id: null, name: "Облако" }]);
  const [files, setFiles] = useState<CloudFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CloudFile[] | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; file: CloudFile } | null>(null);
  const [modal, setModal] = useState<Modal | null>(null);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [dropping, setDropping] = useState(false);
  const here = path[path.length - 1];
  const hereRef = useRef(here);
  hereRef.current = here;

  const load = useCallback(async () => {
    try {
      const list = await api.listFiles(hereRef.current.id);
      setFiles(list);
      setError("");
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [here.id, load]);

  // Изменение на другом устройстве (WebSocket облака): обновляем список и место.
  useEffect(() => {
    if (tick > 0) {
      void load();
      onQuota();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  // Поиск: по всему дереву, с небольшой задержкой.
  useEffect(() => {
    if (!query.trim()) {
      setResults(null);
      return;
    }
    const t = setTimeout(() => {
      api.searchFiles(query.trim()).then(setResults).catch((e) => setError(errText(e)));
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  // Передачи опрашиваем, пока есть активные; по завершении обновляем список и место.
  const active = transfers.some((t) => t.state === "running");
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(async () => {
      try {
        const next = await api.getTransfers();
        setTransfers((prev) => {
          if (prev.some((p) => p.state === "running") && !next.some((n) => n.state === "running")) {
            void load();
            onQuota();
          }
          return next;
        });
      } catch {
        /* повторим на следующем тике */
      }
    }, 800);
    return () => clearInterval(timer);
  }, [active, load, onQuota]);

  const startUpload = useCallback(
    async (paths: string[]) => {
      if (!paths.length) return;
      try {
        setTransfers((await api.uploadPaths(paths, hereRef.current.id)).transfers);
      } catch (e) {
        setError(errText(e));
      }
    },
    [],
  );

  // Перетаскивание файлов из системы.
  useEffect(() => {
    if (!isTauri()) return;
    let off: (() => void) | undefined;
    let cancelled = false;
    getCurrentWebview()
      .onDragDropEvent((ev) => {
        const p = ev.payload;
        if (p.type === "enter" || p.type === "over") setDropping(true);
        else if (p.type === "leave") setDropping(false);
        else if (p.type === "drop") {
          setDropping(false);
          void startUpload(p.paths);
        }
      })
      .then((fn) => (cancelled ? fn() : (off = fn)));
    return () => {
      cancelled = true;
      off?.();
    };
  }, [startUpload]);

  useEffect(() => {
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
    };
  }, []);

  const sorted = useMemo(
    () =>
      [...files].sort((a, b) =>
        a.is_dir !== b.is_dir ? (a.is_dir ? -1 : 1) : a.name.localeCompare(b.name, "ru", { numeric: true }),
      ),
    [files],
  );

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setError("");
      await load();
      onQuota();
      return true;
    } catch (e) {
      setError(errText(e));
      return false;
    }
  };

  const openFile = (f: CloudFile) => {
    if (f.is_dir) {
      setQuery("");
      setPath((p) => [...p, { id: f.id, name: f.name }]);
    } else if (isText(f)) {
      setModal({ kind: "edit", file: f });
    } else {
      void download(f);
    }
  };

  async function download(f: CloudFile, version?: number) {
    try {
      const dest = await save({ defaultPath: f.name });
      if (!dest) return;
      setTransfers((await api.downloadFile(f, dest, version)).transfers);
    } catch (e) {
      setError(errText(e));
    }
  }

  async function pickFiles() {
    const picked = await open({ multiple: true });
    if (picked) await startUpload(Array.isArray(picked) ? picked : [picked]);
  }

  const shown = results ?? sorted;
  const pct = quota && quota.limit_bytes > 0 ? Math.min(100, (quota.used_bytes / quota.limit_bytes) * 100) : 0;

  return (
    <div className="fx-root">
      <div className="fx-topbar">
        <div className="fx-searchwrap">
          <input
            className="fx-search"
            placeholder="Поиск по всем файлам"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      <div className="dk-head">
        <div className="dk-crumbs">
          {path.map((c, i) => (
            <span key={c.id ?? "root"}>
              {i > 0 ? <span className="dk-sep">/</span> : null}
              <button
                type="button"
                className={`dk-crumb ${i === path.length - 1 ? "current" : ""}`}
                onClick={() => {
                  setQuery("");
                  setPath(path.slice(0, i + 1));
                }}
              >
                {c.name}
              </button>
            </span>
          ))}
        </div>
        <div className="dk-actions">
          <button type="button" className="fx-btn" onClick={() => setModal({ kind: "folder" })}>
            Новая папка
          </button>
          <button type="button" className="fx-btn" onClick={() => setModal({ kind: "trash" })}>
            Корзина
          </button>
          <button type="button" className="fx-btn dk-primary" onClick={pickFiles}>
            Загрузить
          </button>
        </div>
      </div>

      {error ? (
        <div className="fx-notice" onClick={() => setError("")}>
          {error}
        </div>
      ) : null}

      <div className={`dk-list ${dropping ? "drop-ok" : ""}`}>
        <div className="dk-row dk-row-head">
          <span>Имя</span>
          <span className="dk-col">Размер</span>
          <span className="dk-col wide">Изменён</span>
        </div>
        {loading ? <div className="fx-hint">Загрузка…</div> : null}
        {!loading && shown.length === 0 ? (
          <div className="fx-hint">
            {results ? "Ничего не найдено." : "Папка пуста. Перетащите сюда файлы или нажмите «Загрузить»."}
          </div>
        ) : null}
        {shown.map((f) => (
          <div
            key={f.id}
            className="dk-row"
            onDoubleClick={() => openFile(f)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, file: f });
            }}
          >
            <span className="dk-name">
              <img className="fx-icon" src={iconUrl(f.name, f.is_dir)} alt="" />
              <span className="fx-name">{f.name}</span>
            </span>
            <span className="dk-col">{f.is_dir ? "" : formatBytes(f.size)}</span>
            <span className="dk-col wide">{formatDate(f.updated_at)}</span>
          </div>
        ))}
      </div>

      {transfers.length > 0 ? (
        <div className="dk-transfers">
          {transfers.map((t) => (
            <div className="dk-transfer" key={t.id}>
              <span className="fx-name">
                {t.kind === "upload" ? "↑" : "↓"} {t.name}
              </span>
              <span className="dk-transfer-state">
                {t.state === "running"
                  ? `${t.total ? Math.round((t.done / t.total) * 100) : 0}%`
                  : t.state === "done"
                    ? "Готово"
                    : t.state === "cancelled"
                      ? "Отменено"
                      : t.error}
              </span>
              {t.state === "running" ? (
                <button type="button" className="fx-link" onClick={() => void api.cancelTransfer(t.id).then(api.getTransfers).then(setTransfers)}>
                  Отмена
                </button>
              ) : null}
            </div>
          ))}
          {!active ? (
            <button type="button" className="fx-link" onClick={() => void api.clearTransfers().then(() => setTransfers([]))}>
              Скрыть
            </button>
          ) : null}
        </div>
      ) : null}

      {quota ? (
        <div className="fx-quota">
          <div className="fx-quota-bar">
            <div className="fx-quota-fill" style={{ width: `${pct}%` }} />
          </div>
          <span>
            {formatBytes(quota.used_bytes)} из {formatBytes(quota.limit_bytes)}
          </span>
        </div>
      ) : null}

      {menu ? (
        <div className="fx-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          <button className="fx-menu-item" onClick={() => { openFile(menu.file); setMenu(null); }}>
            {menu.file.is_dir || isText(menu.file) ? "Открыть" : "Скачать…"}
          </button>
          {isText(menu.file) ? (
            <button className="fx-menu-item" onClick={() => { void download(menu.file); setMenu(null); }}>
              Скачать…
            </button>
          ) : null}
          {!menu.file.is_dir ? (
            <button className="fx-menu-item" onClick={() => { setModal({ kind: "versions", file: menu.file }); setMenu(null); }}>
              Версии
            </button>
          ) : null}
          <button className="fx-menu-item" onClick={() => { setModal({ kind: "rename", file: menu.file }); setMenu(null); }}>
            Переименовать
          </button>
          <div className="fx-menu-sep" />
          <button className="fx-menu-item" onClick={() => { setModal({ kind: "delete", file: menu.file }); setMenu(null); }}>
            В корзину
          </button>
        </div>
      ) : null}

      {modal?.kind === "folder" ? (
        <NameDialog
          title="Новая папка"
          action="Создать"
          onClose={() => setModal(null)}
          onSubmit={(name) => run(() => api.createFolder(here.id, name))}
        />
      ) : null}
      {modal?.kind === "rename" ? (
        <NameDialog
          title="Переименовать"
          action="Сохранить"
          initial={modal.file.name}
          onClose={() => setModal(null)}
          onSubmit={(name) => run(() => api.renameFile(modal.file.id, name))}
        />
      ) : null}
      {modal?.kind === "delete" ? (
        <Confirm
          title={`Переместить «${modal.file.name}» в корзину?`}
          text="Его можно будет вернуть из корзины."
          action="В корзину"
          onClose={() => setModal(null)}
          onConfirm={() => run(() => api.trashFile(modal.file.id))}
        />
      ) : null}
      {modal?.kind === "versions" ? (
        <VersionsDialog
          file={modal.file}
          onClose={() => setModal(null)}
          onDownload={(v) => void download(modal.file, v)}
          onRestored={() => void load()}
        />
      ) : null}
      {modal?.kind === "edit" ? (
        <EditorDialog
          file={modal.file}
          onClose={() => setModal(null)}
          onSaved={() => {
            void load();
            onQuota();
          }}
        />
      ) : null}
      {modal?.kind === "trash" ? <TrashDialog onClose={() => setModal(null)} onChanged={() => { void load(); onQuota(); }} /> : null}
    </div>
  );
}

function Backdrop({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fx-modal-backdrop" onMouseDown={onClose}>
      <div className="fx-modal fx-modal-small" onMouseDown={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

function NameDialog(props: {
  title: string;
  action: string;
  initial?: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<boolean>;
}) {
  const [name, setName] = useState(props.initial ?? "");
  const [busy, setBusy] = useState(false);
  return (
    <Backdrop onClose={props.onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          setBusy(true);
          if (await props.onSubmit(name.trim())) props.onClose();
          else setBusy(false);
        }}
        style={{ display: "contents" }}
      >
        <div className="fx-modal-title">{props.title}</div>
        <input className="fx-input" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        <div className="fx-modal-actions">
          <button type="button" className="fx-btn" onClick={props.onClose}>
            Отмена
          </button>
          <button type="submit" className="fx-btn dk-primary" disabled={busy || !name.trim()}>
            {props.action}
          </button>
        </div>
      </form>
    </Backdrop>
  );
}

function Confirm(props: { title: string; text: string; action: string; onClose: () => void; onConfirm: () => Promise<boolean> }) {
  const [busy, setBusy] = useState(false);
  return (
    <Backdrop onClose={props.onClose}>
      <div className="fx-modal-title">{props.title}</div>
      <div className="fx-modal-text">{props.text}</div>
      <div className="fx-modal-actions">
        <button type="button" className="fx-btn" onClick={props.onClose}>
          Отмена
        </button>
        <button
          type="button"
          className="fx-btn dk-primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await props.onConfirm();
            props.onClose();
          }}
        >
          {props.action}
        </button>
      </div>
    </Backdrop>
  );
}

function VersionsDialog(props: {
  file: CloudFile;
  onClose: () => void;
  onDownload: (v: number) => void;
  onRestored: () => void;
}) {
  const [versions, setVersions] = useState<FileVersion[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api.listVersions(props.file.id).then(setVersions).catch((e) => setError(errText(e)));
  }, [props.file.id]);
  return (
    <Backdrop onClose={props.onClose}>
      <div className="fx-modal-title">Версии «{props.file.name}»</div>
      {error ? <div className="fx-modal-error">{error}</div> : null}
      {versions === null && !error ? <div className="fx-modal-text">Загрузка…</div> : null}
      <div className="dk-modal-list">
        {versions?.map((v) => (
          <div className="dk-modal-row" key={v.version}>
            <span>
              Версия {v.version}
              {v.version === props.file.version ? " (текущая)" : ""}
              <small>
                {formatDate(v.created_at)} · {formatBytes(v.size)} · {v.device}
              </small>
            </span>
            <span className="dk-modal-btns">
              <button className="fx-link" onClick={() => props.onDownload(v.version)}>
                Скачать
              </button>
              {v.version !== props.file.version ? (
                <button
                  className="fx-link"
                  onClick={async () => {
                    try {
                      await api.restoreVersion(props.file.id, v.version);
                      props.onRestored();
                      props.onClose();
                    } catch (e) {
                      setError(errText(e));
                    }
                  }}
                >
                  Восстановить
                </button>
              ) : null}
            </span>
          </div>
        ))}
      </div>
      <div className="fx-modal-actions">
        <button className="fx-btn" onClick={props.onClose}>
          Закрыть
        </button>
      </div>
    </Backdrop>
  );
}

function TrashDialog({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [items, setItems] = useState<CloudFile[] | null>(null);
  const [ttl, setTtl] = useState(0);
  const [error, setError] = useState("");
  const reload = useCallback(async () => {
    try {
      const r = await api.listTrash();
      setItems(r.files);
      setTtl(r.ttl_days);
    } catch (e) {
      setError(errText(e));
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await reload();
      onChanged();
    } catch (e) {
      setError(errText(e));
    }
  };
  return (
    <Backdrop onClose={onClose}>
      <div className="fx-modal-title">Корзина</div>
      {ttl ? <div className="fx-modal-text">Файлы удаляются навсегда через {ttl} дн.</div> : null}
      {error ? <div className="fx-modal-error">{error}</div> : null}
      {items?.length === 0 ? <div className="fx-modal-text">Корзина пуста.</div> : null}
      <div className="dk-modal-list">
        {items?.map((f) => (
          <div className="dk-modal-row" key={f.id}>
            <span className="dk-name">
              <img className="fx-icon" src={iconUrl(f.name, f.is_dir)} alt="" />
              <span className="fx-name">{f.name}</span>
            </span>
            <span className="dk-modal-btns">
              <button className="fx-link" onClick={() => void act(() => api.restoreTrash(f.id))}>
                Вернуть
              </button>
              <button className="fx-link" onClick={() => void act(() => api.deleteTrash(f.id))}>
                Удалить
              </button>
            </span>
          </div>
        ))}
      </div>
      <div className="fx-modal-actions">
        <button className="fx-btn" onClick={onClose}>
          Закрыть
        </button>
      </div>
    </Backdrop>
  );
}

function EditorDialog({ file, onClose, onSaved }: { file: CloudFile; onClose: () => void; onSaved: () => void }) {
  const [original, setOriginal] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [current, setCurrent] = useState(file);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .readText(file.id)
      .then((s) => {
        setOriginal(s);
        setText(s);
      })
      .catch((e) => setError(errText(e)));
  }, [file.id]);

  const dirty = original !== null && text !== original;

  async function save() {
    setBusy(true);
    setError("");
    try {
      const r = await api.writeText(current, text);
      if (r.conflict) {
        setNote("Файл успели изменить на другом устройстве. Ваш текст сохранён отдельной копией «… (конфликт …)» рядом с ним.");
        setOriginal(text);
      } else {
        if (r.file) setCurrent(r.file);
        setOriginal(text);
        setNote(r.unchanged ? "Изменений нет." : "Сохранено.");
      }
      onSaved();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  const close = () => {
    if (!dirty || window.confirm("Закрыть без сохранения? Правки пропадут.")) onClose();
  };

  return (
    <div className="fx-modal-backdrop" onMouseDown={close}>
      <div className="fx-modal dk-editor" onMouseDown={(e) => e.stopPropagation()}>
        <div className="fx-modal-title">
          {file.name}
          {dirty ? " •" : ""}
        </div>
        {error ? <div className="fx-modal-error">{error}</div> : null}
        {note ? <div className="fx-modal-text">{note}</div> : null}
        {original === null && !error ? <div className="fx-modal-text">Загрузка…</div> : null}
        {original !== null ? (
          <textarea
            className="dk-editor-area"
            spellCheck={false}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setNote("");
            }}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
                e.preventDefault();
                if (dirty && !busy) void save();
              }
              if (e.key === "Tab") {
                e.preventDefault();
                const el = e.currentTarget;
                const { selectionStart: a, selectionEnd: b } = el;
                setText(text.slice(0, a) + "  " + text.slice(b));
                requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2));
              }
            }}
          />
        ) : null}
        <div className="fx-modal-actions">
          <span className="fx-modal-count">Ctrl+S — сохранить</span>
          <button className="fx-btn" onClick={close}>
            Закрыть
          </button>
          <button className="fx-btn dk-primary" disabled={!dirty || busy} onClick={() => void save()}>
            Сохранить
          </button>
        </div>
      </div>
    </div>
  );
}
