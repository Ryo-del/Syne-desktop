import { useMemo, useState } from "react";
import "./search.css";

import * as api from "../../lib/api";

export interface FoundUser {
  id?: string;
  login: string;
  name: string;
}

interface SearchPanelProps {
  /** Справочник школы: логин → имя (из Key Hub). */
  directory: Record<string, string>;
  selfLogin: string;
  query: string;
  onQueryChange: (value: string) => void;
  getAvatar: (label: string) => string;
  onOpen: (user: FoundUser) => void;
  onError: (message: string) => void;
}

/** Поиск пользователей: по имени в справочнике или по точному логину в облаке. */
export default function SearchPanel({
  directory,
  selfLogin,
  query,
  onQueryChange,
  getAvatar,
  onOpen,
  onError,
}: SearchPanelProps) {
  const [exact, setExact] = useState<FoundUser | null>(null);
  const [looking, setLooking] = useState(false);
  const [lookedUp, setLookedUp] = useState("");

  const needle = query.trim().toLowerCase();
  const people = useMemo<FoundUser[]>(() => {
    if (!needle) return [];
    return Object.entries(directory)
      .filter(([login, name]) => login !== selfLogin && (name.toLowerCase().includes(needle) || login.toLowerCase().includes(needle)))
      .map(([login, name]) => ({ login, name }))
      .sort((a, b) => a.name.localeCompare(b.name, "ru"))
      .slice(0, 30);
  }, [directory, needle, selfLogin]);

  async function lookup() {
    const login = query.trim();
    if (!login || looking) return;
    setLooking(true);
    try {
      const u = await api.lookupUser(login);
      setExact({ id: u.id, login: u.login, name: u.name });
    } catch (e) {
      setExact(null);
      onError(e instanceof Error ? e.message : "Пользователь не найден");
    } finally {
      setLookedUp(login);
      setLooking(false);
    }
  }

  const rows = exact && lookedUp === query.trim() && !people.some((p) => p.login === exact.login) ? [exact, ...people] : people;

  return (
    <div className="nearby-panel">
      <div className="nearby-header">
        <div>
          <h2>Поиск</h2>
          <p>Найдите человека по имени или логину</p>
        </div>
        <span className="nearby-count">{rows.length}</span>
      </div>

      <div className="nearby-search">
        <span>⌕</span>
        <input
          type="text"
          autoFocus
          placeholder="Имя или логин..."
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void lookup();
          }}
        />
      </div>

      <div className="nearby-list">
        {rows.map((user) => (
          <div className="nearby-row" key={user.login}>
            <button type="button" className="nearby-main" onClick={() => onOpen(user)}>
              <span className="nearby-avatar">{getAvatar(user.name || user.login)}</span>
              <span className="nearby-info">
                <span className="nearby-name">{user.name || user.login}</span>
                <span className="nearby-id">{user.login}</span>
              </span>
            </button>
          </div>
        ))}

        {query.trim() && !rows.length ? (
          <div className="nearby-empty">
            Никого не нашли в справочнике.
            <br />
            <button type="button" className="fx-link" disabled={looking} onClick={() => void lookup()}>
              {looking ? "Ищем…" : `Найти «${query.trim()}» по точному логину`}
            </button>
          </div>
        ) : null}

        {!query.trim() ? <div className="nearby-empty">Начните вводить имя или логин</div> : null}
      </div>
    </div>
  );
}
