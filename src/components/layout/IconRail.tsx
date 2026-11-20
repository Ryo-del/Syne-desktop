import EmojiPicker from "../common/EmojiPicker";

import type { SidebarView } from "../../config/settings";
import { FilesIcon } from "../files/FilesIcon";

interface IconRailProps {
  sidebarView: SidebarView;
  showSettings: boolean;

  emojiPickerTarget:
    | "self"
    | "peer"
    | null;

  selfEmoji: string;

  onEmojiTargetChange: (
    target: "self" | "peer" | null,
  ) => void;

  onSelfEmojiChange: (
    emoji: string,
  ) => void;

  onSidebarViewChange: (
    view: SidebarView,
  ) => void;

  onSettings: () => void;
  onLogout: () => void;

}

export default function IconRail({
  sidebarView,
  showSettings,
  emojiPickerTarget,
  selfEmoji,
  onEmojiTargetChange,
  onSelfEmojiChange,
  onSidebarViewChange,
  onSettings,
  onLogout,
}: IconRailProps) {
  return (
    <nav className="icon-rail">
      <div className="emoji-anchor">
        <button
          type="button"
          className="icon-rail-avatar"
          onClick={() =>
            onEmojiTargetChange(
              emojiPickerTarget === "self"
                ? null
                : "self",
            )
          }
          title="Ваш аватар"
        >
          {selfEmoji}
        </button>

        {emojiPickerTarget === "self" ? (
          <EmojiPicker
            onSelect={onSelfEmojiChange}
          />
        ) : null}
      </div>

      <button
        type="button"
        className={`icon-rail-btn ${
          sidebarView === "chats"
            ? "active"
            : ""
        }`}
        title="Чаты"
        onClick={() =>
          onSidebarViewChange("chats")
        }
      >
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z" />
        </svg>
      </button>

      <button
        type="button"
        className={`icon-rail-btn ${sidebarView === "search" ? "active" : ""}`}
        title="Поиск пользователей"
        aria-label="Поиск пользователей"
        onClick={() => onSidebarViewChange("search")}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.3-4.3" />
        </svg>
      </button>

              <button
        type="button"
        className={`icon-rail-btn ${sidebarView === "files" ? "active" : ""}`}
        title="Файлы"
        aria-label="Файлы"
        onClick={() => onSidebarViewChange("files")}
      >
        <FilesIcon size={22} />
      </button>
      <div className="icon-rail-spacer" />
        <button
        type="button"
        className="icon-rail-btn danger"
        title="Выйти"
        aria-label="Выйти"
        onClick={onLogout}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m16 17 5-5-5-5" />
          <path d="M21 12H9" />
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
        </svg>
      </button>
      <button
        type="button"
        className={`icon-rail-btn ${
          showSettings
            ? "active"
            : ""
        }`}
        title="Настройки"
        onClick={onSettings}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="lucide lucide-settings-icon lucide-settings"
        >
          <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
          <circle
            cx="12"
            cy="12"
            r="3"
          />
        </svg>
      </button>
    </nav>
  );
}