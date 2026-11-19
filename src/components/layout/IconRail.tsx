import { FilesIcon } from "../files/FilesIcon";
import type { View } from "../../types";

interface Props {
  view: View;
  initial: string;
  onView: (v: View) => void;
  onLogout: () => void;
}

const stroke = {
  xmlns: "http://www.w3.org/2000/svg",
  width: 24,
  height: 24,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export default function IconRail({ view, initial, onView, onLogout }: Props) {
  return (
    <nav className="icon-rail">
      <button type="button" className="icon-rail-avatar" title="Профиль" onClick={() => onView("profile")}>
        {initial}
      </button>
      <button
        type="button"
        className={`icon-rail-btn ${view === "files" ? "active" : ""}`}
        title="Файлы"
        aria-label="Файлы"
        onClick={() => onView("files")}
      >
        <FilesIcon size={22} />
      </button>
      <div className="icon-rail-spacer" />
      <button type="button" className="icon-rail-btn danger" title="Выйти" aria-label="Выйти" onClick={onLogout}>
        <svg {...stroke}>
          <path d="m16 17 5-5-5-5" />
          <path d="M21 12H9" />
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
        </svg>
      </button>
      <button
        type="button"
        className={`icon-rail-btn ${view === "settings" ? "active" : ""}`}
        title="Настройки"
        aria-label="Настройки"
        onClick={() => onView("settings")}
      >
        <svg {...stroke}>
          <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </button>
    </nav>
  );
}
