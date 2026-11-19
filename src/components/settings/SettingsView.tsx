import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

import { applyTheme, loadTheme, type ThemePreference } from "../../lib/theme";
import "../files/desktop.css";

const THEMES: { id: ThemePreference; label: string }[] = [
  { id: "system", label: "Как в системе" },
  { id: "light", label: "Светлая" },
  { id: "dark", label: "Тёмная" },
];

export default function SettingsView({ server }: { server: string }) {
  const [theme, setTheme] = useState<ThemePreference>(loadTheme());
  const [version, setVersion] = useState("");
  useEffect(() => {
    if (isTauri()) getVersion().then(setVersion).catch(() => undefined);
  }, []);
  return (
    <div className="dk-page">
      <h1>Настройки</h1>
      <div className="dk-card">
        <h2>Оформление</h2>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`fx-btn ${theme === t.id ? "dk-primary" : ""}`}
              onClick={() => {
                setTheme(t.id);
                applyTheme(t.id);
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div className="dk-card">
        <h2>Подключение</h2>
        <div className="dk-kv"><span>Сервер</span><span>{server}</span></div>
        <div className="dk-kv"><span>Версия</span><span>{version || "—"}</span></div>
      </div>
    </div>
  );
}
