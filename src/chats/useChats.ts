import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import * as api from "../lib/api";
import type { ChatSummary, CloudChat, CloudMessage, HubMessage, HubState, UIMessage } from "../types";
import { setChatList } from "./store";

export const HUB = "hub:";
export const CLOUD = "cloud:";

const errText = (e: unknown) => (e instanceof Error ? e.message : "Что-то пошло не так");

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* хранилище недоступно */
  }
}

const iso = (s: string) => Date.parse(s) || 0;

interface Options {
  userId: string;
  hub: HubState | null;
  applyHub: (s: HubState) => void;
  /** Растёт при каждом событии облака (новые сообщения, изменения). */
  tick: number;
  selectedId: string;
  onIncoming: (title: string, body: string) => void;
  onError: (message: string) => void;
}

/**
 * Единый список бесед: защищённые (Key Hub) и обычные облачные чаты.
 * Сообщения Hub приходят целиком в состоянии сервиса; облачные подгружаются для открытого чата.
 */
export function useChats({ userId, hub, applyHub, tick, selectedId, onIncoming, onError }: Options) {
  const hubView = hub?.view && hub.view.state === "ready" ? hub.view : null;
  const names = hubView?.names ?? {};
  const accounts = hubView?.accounts ?? {};
  const selfLogin = hubView?.login ?? "";
  const cloudPeople = useMemo(() => new Set(Object.values(accounts)), [accounts]);

  const readKey = `syne-desktop.read.${userId}`;
  const hiddenKey = `syne-desktop.hidden.${userId}`;
  const [read, setRead] = useState<Record<string, number>>(() => load(readKey, {}));
  const [hidden, setHidden] = useState<Record<string, number>>(() => load(hiddenKey, {}));
  const blockedKey = `syne-desktop.blocked.${userId}`;
  const [blocked, setBlocked] = useState<Record<string, string>>(() => load(blockedKey, {}));
  const [drafts, setDrafts] = useState<Record<string, string>>({}); // chat_id → заголовок
  const [cloudChats, setCloudChats] = useState<CloudChat[]>([]);
  const [cloudMessages, setCloudMessages] = useState<Record<string, CloudMessage[]>>({});

  const refreshCloud = useCallback(() => api.listChats().then(setCloudChats).catch(() => undefined), []);
  useEffect(() => {
    void refreshCloud();
  }, [tick, refreshCloud]);

  // Сообщения открытого облачного чата.
  const selectedCloudId = selectedId.startsWith(CLOUD) ? selectedId.slice(CLOUD.length) : "";
  useEffect(() => {
    if (!selectedCloudId) return;
    let off = false;
    api
      .listMessages(selectedCloudId)
      .then((list) => {
        if (!off) setCloudMessages((cur) => ({ ...cur, [selectedCloudId]: list }));
      })
      .catch((e) => onError(errText(e)));
    return () => {
      off = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCloudId, tick]);

  // ── защищённые беседы ──
  const hubByPeer = useMemo(() => {
    const m = new Map<string, HubMessage[]>();
    for (const msg of hubView?.messages ?? []) {
      const list = m.get(msg.peer) ?? [];
      list.push(msg);
      m.set(msg.peer, list);
    }
    for (const list of m.values()) list.sort((a, b) => a.ts - b.ts);
    return m;
  }, [hubView?.messages]);

  const hubTitle = useCallback(
    (peer: string) => {
      if (peer.startsWith("group:")) {
        const last = [...(hubByPeer.get(peer) ?? [])].reverse().find((x) => x.group_name);
        return last?.group_name ?? "Группа";
      }
      return names[peer] ?? "Собеседник"; // ID в интерфейсе не показываем
    },
    [hubByPeer, names],
  );

  const toUi = useCallback(
    (m: HubMessage): UIMessage => {
      const chat_id = HUB + m.peer;
      return {
        message_id: m.id,
        chat_id,
        from: m.from,
        from_name: names[m.from] ?? "Участник",
        text: m.text,
        timestamp: m.ts * 1000,
        direction: m.outgoing ? "outgoing" : "incoming",
        att: m.att
          ? { source: "hub", id: m.id, chat_id, kind: m.att.kind, name: m.att.name, size: m.att.size, thumb: m.att.thumb }
          : undefined,
      };
    },
    [names],
  );

  const cloudTitle = useCallback(
    (c: CloudChat) => (c.is_group ? c.title || "Группа" : (c.members.find((m) => m.id !== userId)?.name ?? "Чат")),
    [userId],
  );

  const cloudToUi = useCallback(
    (chat: CloudChat, m: CloudMessage): UIMessage => {
      const chat_id = CLOUD + chat.id;
      return {
        message_id: `c${m.id}`,
        chat_id,
        from: m.author_id,
        from_name: chat.members.find((x) => x.id === m.author_id)?.name ?? "Участник",
        text: m.body,
        timestamp: iso(m.created_at),
        direction: m.author_id === userId ? "outgoing" : "incoming",
        att: m.attachment
          ? { source: "cloud", id: String(m.id), chat_id, kind: "file", name: m.attachment.name, size: m.attachment.size }
          : undefined,
      };
    },
    [userId],
  );

  const messages = useMemo(() => {
    const out: Record<string, UIMessage[]> = {};
    for (const [peer, list] of hubByPeer) out[HUB + peer] = list.map(toUi);
    for (const chat of cloudChats) {
      const list = cloudMessages[chat.id];
      if (list) out[CLOUD + chat.id] = [...list].sort((a, b) => a.id - b.id).map((m) => cloudToUi(chat, m));
    }
    return out;
  }, [hubByPeer, toUi, cloudChats, cloudMessages, cloudToUi]);

  const previewOf = (m: UIMessage | undefined) =>
    m ? `${m.direction === "outgoing" ? "Вы: " : ""}${m.att ? (m.att.kind === "photo" ? "📷 Фото" : `📎 ${m.att.name}`) : m.text}` : "";

  const chats = useMemo<ChatSummary[]>(() => {
    const out: ChatSummary[] = [];
    for (const [peer, list] of hubByPeer) {
      if (peer === selfLogin || blocked[peer] !== undefined) continue;
      const id = HUB + peer;
      const last = list[list.length - 1];
      const ts = last ? last.ts * 1000 : 0;
      const isHidden = hidden[id] !== undefined && ts <= hidden[id];
      if (isHidden) continue;
      const readTs = read[id] ?? 0;
      out.push({
        chat_id: id,
        peer_id: id,
        title: hubTitle(peer),
        preview: previewOf(last ? toUi(last) : undefined),
        last_timestamp: ts,
        unread_count: list.filter((m) => !m.outgoing && m.ts * 1000 > readTs).length,
        peer_user_id: peer.startsWith("group:") ? undefined : peer,
        is_group: peer.startsWith("group:"),
        secure: true,
        no_cloud: !peer.startsWith("group:") && !cloudPeople.has(peer),
        block_key: peer.startsWith("group:") ? undefined : peer,
      });
    }
    for (const c of cloudChats) {
      // Беседа с человеком, у которого есть Key Hub, всегда идёт через Hub.
      if (!c.is_group && c.members.some((m) => m.id !== userId && accounts[m.id])) continue;
      const other0 = c.members.find((m) => m.id !== userId);
      if (!c.is_group && (!other0 || blocked[other0.id] !== undefined)) continue; // чат с самим собой и заблокированные
      const id = CLOUD + c.id;
      const ts = iso(c.last_message?.created_at ?? c.created_at);
      if (hidden[id] !== undefined && ts <= hidden[id]) continue;
      const last = c.last_message;
      const fromOther = !!last && last.author_id !== userId;
      const other = c.members.find((m) => m.id !== userId);
      out.push({
        chat_id: id,
        peer_id: id,
        title: cloudTitle(c),
        preview: last
          ? `${last.author_id === userId ? "Вы: " : ""}${last.attachment ? `📎 ${last.attachment.name}` : last.body}`
          : "",
        last_timestamp: ts,
        unread_count: fromOther && ts > (read[id] ?? 0) ? 1 : 0,
        peer_user_id: c.is_group ? undefined : other?.id,
        is_group: c.is_group,
        secure: false,
        block_key: c.is_group ? undefined : other?.id,
      });
    }
    for (const [id, title] of Object.entries(drafts)) {
      if (!out.some((c) => c.chat_id === id)) {
        out.push({
          chat_id: id,
          peer_id: id,
          title,
          preview: "",
          last_timestamp: 0,
          unread_count: 0,
          peer_user_id: id.startsWith(HUB) ? id.slice(HUB.length) : undefined,
          secure: id.startsWith(HUB),
          no_cloud: id.startsWith(HUB) && !cloudPeople.has(id.slice(HUB.length)),
          block_key: id.startsWith(HUB) ? id.slice(HUB.length) : undefined,
        });
      }
    }
    // Выбранная беседа не исчезает из списка и без сообщений.
    return out
      .map((c) => (c.chat_id === selectedId ? { ...c, unread_count: 0 } : c))
      .sort((a, b) => b.last_timestamp - a.last_timestamp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hubByPeer, cloudChats, hidden, read, drafts, selectedId, hubTitle, cloudTitle, accounts, userId, blocked, selfLogin, cloudPeople]);

  useEffect(() => setChatList(chats), [chats]);

  // Открытая беседа считается прочитанной.
  const lastSeen = (messages[selectedId] ?? []).reduce((a, m) => Math.max(a, m.timestamp), 0);
  const cloudLast = cloudChats.find((c) => CLOUD + c.id === selectedId)?.last_message?.created_at;
  const selectedTs = Math.max(lastSeen, cloudLast ? iso(cloudLast) : 0);
  useEffect(() => {
    if (!selectedId || !selectedTs || (read[selectedId] ?? 0) >= selectedTs) return;
    const next = { ...read, [selectedId]: selectedTs };
    setRead(next);
    save(readKey, next);
  }, [selectedId, selectedTs, read, readKey]);

  // Уведомления о новых входящих (после первой загрузки).
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!hubView) return;
    const ids = new Set(hubView.messages.map((m) => m.id));
    if (seen.current === null) {
      seen.current = ids;
      return;
    }
    for (const m of hubView.messages) {
      if (seen.current.has(m.id)) continue;
      if (!m.outgoing && blocked[m.peer] === undefined && blocked[m.from] === undefined) {
        const ui = toUi(m);
        onIncoming(hubTitle(m.peer), previewOf(ui).replace(/^Вы: /, ""));
      }
    }
    seen.current = ids;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hubView?.messages]);

  // ── действия ──
  const withHub = async (fn: () => Promise<HubState>) => {
    try {
      applyHub(await fn());
    } catch (e) {
      void api.hubState().then(applyHub).catch(() => undefined);
      throw e;
    }
  };

  const send = useCallback(
    async (chatId: string, text: string) => {
      if (chatId.startsWith(HUB)) {
        await withHub(() => api.hubSend(chatId.slice(HUB.length), text));
      } else {
        await api.sendMessage(chatId.slice(CLOUD.length), text);
        const id = chatId.slice(CLOUD.length);
        setCloudMessages((cur) => ({ ...cur }));
        await api.listMessages(id).then((list) => setCloudMessages((cur) => ({ ...cur, [id]: list })));
        void refreshCloud();
      }
      setDrafts((d) => {
        if (!(chatId in d)) return d;
        const { [chatId]: _gone, ...rest } = d;
        return rest;
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [applyHub, refreshCloud],
  );

  /** Отправка файлов с пути на диске (только защищённые беседы: шифрует локальный сервис). */
  const sendPaths = useCallback(
    async (chatId: string, paths: string[]) => {
      if (!chatId.startsWith(HUB)) throw new Error("В обычный облачный чат файлы отправляются через «Файл с компьютера».");
      for (const p of paths) await withHub(() => api.hubSendFile(chatId.slice(HUB.length), p));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [applyHub],
  );

  /** Отправка файла из браузерного File (обычный облачный чат). */
  const sendBlob = useCallback(
    async (chatId: string, file: File) => {
      const id = chatId.slice(CLOUD.length);
      await api.sendAttachment(id, file);
      await api.listMessages(id).then((list) => setCloudMessages((cur) => ({ ...cur, [id]: list })));
      void refreshCloud();
    },
    [refreshCloud],
  );

  const hide = useCallback(
    (chatId: string) => {
      const last = chats.find((c) => c.chat_id === chatId)?.last_timestamp || Date.now();
      const next = { ...hidden, [chatId]: last };
      setHidden(next);
      save(hiddenKey, next);
      setDrafts((d) => {
        const { [chatId]: _gone, ...rest } = d;
        return rest;
      });
    },
    [chats, hidden, hiddenKey],
  );

  /** Открывает беседу с человеком: Key Hub, если у него есть Hub, иначе обычный облачный чат. */
  const openWith = useCallback(
    async (user: { id?: string; login: string; name: string }): Promise<string> => {
      if ((user.id && user.id === userId) || (selfLogin && user.login === selfLogin)) {
        throw new Error("Нельзя написать самому себе.");
      }
      const hubPeer = (user.id && accounts[user.id]) || (names[user.login] ? user.login : "");
      if (blocked[hubPeer] !== undefined || (user.id && blocked[user.id] !== undefined) || blocked[user.login] !== undefined) {
        throw new Error("Пользователь заблокирован. Разблокируйте его в поиске.");
      }
      if (hubPeer) {
        const id = HUB + hubPeer;
        setHidden((h) => {
          if (h[id] === undefined) return h;
          const { [id]: _gone, ...rest } = h;
          save(hiddenKey, rest);
          return rest;
        });
        setDrafts((d) => ({ ...d, [id]: names[hubPeer] ?? user.name }));
        return id;
      }
      if (!user.id) throw new Error("Пользователь не найден.");
      const chat = await api.openChat(user.id);
      await refreshCloud();
      const id = CLOUD + chat.id;
      setHidden((h) => {
        if (h[id] === undefined) return h;
        const { [id]: _gone, ...rest } = h;
        save(hiddenKey, rest);
        return rest;
      });
      return id;
    },
    [accounts, names, refreshCloud, hiddenKey, blocked, selfLogin, userId],
  );

  const block = useCallback(
    (key: string, name: string) => {
      setBlocked((cur) => {
        const next = { ...cur, [key]: name };
        save(blockedKey, next);
        return next;
      });
    },
    [blockedKey],
  );

  const unblock = useCallback(
    (key: string) => {
      setBlocked((cur) => {
        const { [key]: _gone, ...rest } = cur;
        save(blockedKey, rest);
        return rest;
      });
    },
    [blockedKey],
  );

  return { chats, messages, send, sendPaths, sendBlob, hide, openWith, names, blocked, block, unblock };
}
