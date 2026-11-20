import { useMemo } from "react";
import { getSessionLogin } from "../lib/session";
import type { Me } from "./perm";

/** Текущий пользователь. Чужих папок в облаке нет, права «преподавателя» не нужны. */
export function useMe(): Me {
  const login = getSessionLogin();
  return useMemo(() => ({ login, teacher: false }), [login]);
}
