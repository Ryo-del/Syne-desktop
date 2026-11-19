import { useState } from "react";

import * as api from "../../lib/api";
import type { AuthState, HubGate } from "../../types";
import "./auth.css";

interface Props {
  gate: HubGate;
  onRetry: () => void;
  onSignedOut: (s: AuthState) => void;
}

const DENIED: Record<string, string> = {
  rejected: "Подключение отклонено на доверенном устройстве.",
  expired: "Время ожидания (48 часов) истекло.",
  cancelled: "Запрос отменён.",
};

/** Допуск в аккаунт только с подтверждённого устройства (Device Trust & Holding). */
export default function GateView({ gate, onRetry, onSignedOut }: Props) {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  const signOut = () => run(async () => onSignedOut(await api.hubCancel()));

  return (
    <div className="auth-overlay">
      <div className="auth-card">
        <h1 className="auth-title">Syne</h1>

        {gate.status === "waiting" ? (
          <>
            <p className="auth-subtitle">
              Подтвердите подключение этого компьютера на доверенном устройстве (Syne Study или телефоне) и сверьте код.
            </p>
            <div className="gate-code">{gate.code}</div>
            <p className="auth-hint">Запрос действует 48 часов. Окно обновится само.</p>
            <button className="auth-button" disabled={busy} onClick={signOut}>
              Отменить и выйти
            </button>
          </>
        ) : null}

        {gate.status === "denied" ? (
          <>
            <p className="auth-subtitle">{DENIED[gate.detail ?? ""] ?? "Подключение не подтверждено."}</p>
            <button className="auth-button" disabled={busy} onClick={() => run(async () => { await api.hubRetry(); onRetry(); })}>
              Запросить снова
            </button>
            <button className="fx-link" onClick={signOut}>
              Выйти
            </button>
          </>
        ) : null}

        {gate.status === "unreachable" ? (
          <>
            <p className="auth-subtitle">Нет связи с сервером, поэтому подключение устройства проверить нельзя.</p>
            <button className="auth-button" disabled={busy} onClick={() => run(async () => { await api.hubRecheck(); onRetry(); })}>
              Повторить
            </button>
            <button className="fx-link" onClick={signOut}>
              Выйти
            </button>
          </>
        ) : null}

        {gate.status === "checking" || gate.status === "off" ? <p className="auth-subtitle">Проверяем устройство…</p> : null}
      </div>
    </div>
  );
}
