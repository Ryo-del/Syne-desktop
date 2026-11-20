import { invoke, isTauri } from "@tauri-apps/api/core";

import type {
  AuthState,
  CloudChat,
  CloudFile,
  CloudMember,
  CloudMessage,
  Device,
  FileVersion,
  HubState,
  Quota,
  Transfer,
  User,
} from "../types";

const API_BASE =
  import.meta.env.VITE_API_BASE?.toString() ?? "http://127.0.0.1:38674";

/** Ошибка локального сервиса или облака. code — машинный код (invalid_grant, exists...). */
export class ApiError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 0, code = "") {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

let apiToken = "";
const ready: Promise<void> = (async () => {
  if (!isTauri()) return;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      apiToken = await invoke<string>("backend_token");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    }
  }
})();

export const getApiBase = () => API_BASE;
export const whenApiReady = () => ready;
/** Заголовки для запросов к локальному сервису вне request() (например, fetch с keepalive). */
export const authHeaders = (): Record<string, string> => (apiToken ? { "X-Syne-Token": apiToken } : {});

/** Слушатели «вход недействителен»: срабатывают на любом 401 от облака. */
const signedOutListeners = new Set<() => void>();
export function onSignedOut(fn: () => void) {
  signedOutListeners.add(fn);
  return () => {
    signedOutListeners.delete(fn);
  };
}

export async function request(path: string, init: RequestInit = {}): Promise<Response> {
  await ready;
  const headers = new Headers(init.headers);
  if (apiToken) headers.set("X-Syne-Token", apiToken);
  let res: Response;
  try {
    res = await fetch(API_BASE + path, { ...init, headers });
  } catch {
    throw new ApiError("Локальный сервис Syne не отвечает. Перезапустите приложение.", 0, "backend_down");
  }
  if (res.status === 401 && !path.startsWith("/auth/")) {
    signedOutListeners.forEach((fn) => fn());
  }
  if (!res.ok) {
    let body: { error?: string; message?: string } = {};
    try {
      body = await res.json();
    } catch {
      /* тело не JSON */
    }
    throw new ApiError(body.message ?? `Ошибка (${res.status})`, res.status, body.error ?? "");
  }
  return res;
}

async function json<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await request(path, init);
  return (await res.json()) as T;
}

