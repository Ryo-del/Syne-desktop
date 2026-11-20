import type { ChatSummary, UIMessage } from "../../types";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { baseName } from "../../files/hidden";
import { sendLocalFiles, sendServerFiles, type ChatTarget } from "../../files/sendAttachment";
import { useTransfers } from "../../files/useTransfers";
import { onNativeFileDrop, pickLocalFiles } from "../../lib/desktop";
import FilesPickerDialog, { type PickedFile } from "../files/FilesPickerDialog";
import Attachment from "./Attachment";
import AttachMenu from "./AttachMenu";
import { formatDate, formatTime } from "../../lib/format";

interface ChatAreaProps {
  selectedChat: ChatSummary | null;
  selectedMessages: UIMessage[];

  composer: string;
  messageStreamRef: React.RefObject<HTMLDivElement>;

  /** Предупреждение о смене идентичности и т. п. над перепиской. */
  banner?: ReactNode;
  /** Кнопка справа в шапке (например, «Номер безопасности»). */
  headerAction?: ReactNode;

  onComposerChange: (value: string) => void;
  onSend: () => void;
  /** Файлы с диска в защищённую беседу. */
  onSendPaths: (chatId: string, paths: string[]) => Promise<void>;
  /** Файл в обычный облачный чат. */
  onSendFile: (chatId: string, file: File) => Promise<void>;
  onNotify: (msg: string, kind?: "info" | "error") => void;
}

