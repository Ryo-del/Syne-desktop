import { useState, type FormEvent } from "react";

import { ApiError, login } from "../../lib/api";
import type { AuthState } from "../../types";
import "./auth.css";

interface Props {
  server: string;
  onSuccess: (state: AuthState) => void;
}

export default function LoginView({ server, onSuccess }: Props) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [serverValue, setServerValue] = useState(server);
  const [showServer, setShowServer] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError("Введите логин и пароль");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const state = await login(username.trim(), password, showServer ? serverValue.trim() : undefined);
      onSuccess(state);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось войти. Попробуйте ещё раз.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-overlay">
      <form className="auth-card" onSubmit={submit}>
        <h1 className="auth-title">Syne</h1>
        <p className="auth-subtitle">Войдите в аккаунт Syne Cloud</p>

        <label className="auth-field">
          <span>Логин</span>
          <input
            type="text"
            autoFocus
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={busy}
          />
        </label>

        <label className="auth-field">
          <span>Пароль</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
        </label>

        {showServer ? (
          <label className="auth-field">
            <span>Сервер</span>
            <input
              type="url"
              spellCheck={false}
              value={serverValue}
              onChange={(e) => setServerValue(e.target.value)}
              disabled={busy}
            />
          </label>
        ) : null}

        {error ? <div className="auth-error">{error}</div> : null}

        <button type="submit" className="auth-button" disabled={busy}>
          {busy ? "Входим..." : "Войти"}
        </button>

        <p className="auth-hint">
          Аккаунт тот же, что на сайте и в Syne Study. Регистрация — на сайте syne-network.ru.{" "}
          <button type="button" className="fx-link" onClick={() => setShowServer((v) => !v)}>
            Сервер
          </button>
        </p>
      </form>
    </div>
  );
}