function send(method: string, body?: unknown): RequestInit {
  return body === undefined
    ? { method }
    : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

const qs = (params: Record<string, string | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
};

// ── вход ──
export const authState = () => json<AuthState>("/auth/state");
export const login = (username: string, password: string, server?: string) =>
  json<AuthState>("/auth/login", send("POST", { username, password, server }));
export const logout = () => json<AuthState>("/auth/logout", send("POST"));

// ── аккаунт ──
export const getMe = () => json<{ user: User; quota: Quota }>("/cloud/me");
export const getDevices = async () => (await json<{ devices: Device[] }>("/cloud/me/devices")).devices;
export const revokeDevice = (id: string) => request(`/cloud/me/devices/${id}`, send("DELETE"));
export const getSettings = () => json<Record<string, unknown>>("/cloud/me/settings");
export const putSettings = (s: Record<string, unknown>) =>
  json<Record<string, unknown>>("/cloud/me/settings", send("PUT", s));

// ── файлы ──
export const listFiles = async (parentId: string | null) =>
  (await json<{ files: CloudFile[] }>(`/cloud/files${qs({ parent_id: parentId ?? undefined })}`)).files;
export const getFile = async (id: string) => (await json<{ file: CloudFile }>(`/cloud/files/${id}`)).file;
export const createFolder = (parentId: string | null, name: string) =>
  json<{ file: CloudFile }>("/cloud/files/folders", send("POST", { parent_id: parentId, name }));
export const renameFile = (id: string, name: string) =>
  json<{ file: CloudFile }>(`/cloud/files/${id}`, send("PATCH", { name }));
export const moveFile = (id: string, parentId: string | null) =>
  json<{ file: CloudFile }>(`/cloud/files/${id}`, send("PATCH", { parent_id: parentId }));
export const trashFile = (id: string) => request(`/cloud/files/${id}`, send("DELETE"));
export const listVersions = async (id: string) =>
  (await json<{ versions: FileVersion[] }>(`/cloud/files/${id}/versions`)).versions;
export const restoreVersion = (id: string, version: number) =>
  request(`/cloud/files/${id}/versions/${version}/restore`, send("POST"));
export const listTrash = async () =>
  json<{ files: CloudFile[]; ttl_days: number }>("/cloud/trash");
export const restoreTrash = (id: string) => request(`/cloud/trash/${id}/restore`, send("POST"));
export const deleteTrash = (id: string) => request(`/cloud/trash/${id}`, send("DELETE"));
export const searchFiles = async (q: string) =>
  (await json<{ files: CloudFile[] }>(`/cloud/files/tree`)).files.filter(
    (f) => !f.deleted_at && f.name.toLowerCase().includes(q.toLowerCase()),
  );
export const listTree = async () => (await json<{ files: CloudFile[] }>("/cloud/files/tree")).files;
export const getQuota = async () => (await json<{ quota: Quota }>("/cloud/me")).quota;

/** Содержимое файла (для просмотра фото и текста). */
export async function fileBlob(id: string): Promise<Blob> {
  return (await request(`/cloud/files/${id}/content?inline=1`)).blob();
}

// ── передачи (чанки, докачка и sha256 делает локальный сервис) ──
export type TransferJob = Transfer;
export const uploadPaths = (paths: string[], parentId: string | null) =>
  json<{ transfers: Transfer[] }>("/transfers/upload", send("POST", { paths, parent_id: parentId ?? "" }));
/** Новая версия существующего файла (замена при конфликте имён). */
export const uploadReplace = (path: string, fileId: string, version: number) =>
  json<{ transfers: Transfer[] }>("/transfers/upload", send("POST", { paths: [path], replace_id: fileId, replace_version: version }));
export const downloadFile = (f: CloudFile, dest: string, version?: number) =>
  json<{ transfers: Transfer[] }>(
    "/transfers/download",
    send("POST", { id: f.id, name: f.name, size: f.size, dest, version: version ? String(version) : "" }),
  );
export const getTransfers = async () => (await json<{ transfers: Transfer[] }>("/transfers")).transfers;
export const cancelTransfer = (id: string) => request(`/transfers/cancel?id=${id}`, send("POST"));
export const clearTransfers = () => request("/transfers", send("DELETE"));

// ── Key Hub (чаты): ключи и шифрование — в локальном сервисе ──
export const hubState = () => json<HubState>("/hub/state");
export const hubRecheck = () => json<HubState>("/hub/recheck", send("POST"));
export const hubRetry = () => json<HubState>("/hub/retry", send("POST"));
export const hubCancel = () => json<AuthState>("/hub/cancel", send("POST"));
export const hubDisconnect = () => json<AuthState>("/hub/disconnect", send("POST"));
export const hubSend = (peer: string, text: string) => json<HubState>("/hub/send", send("POST", { peer, text }));
export const hubApprove = (requestId: string, trusted: boolean) =>
  json<HubState>("/hub/approve", send("POST", { request_id: requestId, trusted }));
export const hubReject = (requestId: string) => json<HubState>("/hub/reject", send("POST", { request_id: requestId }));
export const hubPromote = (deviceId: string) => json<HubState>("/hub/promote", send("POST", { device_id: deviceId }));
export const hubRevoke = (deviceId: string) => json<HubState>("/hub/revoke", send("POST", { device_id: deviceId }));
export const hubAcceptPeer = (peer: string) => json<HubState>("/hub/accept-peer", send("POST", { peer }));
export const hubRoster = (confirm: boolean) => json<HubState>("/hub/roster", send("POST", { confirm }));
export const hubSafety = async (peer: string) =>
  (await json<{ number: string }>(`/hub/safety${qs({ peer })}`)).number;

// ── обычные облачные чаты (открытым текстом) ──
export const listChats = async () => (await json<{ chats: CloudChat[] }>("/cloud/chats")).chats;
export const lookupUser = (login: string) => json<CloudMember>(`/cloud/users/lookup${qs({ login })}`);
export const openChat = (memberId: string) =>
  json<CloudChat>("/cloud/chats", send("POST", { member_ids: [memberId], is_group: false }));
export const listMessages = async (chatId: string, after?: number) =>
  (await json<{ messages: CloudMessage[] }>(`/cloud/chats/${chatId}/messages${qs({ after: after === undefined ? undefined : String(after), limit: "200" })}`)).messages;
export const sendMessage = (chatId: string, body: string) =>
  json<CloudMessage>(`/cloud/chats/${chatId}/messages`, send("POST", { client_id: crypto.randomUUID(), body }));
export async function sendAttachment(chatId: string, file: File, body = ""): Promise<CloudMessage> {
  return json<CloudMessage>(
    `/cloud/chats/${chatId}/attachments${qs({ client_id: crypto.randomUUID(), name: file.name, body })}`,
    { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file },
  );
}
export const chatAttachment = async (chatId: string, messageId: number) =>
  (await request(`/cloud/chats/${chatId}/messages/${messageId}/attachment`)).blob();

/** Создаёт файл (до 32 МБ) одним запросом: пустой, копия или новый. */
export async function createFile(parentId: string | null, name: string, body: Blob) {
  return json<{ file?: CloudFile; conflict?: boolean }>(
    `/cloud/files/content${qs({ parent_id: parentId ?? undefined, name })}`,
    { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body },
  );
}

// ── текстовые файлы ──
export async function readText(id: string): Promise<string> {
  return (await request(`/cloud/files/${id}/content?inline=1`)).text();
}
/** Сохраняет новую версию. conflict=true: файл успели изменить, ваш текст сохранён копией. */
export async function writeText(file: CloudFile, text: string) {
  return json<{ file?: CloudFile; conflict?: boolean; unchanged?: boolean }>(
    `/cloud/files/content${qs({ file_id: file.id, base_version: String(file.version), name: file.name })}`,
    { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: text },
  );
}

// ── события облака (WebSocket через локальный сервис) ──
export async function openEvents(onEvent: (type: string) => void): Promise<() => void> {
  await ready;
  const es = new EventSource(`${API_BASE}/events${apiToken ? `?token=${apiToken}` : ""}`);
  es.onmessage = (e) => {
    try {
      onEvent((JSON.parse(e.data) as { type?: string }).type ?? "");
    } catch {
      /* не JSON */
    }
  };
  es.addEventListener("signed_out", () => signedOutListeners.forEach((fn) => fn()));
  return () => es.close();
}

// ── вложения Key Hub: шифрование и загрузка делает локальный сервис ──
export const hubSendFile = (peer: string, path: string, caption = "") =>
  json<HubState>("/hub/send-file", send("POST", { peer, path, caption }));
export const hubSaveAttachment = (id: string, dest: string) =>
  json<HubState>("/hub/attachment/save", send("POST", { id, dest }));
export const hubAttachmentBlob = async (id: string) => (await request(`/hub/attachment${qs({ id })}`)).blob();
