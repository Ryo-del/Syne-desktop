import { useEffect, useState } from "react";

import { formatBytes } from "../../files/format";
import * as api from "../../lib/api";
import type { AuthState, Device, HubState, Quota, User } from "../../types";
import "../files/desktop.css";

const ROLES: Record<string, string> = { student: "Студент", teacher: "Преподаватель", admin: "Администратор", user: "Пользователь" };
const TYPES: Record<string, string> = { study: "Syne Study", ios: "iPhone", android: "Android", desktop: "Компьютер", device: "Устройство" };

const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString("ru-RU", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
};

/** Аккаунт, место в облаке и входы с других устройств. */
export function AccountPanel({ user, quota }: { user: User; quota: Quota | null }) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [error, setError] = useState("");

  const load = () =>
    api
      .getDevices()
      .then(setDevices)
      .catch((e) => setError(e instanceof Error ? e.message : "Не удалось загрузить устройства"));
  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="settings-panel">
      <section className="settings-section-card">
        <div className="dk-kv"><span>Имя</span><span>{user.name}</span></div>
        <div className="dk-kv"><span>Логин</span><span>{user.login}</span></div>
        <div className="dk-kv"><span>Роль</span><span>{ROLES[user.role] ?? user.role}</span></div>
      </section>

      {quota ? (
        <section className="settings-section-card">
          <div className="dk-kv"><span>Место в облаке</span><span>{formatBytes(quota.used_bytes)} из {formatBytes(quota.limit_bytes)}</span></div>
          <div className="fx-quota-bar" style={{ margin: "6px 0" }}>
            <div className="fx-quota-fill" style={{ width: `${quota.limit_bytes ? Math.min(100, (quota.used_bytes / quota.limit_bytes) * 100) : 0}%` }} />
          </div>
          {quota.plan_bytes ? (
            <div className="dk-kv">
              <span>Подписка</span>
              <span>+{formatBytes(quota.plan_bytes)}{quota.plan_expires_at ? ` до ${fmtDate(quota.plan_expires_at).split(",")[0]}` : ""}</span>
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="settings-section-card">
        <strong>Входы в аккаунт</strong>
        {error ? <div className="settings-form-error">{error}</div> : null}
        {devices?.map((d) => (
          <div className="dk-device" key={d.id}>
            <span>
              {d.device_name || d.client_id}
              <small>{d.client_id} · вход {fmtDate(d.signed_in_at)} · активность {fmtDate(d.last_refresh_at)}</small>
            </span>
            <button
              className="fx-link dk-danger"
              onClick={async () => {
                try {
                  await api.revokeDevice(d.id);
                  await load();
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Не удалось завершить вход");
                }
              }}
            >
              Завершить вход
            </button>
          </div>
        ))}
        {devices?.length === 0 ? <div className="settings-form-hint">Нет активных устройств.</div> : null}
      </section>
    </div>
  );
}

/** Устройства Key Hub: подтверждение новых, повышение, отзыв, отключение этого компьютера. */
export function HubPanel({ hub, onHub, onSignedOut }: { hub: HubState | null; onHub: (s: HubState) => void; onSignedOut: (s: AuthState) => void }) {
  const [error, setError] = useState("");
  const act = async (fn: () => Promise<HubState>) => {
    try {
      onHub(await fn());
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось выполнить действие");
    }
  };

  if (!hub?.view || hub.view.state !== "ready") {
    return (
      <div className="settings-panel">
        <section className="settings-section-card">
          <div className="settings-form-hint">
            Этот компьютер ещё не подтверждён на доверенном устройстве (Syne Study или телефоне). После подтверждения здесь появятся устройства аккаунта.
          </div>
        </section>
      </div>
    );
  }
  const v = hub.view;

  return (
    <div className="settings-panel">
      <section className="settings-section-card">
        {error ? <div className="settings-form-error">{error}</div> : null}

        {hub.pending.map((p) => (
          <div className="dk-device" key={p.req.request_id}>
            <span>
              Новое устройство: {p.req.name} ({TYPES[p.req.type] ?? p.req.type})
              <small>Код сопряжения: <b>{p.pair_code}</b>. Подтверждайте, только если код совпадает с экраном нового устройства.</small>
            </span>
            <span className="dk-modal-btns">
              <button className="fx-link" onClick={() => act(() => api.hubApprove(p.req.request_id, false))}>Да</button>
              <button className="fx-link" onClick={() => act(() => api.hubApprove(p.req.request_id, true))}>Да, доверенным</button>
              <button className="fx-link dk-danger" onClick={() => act(() => api.hubReject(p.req.request_id))}>Нет</button>
            </span>
          </div>
        ))}

        {v.devices.map((d) => (
          <div className="dk-device" key={d.id}>
            <span>
              {d.name}{d.current ? " (этот компьютер)" : ""}
              <small>{TYPES[d.type] ?? d.type} · {d.trusted ? "доверенное" : "привязанное"}</small>
            </span>
            {v.can_approve && !d.current ? (
              <span className="dk-modal-btns">
                {!d.trusted ? <button className="fx-link" onClick={() => act(() => api.hubPromote(d.id))}>Сделать доверенным</button> : null}
                <button
                  className="fx-link dk-danger"
                  onClick={() => window.confirm(`Отозвать «${d.name}»? Оно потеряет доступ к сообщениям.`) && void act(() => api.hubRevoke(d.id))}
                >
                  Отозвать
                </button>
              </span>
            ) : null}
          </div>
        ))}
      </section>

      <section className="settings-section-card">
        <div className="dk-device">
          <span>
            Отключить этот компьютер
            <small>Ключ устройства будет удалён, вход завершится. Для возврата понадобится новое подтверждение.</small>
          </span>
          <button
            className="fx-link dk-danger"
            onClick={async () => window.confirm("Отключить этот компьютер от аккаунта?") && onSignedOut(await api.hubDisconnect())}
          >
            Отключить
          </button>
        </div>
      </section>
    </div>
  );
}
