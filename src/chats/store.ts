import type { ChatSummary } from "../types";

/** Текущий список бесед: нужен окнам «Отправить файл в чат», живущим вне App. */
let current: ChatSummary[] = [];

export function setChatList(chats: ChatSummary[]) {
  current = chats;
}

export function getChatList(): ChatSummary[] {
  return current;
}
