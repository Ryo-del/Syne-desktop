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

export type View = "files" | "profile" | "settings";
