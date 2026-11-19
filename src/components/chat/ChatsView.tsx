import { useEffect, useMemo, useRef, useState } from "react";

import * as api from "../../lib/api";
import type { HubMessage, HubState } from "../../types";
import "./chats.css";

const errText = (e: unknown) => (e instanceof Error ? e.message : "Что-то пошло не так");
const time = (ts: number) => new Date(ts * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
const lastOf = <T,>(a: T[] | undefined): T | undefined => (a && a.length ? a[a.length - 1] : undefined);
const day = (ts: number) => new Date(ts * 1000).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });

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

interface Props {
  userId: string;
  hub: HubState;
  onState: (s: HubState) => void;
}

export default function ChatsView({ userId, hub, onState }: Props) {
  const view = hub.view!;
  const names = view.names ?? {};
  const [selected, setSelected] = useState<string>("");
  const [query, setQuery] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [read, setRead] = useState<Record<string, number>>(() => load(`syne.read.${userId}`, {}));
  const [hidden, setHidden] = useState<Record<string, number>>(() => load(`syne.hidden.${userId}`, {}));
  const [safety, setSafety] = useState<string | null>(null);
  const stream = useRef<HTMLDivElement>(null);

  const byPeer = useMemo(() => {
    const m = new Map<string, HubMessage[]>();
    for (const msg of view.messages) {
      const list = m.get(msg.peer) ?? [];
      list.push(msg);
      m.set(msg.peer, list);
    }
    for (const list of m.values()) list.sort((a, b) => a.ts - b.ts);
    return m;
  }, [view.messages]);

  const title = (peer: string) => {
    if (peer.startsWith("group:")) {
      const last = [...(byPeer.get(peer) ?? [])].reverse().find((x) => x.group_name);
      return last?.group_name ?? "Группа";
    }
    return names[peer] ?? "Собеседник"; // ID в интерфейсе не показываем
  };
  const lastTs = (peer: string) => lastOf(byPeer.get(peer))?.ts ?? 0;
  const isHidden = (peer: string) => hidden[peer] !== undefined && lastTs(peer) <= hidden[peer];
  const unread = (peer: string) =>
    isHidden(peer) ? 0 : (byPeer.get(peer) ?? []).filter((m) => !m.outgoing && m.ts > (read[peer] ?? 0)).length;

  const peers = useMemo(
    () => [...byPeer.keys()].filter((p) => !isHidden(p)).sort((a, b) => lastTs(b) - lastTs(a)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [byPeer, hidden],
  );

  const q = query.trim().toLowerCase();
  const filtered = q ? peers.filter((p) => title(p).toLowerCase().includes(q)) : peers;
  // Новые собеседники из справочника школы (те, с кем ещё нет беседы).
  const people = q
    ? Object.entries(names)
        .filter(([login, name]) => login !== view.login && name.toLowerCase().includes(q) && !peers.includes(login))
        .slice(0, 8)
    : [];

  const msgs = selected ? (byPeer.get(selected) ?? []) : [];
  const lastSeen = lastOf(msgs)?.ts ?? 0;

  useEffect(() => {
    if (!selected || !lastSeen || (read[selected] ?? 0) >= lastSeen) return;
    const next = { ...read, [selected]: lastSeen };
    setRead(next);
    save(`syne.read.${userId}`, next);
  }, [selected, lastSeen, read, userId]);

  useEffect(() => {
    stream.current?.scrollTo({ top: stream.current.scrollHeight });
  }, [selected, msgs.length]);

  const trust = hub.trust_error;

  async function send() {
    const body = text.trim();
    if (!body || !selected || sending) return;
    setSending(true);
    setError("");
    try {
      onState(await api.hubSend(selected, body));
      setText("");
    } catch (e) {
      setError(errText(e));
      void api.hubState().then(onState).catch(() => undefined);
    } finally {
      setSending(false);
    }
  }

  function hide(peer: string) {
    const next = { ...hidden, [peer]: lastTs(peer) || Math.floor(Date.now() / 1000) };
    setHidden(next);
    save(`syne.hidden.${userId}`, next);
    if (selected === peer) setSelected("");
  }

  async function showSafety() {
    if (!selected || selected.startsWith("group:")) return;
    try {
      setSafety(await api.hubSafety(selected));
    } catch (e) {
      setError(errText(e));
    }
  }

  const rosterPrompt = view.roster_key_id;

  return (
    <>
      <aside className="peers-panel">
        <div className="peers-panel-header">
          <h2>Чаты</h2>
          <span className="live-badge">защищено</span>
        </div>
        <div className="peers-panel-search">
          <input placeholder="Найти собеседника" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="peer-list">
          {filtered.map((peer) => {
            const last = lastOf(byPeer.get(peer));
            const n = unread(peer);
            return (
              <div key={peer} className="chat-list-row">
                <button
                  className={`peer-card ${peer === selected ? "active" : ""}`}
                  onClick={() => setSelected(peer)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (window.confirm("Удалить беседу из списка на этом компьютере? У собеседника она останется.")) hide(peer);
                  }}
                >
                  <div className="peer-card-avatar">{title(peer).slice(0, 1).toUpperCase()}</div>
                  <div className="peer-card-info">
                    <div className="peer-card-info-top">
                      <strong>{title(peer)}</strong>
                      {last ? <time>{time(last.ts)}</time> : null}
                    </div>
                    <div className="peer-card-info-bottom">
                      <span>{last ? `${last.outgoing ? "Вы: " : ""}${last.text}` : ""}</span>
                      {n > 0 ? <span className="unread-badge">{n}</span> : null}
                    </div>
                  </div>
                </button>
              </div>
            );
          })}
          {people.map(([login, name]) => (
            <div key={login} className="chat-list-row">
              <button
                className="peer-card"
                onClick={() => {
                  setSelected(login);
                  setQuery("");
                }}
              >
                <div className="peer-card-avatar">{name.slice(0, 1).toUpperCase()}</div>
                <div className="peer-card-info">
                  <div className="peer-card-info-top">
                    <strong>{name}</strong>
                  </div>
                  <div className="peer-card-info-bottom">
                    <span>Начать беседу</span>
                  </div>
                </div>
              </button>
            </div>
          ))}
          {!filtered.length && !people.length ? (
            <div className="fx-hint">{q ? "Никого не найдено." : "Бесед пока нет. Найдите собеседника по имени."}</div>
          ) : null}
        </div>
      </aside>

      <div className="main-chat main-chat-layout">
        {selected ? (
          <>
            <div className="chat-header">
              <div className="chat-header-left">
                <div className="chat-header-title">
                  <span className="chat-header-name">{title(selected)}</span>
                </div>
              </div>
              <div className="chat-header-right">
                {!selected.startsWith("group:") ? (
                  <button className="fx-link" onClick={showSafety}>
                    Номер безопасности
                  </button>
                ) : null}
              </div>
            </div>

            {trust && (trust.login === selected || selected.startsWith("group:")) ? (
              <div className="cx-trust">
                <strong>{trust.kind === "reset" ? "У собеседника сменилась идентичность." : "Реестр устройств собеседника изменился."}</strong>{" "}
                Сверьте номер безопасности с ним лично или по другому каналу: {trust.safety_number}
                <div>
                  <button
                    className="fx-btn"
                    onClick={async () => {
                      try {
                        onState(await api.hubAcceptPeer(trust.login));
                      } catch (e) {
                        setError(errText(e));
                      }
                    }}
                  >
                    Номер совпал — продолжить
                  </button>
                </div>
              </div>
            ) : null}

            <div ref={stream} className="message-stream">
              {msgs.map((m, i) => (
                <div key={m.id}>
                  {i === 0 || day(m.ts) !== day(msgs[i - 1].ts) ? (
                    <div className="session-separator">
                      <span>{day(m.ts)}</span>
                    </div>
                  ) : null}
                  <div className={`msg-row ${m.outgoing ? "outgoing" : "incoming"}`}>
                    <div className={`msg-content ${m.outgoing ? "outgoing" : "incoming"}`}>
                      {selected.startsWith("group:") && !m.outgoing ? (
                        <div className="msg-sender">{names[m.from] ?? "Участник"}</div>
                      ) : null}
                      <div className={`msg-bubble ${m.outgoing ? "outgoing" : "incoming"}`}>
                        <p className="msg-text">{m.text}</p>
                        <div className="msg-meta">
                          <span className="msg-time">{time(m.ts)}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
              {!msgs.length ? (
                <div className="empty-state">
                  <div>
                    <h3>Новая защищённая беседа</h3>
                    <p>Сообщения шифруются на устройствах собеседника.</p>
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
                <button className="send-btn" onClick={() => void send()} disabled={sending} title="Отправить">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 2 11 13" />
                    <path d="M22 2 15 22l-4-9-9-4 20-7z" />
                  </svg>
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="empty-state">
            <div>
              <h3>Выберите беседу</h3>
              <p>Или найдите человека по имени слева.</p>
            </div>
          </div>
        )}
      </div>

      {safety !== null ? (
        <div className="fx-modal-backdrop" onMouseDown={() => setSafety(null)}>
          <div className="fx-modal fx-modal-small" onMouseDown={(e) => e.stopPropagation()}>
            <div className="fx-modal-title">Номер безопасности</div>
            <div className="fx-modal-text">Сверьте его с собеседником. Если номера совпадают, переписку никто не подменил.</div>
            <div className="cx-safety">{safety}</div>
            <div className="fx-modal-actions">
              <button className="fx-btn" onClick={() => setSafety(null)}>
                Закрыть
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {rosterPrompt ? (
        <div className="fx-modal-backdrop">
          <div className="fx-modal fx-modal-small">
            <div className="fx-modal-title">Сверьте ключ сервера колледжа</div>
            <div className="fx-modal-text">
              Отпечаток должен совпасть с тем, что показывает Syne Study на доверенном устройстве («Устройства и безопасность»). Без этого
              составам групп верить нельзя.
            </div>
            <div className="cx-safety">{rosterPrompt.match(/.{1,4}/g)?.join(" ")}</div>
            <div className="fx-modal-actions">
              <button className="fx-btn" onClick={async () => onState(await api.hubRoster(false))}>
                Не совпадает
              </button>
              <button className="fx-btn dk-primary" onClick={async () => onState(await api.hubRoster(true))}>
                Совпадает
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

export function totalUnread(userId: string, messages: HubMessage[]): number {
  const read = load<Record<string, number>>(`syne.read.${userId}`, {});
  const hidden = load<Record<string, number>>(`syne.hidden.${userId}`, {});
  const last = new Map<string, number>();
  for (const m of messages) last.set(m.peer, Math.max(last.get(m.peer) ?? 0, m.ts));
  return messages.filter((m) => {
    if (m.outgoing || m.ts <= (read[m.peer] ?? 0)) return false;
    const h = hidden[m.peer];
    return h === undefined || (last.get(m.peer) ?? 0) > h;
  }).length;
}
