import { useCallback, useEffect, useState } from "react";

import * as api from "../../lib/api";

interface Props {
  t: (key: string) => string;
}

/** Обновления приложения: те же две настройки, что у Syne Server («проверять» и «ставить автоматически»). */
export default function UpdatePanel({ t }: Props) {
  const [st, setSt] = useState<api.UpdateState | null>(null);
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try {
      setSt(await api.getUpdate());
    } catch {
      /* сервис перезапускается — следующий опрос подхватит */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Пока идёт загрузка установщика — обновляем состояние.
  const downloading = st?.release?.downloading === true;
  useEffect(() => {
    if (!downloading) return;
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [downloading, load]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr("");
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!st) return null;
  if (!st.available || !st.settings) {
    return (
      <section className="settings-section-card">
        <div className="settings-version-row"><strong>{t("upd.title")}</strong></div>
        <small>{t("upd.unavailable")}</small>
      </section>
    );
  }

  const settings = st.settings;
  const rel = st.release;
  const save = (next: { enabled: boolean; auto_install: boolean }) => run(async () => setSt(await api.saveUpdateSettings(next)));
  const fill = (key: string, v: string) => t(key).replace("{v}", v);

  let status: string;
  if (installing) status = t("upd.installing");
  else if (busy && !rel) status = t("upd.checking");
  else if (!rel) status = st.checked_at ? t("upd.latest") : "";
  else if (rel.downloading) status = fill("upd.downloading", rel.version);
  else if (rel.staged) status = fill("upd.ready", rel.version);
  else status = fill("upd.available", rel.version);
  const problem = err || rel?.download_error || st.error || "";

  return (
    <section className="settings-section-card">
      <div className="settings-version-row"><strong>{t("upd.title")}</strong></div>
      <label className="settings-toggle-row">
        <span><strong>{t("upd.check")}</strong><small>{t("upd.checkMeta")}</small></span>
        <input type="checkbox" checked={settings.enabled} disabled={busy} onChange={(e) => void save({ ...settings, enabled: e.target.checked })} />
      </label>
      <label className="settings-toggle-row">
        <span><strong>{t("upd.auto")}</strong><small>{t("upd.autoMeta")}</small></span>
        <input type="checkbox" checked={settings.auto_install} disabled={busy || !settings.enabled} onChange={(e) => void save({ ...settings, auto_install: e.target.checked })} />
      </label>
      {status ? <div className="settings-version-row"><span>{status}</span></div> : null}
      {st.busy && rel?.staged ? <small>{t("upd.busy")}</small> : null}
      {problem ? <div className="settings-form-error">{problem}</div> : null}
      <div className="settings-version-row">
        <button className="settings-input" type="button" disabled={busy || installing} onClick={() => void run(async () => setSt(await api.checkUpdate()))}>
          {busy ? t("upd.checking") : t("upd.checkNow")}
        </button>
        {rel?.staged ? (
          <button
            className="settings-input"
            type="button"
            disabled={busy || installing}
            onClick={() => void run(async () => { await api.installUpdate(); setInstalling(true); })}
          >
            {t("upd.install")}
          </button>
        ) : null}
      </div>
    </section>
  );
}
