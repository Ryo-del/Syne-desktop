export interface User {
  id: string;
  login: string;
  name: string;
  role: string;
  school_id: string | null;
}

export interface AuthState {
  server: string;
  signed_in: boolean;
  user?: User;
  offline?: boolean;
  reason?: string;
}

export interface CloudFile {
  id: string;
  parent_id: string | null;
  name: string;
  is_dir: boolean;
  version: number;
  size: number;
  sha256?: string;
  rev: number;
  deleted_at?: string;
  created_at: string;
  updated_at: string;
}

export interface FileVersion {
  version: number;
  size: number;
  sha256: string;
  device: string;
  created_at: string;
}

export interface Quota {
  limit_bytes: number;
  used_bytes: number;
  base_bytes?: number;
  plan_bytes?: number;
  plan_expires_at?: string | null;
  extra_bytes?: number;
}

export interface Device {
  id: string;
  client_id: string;
  device_name: string;
  signed_in_at: string;
  last_refresh_at: string;
}

export interface Transfer {
  id: string;
  kind: "upload" | "download";
  name: string;
  done: number;
  total: number;
  state: "running" | "done" | "error" | "cancelled";
  error?: string;
}

export interface AuthStateReason extends AuthState {
  reason?: string;
}

export interface HubMessage {
  id: string;
  peer: string;
  from: string;
  text: string;
  ts: number;
  outgoing: boolean;
  group_name?: string;
  att?: HubAttachment;
}

export interface HubAttachment {
  kind: "photo" | "file";
  name: string;
  mime?: string;
  size: number;
  caption?: string;
  thumb?: string; // base64 JPEG
  w?: number;
  h?: number;
}

export interface HubDevice {
  id: string;
  name: string;
  type: string;
  trusted: boolean;
  current: boolean;
}

export interface HubView {
  state: "not_set_up" | "awaiting" | "ready" | "revoked";
  login: string;
  short_login: string;
  school_name: string;
  device_id: string;
  pair_code: string;
  request_status: string;
  can_approve: boolean;
  devices: HubDevice[];
  names: Record<string, string> | null;
  accounts: Record<string, string> | null;
  messages: HubMessage[];
  roster_key_id?: string;
}

export interface HubPending {
  req: { request_id: string; name: string; type: string };
  pair_code: string;
  created_at: number;
  expires_at: number;
}

export interface HubTrustError {
  login: string;
  kind: "reset" | "rollback" | "fork";
  safety_number: string;
}

export interface HubGate {
  status: "off" | "checking" | "open" | "waiting" | "denied" | "unreachable" | "revoked";
  code?: string;
  detail?: string;
}

export interface HubState {
  gate: HubGate;
  view?: HubView;
  pending: HubPending[];
  trust_error?: HubTrustError;
  error?: string;
}

export interface CloudMember {
  id: string;
  login: string;
  name: string;
}

export interface CloudAttachment {
  sha256: string;
  name: string;
  size: number;
}

export interface CloudMessage {
  id: number;
  chat_id: string;
  author_id: string;
  client_id: string;
  body: string;
  attachment?: CloudAttachment | null;
  created_at: string;
}

export interface CloudChat {
  id: string;
  title: string;
  is_group: boolean;
  members: CloudMember[];
  created_at: string;
  last_message?: CloudMessage | null;
}

// ── модель чата в интерфейсе (общая для защищённых бесед Key Hub и обычных облачных чатов) ──

export type TransferProgress = {
  id: string;
  name: string;
  done: number;
  total: number; // 0 — размер неизвестен
  state: "running" | "done" | "error";
  error?: string;
};

/** Вложение сообщения: откуда его брать и как показывать. */
export type MessageAttachment = {
  source: "hub" | "cloud";
  /** hub: id сообщения; cloud: id сообщения в чате. */
  id: string;
  chat_id: string;
  kind: "photo" | "file";
  name: string;
  size: number;
  thumb?: string; // base64 JPEG (только Key Hub)
};

export type ChatSummary = {
  /** `hub:<собеседник>` — защищённая беседа, `cloud:<id>` — обычный облачный чат. */
  chat_id: string;
  peer_id: string;
  title: string;
  preview: string;
  last_timestamp: number; // мс
  unread_count: number;
  /** Есть, если в беседу можно отправлять файлы (личная с аккаунтом или группа). */
  peer_user_id?: string;
  is_group?: boolean;
  secure: boolean;
};

export type UIMessage = {
  message_id: string;
  chat_id: string;
  from: string;
  from_name?: string;
  text: string;
  timestamp: number; // мс
  direction: "incoming" | "outgoing";
  att?: MessageAttachment;
};
