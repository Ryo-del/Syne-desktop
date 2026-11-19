import { useCallback, useEffect, useRef, useState } from "react";

import * as api from "../../lib/api";
import { formatBytes } from "../../lib/format";
import type { CloudChat, CloudMessage } from "../../types";

const errText = (e: unknown) => (e instanceof Error ? e.message : "Что-то пошло не так");
const time = (iso: string) => new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
const day = (iso: string) => new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });

/** Обычный облачный чат: текст и файлы без сквозного шифрования (сервер их видит). */
export default function CloudConversation({ chat, meId, tick, onActivity }: { chat: CloudChat; meId: string; tick: number; onActivity: () => void }) {
  const [messages, setMessages] = useState<CloudMessage[]>([]);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const stream = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const lastId = useRef(0);

  const load = useCallback(async () => {
    try {
      const fresh = await api.listMessages(chat.id, lastId.current || undefined);
      if (!fresh.length) return;
      lastId.current = Math.max(lastId.current, ...fresh.map((m) => m.id));
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        return [...prev, ...fresh.filter((m) => !seen.has(m.id))].sort((a, b) => a.id - b.id);
      });
    } catch (e) {
      setError(errText(e));
    }
  }, [chat.id]);

  useEffect(() => {
    lastId.current = 0;
    setMessages([]);
    setError("");
    void load();
  }, [chat.id, load]);

  useEffect(() => {
    void load();
  }, [tick, load]);

  useEffect(() => {
    stream.current?.scrollTo({ top: stream.current.scrollHeight });
  }, [messages.length]);

  const nameOf = (id: string) => chat.members.find((m) => m.id === id)?.name ?? "Участник";

  async function send() {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await api.sendMessage(chat.id, body);
      setText("");
      await load();
      onActivity();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function attach(f: File | undefined) {
    if (!f || busy) return;
    setBusy(true);
    try {
      await api.sendAttachment(chat.id, f);
      await load();
      onActivity();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
      if (file.current) file.current.value = "";
    }
  }

  async function open(m: CloudMessage) {
    try {
      const blob = await api.chatAttachment(chat.id, m.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = m.attachment?.name ?? "file";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      setError(errText(e));
    }
  }

  return (
    <>
      <div ref={stream} className="message-stream">
        {messages.map((m, i) => {
          const out = m.author_id === meId;
          const dir = out ? "outgoing" : "incoming";
          return (
            <div key={m.id}>
              {i === 0 || day(m.created_at) !== day(messages[i - 1].created_at) ? (
                <div className="session-separator">
                  <span>{day(m.created_at)}</span>
                </div>
              ) : null}
              <div className={`msg-row ${dir}`}>
                <div className={`msg-content ${dir}`}>
                  {chat.is_group && !out ? <div className="msg-sender">{nameOf(m.author_id)}</div> : null}
                  <div className={`msg-bubble ${dir}`}>
                    {m.attachment ? (
                      <button className="cx-file" onClick={() => void open(m)}>
                        <strong>{m.attachment.name}</strong>
                        <small>{formatBytes(m.attachment.size)} · скачать</small>
                      </button>
                    ) : null}
                    {m.body ? <p className="msg-text">{m.body}</p> : null}
                    <div className="msg-meta">
                      <span className="msg-time">{time(m.created_at)}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
        {!messages.length ? (
          <div className="empty-state">
            <div>
              <h3>Обычный чат</h3>
              <p>У собеседника нет Key Hub, поэтому сообщения не защищены сквозным шифрованием и видны серверу.</p>
            </div>
          </div>
        ) : null}
      </div>
      {error ? (
        <div className="fx-notice" onClick={() => setError("")}>
          {error}
        </div>
      ) : null}
      <div className="composer">
        <div className="composer-input-row">
          <input ref={file} type="file" hidden onChange={(e) => void attach(e.target.files?.[0])} />
          <button className="fx-icon-btn" title="Прикрепить файл" onClick={() => file.current?.click()} disabled={busy}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          <textarea
            placeholder="Сообщение"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button className="send-btn" onClick={() => void send()} disabled={busy} title="Отправить">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 2 11 13" />
              <path d="M22 2 15 22l-4-9-9-4 20-7z" />
            </svg>
          </button>
        </div>
      </div>
    </>
  );
}
