interface ChatContextMenuState {
  chatId: string;
  x: number;
  y: number;
}

interface ContextMenusProps {
  chatContextMenu: ChatContextMenuState | null;
  onHideChat: (chatId: string) => void;
  /** Есть, если собеседника можно заблокировать (не группа). */
  onBlockChat?: ((chatId: string) => void) | null;
}

export default function ContextMenus({ chatContextMenu, onHideChat, onBlockChat }: ContextMenusProps) {
  return (
    <>
      {chatContextMenu ? (
        <div
          className="chat-context-menu"
          style={{
            top: Math.max(16, chatContextMenu.y),
            left: Math.max(16, chatContextMenu.x),
          }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="chat-context-menu-item danger"
            onClick={() => onHideChat(chatContextMenu.chatId)}
          >
            Удалить чат 🗑️
          </button>
          {onBlockChat ? (
            <button
              type="button"
              className="chat-context-menu-item danger"
              onClick={() => onBlockChat(chatContextMenu.chatId)}
            >
              Заблокировать 🚫
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
