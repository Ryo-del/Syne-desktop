import * as api from "../lib/api";
import { CLOUD, HUB } from "../chats/useChats";
import { filesApi, newTransferId } from "./api";
import { describeFileError } from "./errors";
import { baseName, isJunkName } from "./hidden";
import { prepareOpenDir } from "../lib/desktop";
import type { FileEntry } from "./types";

export interface ChatTarget {
  /** `hub:<собеседник>` или `cloud:<id>`. */
  chat_id: string;
}

export interface SendReport {
  sent: number;
  errors: string[];
}

/** Файлы и фото с компьютера: защищённые беседы шифрует и загружает локальный сервис. */
export async function sendLocalFiles(
  chat: ChatTarget,
  paths: string[],
  onTransfer: (id: string, label: string) => void,
  send: (chatId: string, paths: string[]) => Promise<void>,
): Promise<SendReport> {
  const report: SendReport = { sent: 0, errors: [] };
  const list = paths.filter((p) => !isJunkName(baseName(p)));
  if (list.length === 0) {
    report.errors.push("Нет файлов для отправки");
    return report;
  }
  const id = newTransferId();
  onTransfer(id, list.length === 1 ? baseName(list[0]) : `файлов: ${list.length}`);
  for (const p of list) {
    try {
      await send(chat.chat_id, [p]);
      report.sent += 1;
    } catch (err) {
      report.errors.push(`${baseName(p)}: ${describeFileError(err)}`);
    }
  }
  return report;
}

/** Файлы из облака → в беседу (Hub: скачиваем во временную папку и шифруем; обычный чат: загружаем как вложение). */
export async function sendServerFiles(
  chat: ChatTarget,
  picks: { owner: string; entry: FileEntry }[],
): Promise<SendReport> {
  const report: SendReport = { sent: 0, errors: [] };
  for (const p of picks) {
    try {
      if (p.entry.is_dir) throw new Error("Папки отправить нельзя");
      if (chat.chat_id.startsWith(HUB)) {
        const dir = await prepareOpenDir();
        const res = await filesApi.download({ owner: p.owner, path: p.entry.path, dir: false, dest_dir: dir });
        await api.hubSendFile(chat.chat_id.slice(HUB.length), res.path);
      } else if (chat.chat_id.startsWith(CLOUD)) {
        const blob = await filesApi.blob(p.owner, p.entry.path);
        await api.sendAttachment(chat.chat_id.slice(CLOUD.length), new File([blob], p.entry.name));
      }
      report.sent += 1;
    } catch (err) {
      report.errors.push(`${p.entry.name}: ${describeFileError(err)}`);
    }
  }
  return report;
}
