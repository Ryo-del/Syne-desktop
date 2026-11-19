import { useCallback, useEffect, useState } from "react";

import LoginView from "./components/auth/LoginView";
import FilesView from "./components/files/FilesView";
import IconRail from "./components/layout/IconRail";
import ProfileView from "./components/profile/ProfileView";
import SettingsView from "./components/settings/SettingsView";
import * as api from "./lib/api";
import { applyTheme, loadTheme } from "./lib/theme";
import type { AuthState, Quota, View } from "./types";

applyTheme(loadTheme());

export default function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [fatal, setFatal] = useState("");
  const [view, setView] = useState<View>("files");
  const [quota, setQuota] = useState<Quota | null>(null);

  useEffect(() => {
    api.authState().then(setAuth).catch((e) => setFatal(e instanceof Error ? e.message : "Ошибка запуска"));
    return api.onSignedOut(() => {
      setAuth((a) => (a ? { ...a, signed_in: false, user: undefined } : a));
      setQuota(null);
    });
  }, []);

  const refreshQuota = useCallback(() => {
    api.getMe().then((m) => setQuota(m.quota)).catch(() => undefined);
  }, []);

  const signedIn = auth?.signed_in && auth.user;
  useEffect(() => {
    if (signedIn) refreshQuota();
  }, [signedIn, refreshQuota]);

  if (fatal) return <div className="fx-loading">{fatal}</div>;
  if (!auth) return <div className="fx-loading">Запуск…</div>;
  if (!auth.signed_in || !auth.user) {
    return <LoginView server={auth.server} onSuccess={setAuth} />;
  }

  const user = auth.user;
  return (
    <div className="app-shell files-mode">
      <IconRail
        view={view}
        initial={(user.name || user.login).slice(0, 1).toUpperCase()}
        onView={setView}
        onLogout={async () => {
          setAuth(await api.logout());
          setQuota(null);
          setView("files");
        }}
      />
      {view === "files" ? <FilesView quota={quota} onQuota={refreshQuota} /> : null}
      {view === "profile" ? <ProfileView user={user} quota={quota} /> : null}
      {view === "settings" ? <SettingsView server={auth.server} /> : null}
    </div>
  );
}