export default function ChatArea({
  selectedChat,
  selectedMessages,
  composer,
  messageStreamRef,
  banner,
  headerAction,
  onComposerChange,
  onSend,
  onSendPaths,
  onSendFile,
  onNotify,
}: ChatAreaProps) {
  const firstMsgDate =
    selectedMessages.length > 0 ? formatDate(selectedMessages[0].timestamp) : "";
  const [picker, setPicker] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [pendingDrop, setPendingDrop] = useState<string[] | null>(null);
  const [uploads, setUploads] = useState<{ id: string; label: string }[]>([]);
  const transfers = useTransfers();
  const rootRef = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [inputAccept, setInputAccept] = useState("");
  const chatRef = useRef(selectedChat);
  chatRef.current = selectedChat;

  const isHub = !!selectedChat && selectedChat.chat_id.startsWith("hub:");
  const canAttach = !!selectedChat && (isHub || selectedChat.chat_id.startsWith("cloud:"));

  function target(): ChatTarget | null {
    const c = chatRef.current;
    return c ? { chat_id: c.chat_id } : null;
  }

  async function sendLocal(paths: string[]) {
    const t = target();
    if (!t || paths.length === 0) return;
    let tid = "";
    const report = await sendLocalFiles(
      t,
      paths,
      (id, label) => {
        tid = id;
        setUploads((c) => [...c, { id, label }]);
      },
      onSendPaths,
    );
    if (tid) setUploads((c) => c.filter((u) => u.id !== tid));
    if (report.errors.length > 0) onNotify(`Не отправлено: ${report.errors.join("; ")}`);
  }

  async function sendFromFiles(items: PickedFile[]) {
    const t = target();
    if (!t) return;
    const report = await sendServerFiles(t, items);
    if (report.errors.length > 0) onNotify(`Не отправлено: ${report.errors.join("; ")}`);
  }

  async function pickAndSend(kind: "photo" | "file") {
    try {
      if (isHub) {
        await sendLocal(await pickLocalFiles(kind));
      } else {
        setInputAccept(kind === "photo" ? "image/*" : "");
        window.setTimeout(() => fileInput.current?.click(), 0);
      }
    } catch (err) {
      onNotify(err instanceof Error ? err.message : "Не удалось выбрать файлы");
    }
  }

  async function sendBrowserFile(file: File | undefined) {
    const c = chatRef.current;
    if (!file || !c) return;
    try {
      await onSendFile(c.chat_id, file);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : "Не удалось отправить файл");
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  // Файлы с рабочего стола, брошенные на чат (только защищённые беседы).
  useEffect(() => {
    let off: (() => void) | null = null;
    let dead = false;
    void onNativeFileDrop((e) => {
      const el = rootRef.current;
      if (!el) return;
      if (e.phase === "leave") {
        setDropActive(false);
        return;
      }
      const r = el.getBoundingClientRect();
      const inside = e.x >= r.left && e.x <= r.right && e.y >= r.top && e.y <= r.bottom;
      const c = chatRef.current;
      const ok = inside && !!c && c.chat_id.startsWith("hub:");
      if (e.phase === "drop") {
        setDropActive(false);
        if (ok) setPendingDrop(e.paths);
        return;
      }
      setDropActive(ok);
    }).then((u) => {
      if (dead) u();
      else off = u;
    });
    return () => {
      dead = true;
      off?.();
    };
  }, []);

  return (
    <div ref={rootRef} className={`main-chat main-chat-layout${dropActive ? " drop-active" : ""}`}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div className="chat-header">
          <div className="chat-header-left">
            <div className="chat-header-title">
              {selectedChat ? (
                <span className="chat-header-name">{selectedChat.title}</span>
              ) : (
                <h2>Select a chat</h2>
              )}
            </div>
          </div>

          <div className="chat-header-right">{selectedChat ? headerAction : null}</div>
        </div>

        {banner}

        <section style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {selectedChat ? (
            <>
              <div ref={messageStreamRef} className="message-stream">
                {firstMsgDate && (
                  <div className="session-separator">
                    <span>{firstMsgDate}</span>
                  </div>
                )}

                {selectedMessages.map((message) => (
                  <div key={message.message_id} className={`msg-row ${message.direction}`}>
                    <div className={`msg-content ${message.direction}`}>
                      {selectedChat.is_group && message.direction === "incoming" && (
                        <div className="msg-sender">{message.from_name || message.from}</div>
                      )}
                      <div
                        className={`msg-bubble ${message.direction}${message.att ? " has-attachment" : ""}${message.att?.kind === "photo" ? " media" : ""}`}
                      >
                        {message.att ? (
                          <Attachment att={message.att} outgoing={message.direction === "outgoing"} onNotify={onNotify} />
                        ) : null}
                        {message.text ? <p className="msg-text">{message.text}</p> : null}

                        <div className="msg-meta">
                          <span className="msg-time">{formatTime(message.timestamp)}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}

                {!selectedMessages.length ? (
                  <div className="empty-state">
                    <div>
                      <h3>Chat is open</h3>
                      <p>
                        {selectedChat.secure
                          ? "Сообщения шифруются на устройствах собеседника. Отправьте первое сообщение."
                          : "Обычный чат: сообщения видны серверу, у собеседника нет Key Hub."}
                      </p>
                    </div>
                  </div>
                ) : null}
              </div>

              {uploads.map((u) => {
                const t = transfers.find((x) => x.id === u.id);
                const pct = t && t.total > 0 ? Math.round((t.done / t.total) * 100) : null;
                return (
                  <div key={u.id} className="upload-strip">
                    Отправка: {u.label}
                    {pct !== null ? ` · ${pct}%` : "…"}
                  </div>
                );
              })}

              <div className="composer">
                <div className="composer-input-row">
                  <input
                    ref={fileInput}
                    type="file"
                    hidden
                    accept={inputAccept}
                    onChange={(e) => void sendBrowserFile(e.target.files?.[0])}
                  />
                  <AttachMenu
                    disabled={!canAttach}
                    onPickPhoto={() => void pickAndSend("photo")}
                    onPickFile={() => void pickAndSend("file")}
                    onPickFromFiles={() => setPicker(true)}
                  />

                  <textarea
                    placeholder="Type a message or drop a file..."
                    value={composer}
                    onChange={(e) => onComposerChange(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        onSend();
                      }
                    }}
                  />

                  <button className="send-btn" onClick={onSend} title="Send">
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
                <h3>No active conversation</h3>
                <p>Выберите чат слева или найдите человека через поиск.</p>
              </div>
            </div>
          )}
        </section>
      </div>

      {picker && selectedChat ? (
        <FilesPickerDialog
          onCancel={() => setPicker(false)}
          onPick={(items) => {
            setPicker(false);
            void sendFromFiles(items);
          }}
        />
      ) : null}

      {pendingDrop ? (
        <div className="fx-modal-backdrop">
          <div className="fx-modal fx-modal-small" role="dialog" aria-modal="true">
            <h3 className="fx-modal-title">Отправить в чат «{selectedChat?.title}»?</h3>
            <p className="fx-modal-text">
              {pendingDrop.slice(0, 5).map(baseName).join(", ")}
              {pendingDrop.length > 5 ? ` и ещё ${pendingDrop.length - 5}` : ""}
            </p>
            <div className="fx-modal-actions">
              <button type="button" className="fx-btn" onClick={() => setPendingDrop(null)}>
                Отмена
              </button>
              <button
                type="button"
                className="fx-btn primary"
                onClick={() => {
                  const paths = pendingDrop;
                  setPendingDrop(null);
                  void sendLocal(paths);
                }}
              >
                Отправить
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
