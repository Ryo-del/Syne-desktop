import { useEffect, useState } from "react";

import * as api from "../../lib/api";
import { formatBytes, formatDate } from "../../lib/format";
import type { Device, Quota, User } from "../../types";
import "../files/desktop.css";

const ROLES: Record<string, string> = { student: "Студент", teacher: "Преподаватель", admin: "Администратор", user: "Пользователь" };

export default function ProfileView({ user, quota }: { user: User; quota: Quota | null }) {
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

      <div className="dk-card">
        <h2>Устройства</h2>
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
