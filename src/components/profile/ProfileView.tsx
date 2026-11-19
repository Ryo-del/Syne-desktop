import { useEffect, useState } from "react";

import * as api from "../../lib/api";
import { formatBytes, formatDate } from "../../lib/format";
import type { AuthState, Device, HubState, Quota, User } from "../../types";
import "../files/desktop.css";

const ROLES: Record<string, string> = { student: "Студент", teacher: "Преподаватель", admin: "Администратор", user: "Пользователь" };

interface Props {
  user: User;
  quota: Quota | null;
  hub: HubState | null;
  onHub: (s: HubState) => void;
  onSignedOut: (s: AuthState) => void;
}

const TYPES: Record<string, string> = { study: "Syne Study", ios: "iPhone", android: "Android", desktop: "Компьютер", device: "Устройство" };

export default function ProfileView({ user, quota, hub, onHub, onSignedOut }: Props) {
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
    <div className="dk-page">
      <h1>Профиль</h1>

      <div className="dk-card">
        <h2>Аккаунт</h2>
        <div className="dk-kv"><span>Имя</span><span>{user.name}</span></div>
        <div className="dk-kv"><span>Логин</span><span>{user.login}</span></div>
        <div className="dk-kv"><span>Роль</span><span>{ROLES[user.role] ?? user.role}</span></div>
      </div>

      {quota ? (
        <div className="dk-card">
          <h2>Место в облаке</h2>
          <div className="dk-kv"><span>Занято</span><span>{formatBytes(quota.used_bytes)} из {formatBytes(quota.limit_bytes)}</span></div>
          <div className="fx-quota-bar" style={{ margin: "6px 0" }}>
            <div className="fx-quota-fill" style={{ width: `${quota.limit_bytes ? Math.min(100, (quota.used_bytes / quota.limit_bytes) * 100) : 0}%` }} />
          </div>
          {quota.plan_bytes ? <div className="dk-kv"><span>Подписка</span><span>+{formatBytes(quota.plan_bytes)}{quota.plan_expires_at ? ` до ${formatDate(quota.plan_expires_at).split(",")[0]}` : ""}</span></div> : null}
        </div>
      ) : null}

      {hub?.view && hub.view.state === "ready" ? (
        <SecurityCard hub={hub} onHub={onHub} onSignedOut={onSignedOut} />
      ) : null}

      <div className="dk-card">
        <h2>Входы в аккаунт</h2>
        {error ? <div className="fx-modal-error">{error}</div> : null}
        {devices?.map((d) => (
          <div className="dk-device" key={d.id}>
            <span>
              {d.device_name || d.client_id}
              <small>{d.client_id} · вход {formatDate(d.signed_in_at)} · активность {formatDate(d.last_refresh_at)}</small>
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
        {devices?.length === 0 ? <div className="fx-modal-text">Нет активных устройств.</div> : null}
      </div>
    </div>
  );
}

function SecurityCard({ hub, onHub, onSignedOut }: { hub: HubState; onHub: (s: HubState) => void; onSignedOut: (s: AuthState) => void }) {
  const v = hub.view!;
  const [error, setError] = useState("");
  const act = async (fn: () => Promise<HubState>) => {
    try {
      onHub(await fn());
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось выполнить действие");
    }
  };
  return (
    <div className="dk-card">
      <h2>Устройства и безопасность</h2>
      {error ? <div className="fx-modal-error">{error}</div> : null}

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
    </div>
  );
}
