import { useCallback, useEffect, useState } from "react";

import GateView from "./components/auth/GateView";
import LoginView from "./components/auth/LoginView";
import ChatsView, { totalUnread } from "./components/chat/ChatsView";
import FilesView from "./components/files/FilesView";
import IconRail from "./components/layout/IconRail";
import ProfileView from "./components/profile/ProfileView";
import SettingsView from "./components/settings/SettingsView";
import { useHub } from "./hooks/useHub";
import * as api from "./lib/api";
import { applyTheme, loadTheme } from "./lib/theme";
import type { AuthState, Quota, View } from "./types";

applyTheme(loadTheme());

export default function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [fatal, setFatal] = useState("");
  const [view, setView] = useState<View>("chats");
  const [quota, setQuota] = useState<Quota | null>(null);
  const [tick, setTick] = useState(0);

  const signedIn = Boolean(auth?.signed_in && auth.user);
  const { state: hub, refresh: refreshHub, apply: applyHub } = useHub(signedIn);

  const reload = useCallback(() => {
    api.authState().then(setAuth).catch((e) => setFatal(e instanceof Error ? e.message : "Ошибка запуска"));
  }, []);

  useEffect(() => {
    reload();
    return api.onSignedOut(() => {
      setAuth((a) => (a ? { ...a, signed_in: false, user: undefined } : a));
      setQuota(null);
    });
  }, [reload]);

  // Устройство отозвано или отключено сервисом: возвращаемся на вход с причиной.
  useEffect(() => {
    if (signedIn && hub && hub.gate.status === "off") reload();
  }, [signedIn, hub, reload]);

  // События облака (WebSocket): новые сообщения и изменения файлов.
  useEffect(() => {
    if (!signedIn) return;
    let close: (() => void) | undefined;
    let dead = false;
    api
      .openEvents((type) => {
        if (type === "changes" || type === "open") setTick((n) => n + 1);
      })
      .then((fn) => (dead ? fn() : (close = fn)));
    return () => {
      dead = true;
      close?.();
    };
  }, [signedIn]);

  const refreshQuota = useCallback(() => {
    api.getMe().then((m) => setQuota(m.quota)).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (signedIn) refreshQuota();
  }, [signedIn, refreshQuota]);

  if (fatal) return <div className="fx-loading">{fatal}</div>;
  if (!auth) return <div className="fx-loading">Запуск…</div>;
  if (!auth.signed_in || !auth.user) {
    return (
      <>
        {auth.reason ? <div className="client-update-banner"><div><strong>{auth.reason}</strong></div></div> : null}
        <LoginView server={auth.server} onSuccess={setAuth} />
      </>
    );
  }

  const user = auth.user;
  const gate = hub?.gate.status ?? "checking";
  // В аккаунт, файлы и профиль пускает пароль; подтверждённое устройство нужно только для чатов Key Hub.
  const chatsOpen = gate === "open";

  const ready = hub?.view?.state === "ready";
  const unread = ready ? totalUnread(user.id, hub!.view!.messages) : 0;
  const effective: View = view === "chats" && !hub?.view ? "files" : view;

  return (
    <div className={`app-shell${effective === "chats" && chatsOpen ? "" : " files-mode"}`}>
      <IconRail
        view={effective}
        initial={(user.name || user.login).slice(0, 1).toUpperCase()}
        unread={unread}
        approvals={hub?.pending.length ?? 0}
        onView={setView}
        onLogout={async () => {
          setAuth(await api.logout());
          setQuota(null);
          setView("chats");
        }}
      />
      {effective === "chats" && !chatsOpen ? (
        <GateView embedded gate={hub?.gate ?? { status: "checking" }} onRetry={refreshHub} onSignedOut={setAuth} />
      ) : null}
      {effective === "chats" && chatsOpen && hub ? <ChatsView userId={user.id} hub={hub} onState={applyHub} tick={tick} /> : null}
      {effective === "files" ? <FilesView quota={quota} onQuota={refreshQuota} tick={tick} /> : null}
      {effective === "profile" ? <ProfileView user={user} quota={quota} hub={hub} onHub={applyHub} onSignedOut={setAuth} /> : null}
      {effective === "settings" ? <SettingsView server={auth.server} /> : null}
    </div>
  );
}
