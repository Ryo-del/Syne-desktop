import type { ChatSummary } from "../../types";
import { formatTime } from "../../lib/format";

interface PeersPanelProps {
  query: string;
  onQueryChange: (value: string) => void;
  chats: ChatSummary[];
  selectedChatId: string;
  onSelectChat: (chatId: string) => void;
  onChatContextMenu: (event: React.MouseEvent, chatId: string) => void;
  getPeerAvatar: (chat: ChatSummary) => string;
}

export default function PeersPanel({
  query,
  onQueryChange,
  chats,
  selectedChatId,
  onSelectChat,
  onChatContextMenu,
  getPeerAvatar,
}: PeersPanelProps) {
  return (
    <aside className="peers-panel">
      <div className="peers-panel-header">
        <h2>Chats</h2>
        <span className="live-badge">{chats.length}</span>
      </div>

      <div className="peers-panel-search">
        <input
          placeholder="Search chats..."
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
        />
      </div>

      <div className="peer-list">
        {chats.map((chat) => (
          <div key={chat.chat_id} className="chat-list-row">
            <button
              className={`peer-card ${chat.chat_id === selectedChatId ? "active" : ""}`}
              onContextMenu={(event) => onChatContextMenu(event, chat.chat_id)}
              onClick={() => onSelectChat(chat.chat_id)}
            >
              <div className="peer-card-avatar">{getPeerAvatar(chat)}</div>

              <div className="peer-card-info">
                <div className="peer-card-info-top">
                  <strong>{chat.title}</strong>
                  <time>{formatTime(chat.last_timestamp)}</time>
                </div>

                <div className="peer-card-info-bottom">
                  <span>{chat.preview || (chat.secure ? "Защищённая беседа" : "Обычный чат")}</span>
                  {chat.unread_count > 0 ? <span className="unread-badge">{chat.unread_count}</span> : null}
                </div>
              </div>
            </button>
          </div>
        ))}

        {!chats.length ? <div className="empty-state compact">No chats yet.</div> : null}
      </div>
    </aside>
  );
}
