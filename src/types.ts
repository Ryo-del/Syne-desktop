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

export type View = "chats" | "files" | "profile" | "settings";

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
