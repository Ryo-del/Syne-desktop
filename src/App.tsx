import { invoke, isTauri } from "@tauri-apps/api/core";
import { sendNotification } from "@tauri-apps/plugin-notification";
import { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

import { HUB, useChats } from "./chats/useChats";
import ChatArea from "./components/chat/ChatArea";
import ContextMenus from "./components/common/ContextMenus";
import ErrorToast from "./components/common/ErrorToast";
import GateView from "./components/auth/GateView";
import LoginView from "./components/auth/LoginView";
import { Files } from "./components/files/Files";
import IconRail from "./components/layout/IconRail";
import PeersPanel from "./components/layout/PeersPanel";
import SearchPanel, { type FoundUser } from "./components/search/SearchPanel";
import SettingsPopover from "./components/settings/SettingsPopover";
import {
  APP_ICON_OPTIONS,
  DEFAULT_ACCOUNT_SETTINGS,
  type AccountSettings,
  type AppIconId,
  type AppLanguage,
  type NotificationSound,
  type SettingsSectionId,
  type SidebarView,
  type ThemePreference,
} from "./config/settings";
import { TRANSLATIONS } from "./config/translations";
import { clearImageCache } from "./files/blob";
import { useHub } from "./hooks/useHub";
import * as api from "./lib/api";
import { getInitial } from "./lib/format";
import { ensureNotificationPermission, notifyNewMessage } from "./lib/notify";
import { clearSessionLogin, setSessionLogin } from "./lib/session";
import type { AuthState, ChatSummary, Quota } from "./types";
import "./fonts";

const THEMES: ThemePreference[] = ["system", "light", "dark"];
const SOUNDS: NotificationSound[] = ["chime", "pulse", "soft", "none"];
const LANGS: AppLanguage[] = ["ru", "en", "fr", "de"];

function normalizeSettings(raw: Record<string, unknown>): AccountSettings {
  const d = DEFAULT_ACCOUNT_SETTINGS;
  const hours = typeof raw.autoLogoutHours === "number" ? raw.autoLogoutHours : d.autoLogoutHours;
  return {
    notificationsEnabled: typeof raw.notificationsEnabled === "boolean" ? raw.notificationsEnabled : d.notificationsEnabled,
    notificationPreview: typeof raw.notificationPreview === "boolean" ? raw.notificationPreview : d.notificationPreview,
    notificationSound: SOUNDS.includes(raw.notificationSound as NotificationSound) ? (raw.notificationSound as NotificationSound) : d.notificationSound,
    appLanguage: LANGS.includes(raw.appLanguage as AppLanguage) ? (raw.appLanguage as AppLanguage) : d.appLanguage,
    themePreference: THEMES.includes(raw.themePreference as ThemePreference) ? (raw.themePreference as ThemePreference) : d.themePreference,
    autoLogoutEnabled: typeof raw.autoLogoutEnabled === "boolean" ? raw.autoLogoutEnabled : d.autoLogoutEnabled,
    autoLogoutHours: Number.isInteger(hours) && hours >= 1 && hours <= 24 ? hours : d.autoLogoutHours,
    selfEmoji: typeof raw.selfEmoji === "string" && raw.selfEmoji ? raw.selfEmoji : d.selfEmoji,
    workspaceDeleteAfterUpload:
      typeof raw.workspaceDeleteAfterUpload === "boolean" ? raw.workspaceDeleteAfterUpload : d.workspaceDeleteAfterUpload,
  };
}

async function loadRoundedIconBytes(src: string): Promise<Uint8Array | null> {
  const img = new Image();
  img.src = src;
  await img.decode();
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const radius = size * 0.22;
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, radius);
  ctx.clip();
  ctx.drawImage(img, 0, 0, size, size);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

export default function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [fatal, setFatal] = useState("");
  const [quota, setQuota] = useState<Quota | null>(null);
  const [tick, setTick] = useState(0);

  const [selectedChatId, setSelectedChatId] = useState("");
  const [sidebarView, setSidebarView] = useState<SidebarView>("chats");
  const [filesOpened, setFilesOpened] = useState(false);
  const [query, setQuery] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [composer, setComposer] = useState("");
  const [chatContextMenu, setChatContextMenu] = useState<{ chatId: string; x: number; y: number } | null>(null);

  const [error, setErrorText] = useState("");
  const [toastKind, setToastKind] = useState<"info" | "error">("error");
  const [errorToastKey, setErrorToastKey] = useState(0);

  const [showSettings, setShowSettings] = useState(false);
  const [activeSettingsSection, setActiveSettingsSection] = useState<SettingsSectionId | null>(null);
  const [settings, setSettings] = useState<AccountSettings>(DEFAULT_ACCOUNT_SETTINGS);
  const [selectedAppIcon, setSelectedAppIcon] = useState<AppIconId>("blue");
  const [emojiPickerTarget, setEmojiPickerTarget] = useState<"self" | "peer" | null>(null);
  const [systemTheme, setSystemTheme] = useState<"light" | "dark">(() =>
    window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark",
  );

  const settingsRef = useRef(settings);
  const rawSettingsRef = useRef<Record<string, unknown>>({});
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const sessionStartedAtRef = useRef(0);
  const autoLogoutFiredRef = useRef(false);
  const selectedChatIdRef = useRef(selectedChatId);
  selectedChatIdRef.current = selectedChatId;
  const messageStreamRef = useRef<HTMLDivElement>(null);
  const pendingScrollRef = useRef<ScrollBehavior | null>(null);
  const previousChatIdRef = useRef("");

  const signedIn = Boolean(auth?.signed_in && auth.user);
  const { state: hub, refresh: refreshHub, apply: applyHub } = useHub(signedIn);

  const t = (key: string) => TRANSLATIONS[settings.appLanguage][key] ?? TRANSLATIONS.en[key] ?? key;

  function setError(message: string) {
    setErrorText(message);
    setToastKind("error");
    setErrorToastKey((k) => k + 1);
  }
  function showToast(message: string, kind: "info" | "error" = "error") {
    setErrorText(message);
    setToastKind(kind);
    setErrorToastKey((k) => k + 1);
  }

  // ── вход ──
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

  useEffect(() => {
    if (auth?.user) setSessionLogin(auth.user.login);
    else clearSessionLogin();
  }, [auth?.user]);

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

  // ── настройки аккаунта (хранятся в облаке и действуют на всех устройствах) ──
  function applySettings(next: AccountSettings, persist = false) {
    settingsRef.current = next;
    setSettings(next);
    if (persist && signedIn) {
      saveQueueRef.current = saveQueueRef.current
        .catch(() => undefined)
        .then(() => api.putSettings({ ...rawSettingsRef.current, ...next }))
        .then((saved) => {
          rawSettingsRef.current = saved;
        })
        .catch(() => setError("Не удалось сохранить настройки в облаке"));
    }
  }
  function updateSettings(patch: Partial<AccountSettings>) {
    applySettings({ ...settingsRef.current, ...patch }, true);
  }

  useEffect(() => {
    if (!signedIn) return;
    sessionStartedAtRef.current = Date.now();
    autoLogoutFiredRef.current = false;
    saveQueueRef.current = Promise.resolve();
    refreshQuota();
    api
      .getSettings()
      .then((raw) => {
        rawSettingsRef.current = raw;
        applySettings(normalizeSettings(raw));
      })
      .catch(() => applySettings(DEFAULT_ACCOUNT_SETTINGS));
    void ensureNotificationPermission();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn]);

  // ── тема и значок приложения ──
  const resolvedTheme = settings.themePreference === "system" ? systemTheme : settings.themePreference;
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => setSystemTheme(mq.matches ? "light" : "dark");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    const platform = /mac/i.test(navigator.platform) ? "mac" : "win";
    document.documentElement.classList.add(`platform-${platform}`);
  }, [resolvedTheme]);

  const currentAppIcon = APP_ICON_OPTIONS.find((item) => item.id === selectedAppIcon) ?? APP_ICON_OPTIONS[0];
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    (async () => {
      try {
        const bytes = await loadRoundedIconBytes(currentAppIcon.src);
        if (!bytes || cancelled) return;
        await invoke("set_app_icon", { iconBytes: Array.from(bytes) });
      } catch (err) {
        console.error("Failed to apply app icon:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentAppIcon.src]);

  // В релизной сборке убираем стандартное меню и DevTools; свои меню остаются.
  useEffect(() => {
    if (import.meta.env.DEV) return;
    const onContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea")) return;
      e.preventDefault();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      const blocked =
        e.key === "F12" ||
        (mod && e.shiftKey && ["i", "j", "c"].includes(k)) ||
        (e.metaKey && e.altKey && ["i", "j"].includes(k)) ||
        (mod && ["p", "s", "u"].includes(k));
      if (blocked) e.preventDefault();
    };
    window.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);

  // Files остаётся смонтированным после первого открытия: иначе пропали бы открытые файлы и несохранённые правки.
  useEffect(() => {
    if (sidebarView === "files") setFilesOpened(true);
  }, [sidebarView]);

  // ── чаты ──
  const user = auth?.user;
  const chatsApi = useChats({
    userId: user?.id ?? "",
    hub,
    applyHub,
    tick,
    selectedId: selectedChatId,
    onError: setError,
    onIncoming: (title, body) =>
      void notifyNewMessage({
        title: title || "Syne",
        body,
        enabled: settingsRef.current.notificationsEnabled,
        preview: settingsRef.current.notificationPreview,
        sound: settingsRef.current.notificationSound,
      }),
  });
  const { chats, messages } = chatsApi;

  const deferredQuery = useDeferredValue(query);
  const filteredChats = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase();
    return needle ? chats.filter((c) => c.title.toLowerCase().includes(needle)) : chats;
  }, [deferredQuery, chats]);

  const selectedChat = chats.find((c) => c.chat_id === selectedChatId) ?? null;
  const selectedMessages = selectedChat ? (messages[selectedChat.chat_id] ?? []) : [];

  useEffect(() => {
    const container = messageStreamRef.current;
    if (!container) return;
    const isChatSwitch = previousChatIdRef.current !== selectedChatId;
    previousChatIdRef.current = selectedChatId;
    const behavior: ScrollBehavior = pendingScrollRef.current ?? (isChatSwitch ? "auto" : "smooth");
    pendingScrollRef.current = null;
    container.scrollTo({ top: container.scrollHeight, behavior });
  }, [selectedMessages.length, selectedChatId]);

  const getAvatar = (label: string) => getInitial(label);
  const getChatAvatar = (chat: ChatSummary) => getInitial(chat.title);

  async function handleSend() {
    if (!selectedChat || !composer.trim()) return;
    const text = composer.trim();
    setComposer("");
    pendingScrollRef.current = "smooth";
    try {
      await chatsApi.send(selectedChat.chat_id, text);
    } catch (err) {
      pendingScrollRef.current = null;
      setComposer(text);
      setError(err instanceof Error ? err.message : "Не удалось отправить сообщение");
    }
  }

  async function handleOpenUser(found: FoundUser) {
    try {
      const id = await chatsApi.openWith(found);
      startTransition(() => {
        setSelectedChatId(id);
        setSidebarView("chats");
        setSearchQuery("");
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось открыть чат");
    }
  }

  function handleHideChat(chatId: string) {
    setChatContextMenu(null);
    chatsApi.hide(chatId);
    if (selectedChatIdRef.current === chatId) setSelectedChatId("");
  }

  function handleBlockChat(chatId: string) {
    setChatContextMenu(null);
    const chat = chats.find((c) => c.chat_id === chatId);
    if (!chat?.block_key) return;
    chatsApi.block(chat.block_key, chat.title);
    if (selectedChatIdRef.current === chatId) setSelectedChatId("");
    showToast(`«${chat.title}» заблокирован. Разблокировать можно в поиске.`, "info");
  }

  async function handleLogout() {
    try {
      await saveQueueRef.current;
    } catch {
      /* настройки уже сообщили об ошибке */
    }
    try {
      setAuth(await api.logout());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось выйти");
    }
    sessionStartedAtRef.current = 0;
    setShowSettings(false);
    setActiveSettingsSection(null);
    setSelectedAppIcon("blue");
    applySettings(DEFAULT_ACCOUNT_SETTINGS);
    rawSettingsRef.current = {};
    startTransition(() => {
      clearImageCache();
      setQuota(null);
      setSelectedChatId("");
      setComposer("");
      setSidebarView("chats");
      setFilesOpened(false);
    });
  }

  // Автовыход по таймеру.
  useEffect(() => {
    if (!signedIn || !settings.autoLogoutEnabled || sessionStartedAtRef.current === 0) return;
    const deadline = sessionStartedAtRef.current + settings.autoLogoutHours * 60 * 60 * 1000;
    const warningTimer = window.setTimeout(() => {
      const message = t("system.autoLogoutWarning");
      showToast(message, "info");
      if (isTauri() && settingsRef.current.notificationsEnabled) {
        void sendNotification({ title: "Syne", body: message });
      }
    }, Math.max(0, deadline - 60_000 - Date.now()));
    const logoutTimer = window.setTimeout(() => {
      if (autoLogoutFiredRef.current) return;
      autoLogoutFiredRef.current = true;
      void handleLogout();
    }, Math.max(0, deadline - Date.now()));
    return () => {
      window.clearTimeout(warningTimer);
      window.clearTimeout(logoutTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn, settings.autoLogoutEnabled, settings.autoLogoutHours]);

  // ── экраны до входа ──
  if (fatal) return <div className="fx-loading">{fatal}</div>;
  if (!auth) return <div className="fx-loading">Запуск…</div>;
  if (!auth.signed_in || !auth.user) {
    return (
      <>
        {auth.reason ? (
          <div className="client-update-banner">
            <div>
              <strong>{auth.reason}</strong>
            </div>
          </div>
        ) : null}
        <LoginView server={auth.server} onSuccess={setAuth} />
      </>
    );
  }

  const gate = hub?.gate.status ?? "checking";
  // В аккаунт и файлы пускает пароль; подтверждённое устройство нужно только для защищённых чатов.
  const chatsOpen = gate === "open";
  const trust = hub?.trust_error;
  const rosterPrompt = hub?.view?.roster_key_id;
  const names = hub?.view?.names ?? {};
  const showTrust =
    !!trust && !!selectedChat && selectedChat.chat_id.startsWith(HUB) &&
    (trust.login === selectedChat.chat_id.slice(HUB.length) || !!selectedChat.is_group);

  const banner = showTrust && trust ? (
    <div className="cx-trust">
      <strong>{trust.kind === "reset" ? "У собеседника сменилась идентичность." : "Реестр устройств собеседника изменился."}</strong>{" "}
      Убедитесь, что это действительно он, и только потом продолжайте.
      <div>
        <button
          className="fx-btn"
          onClick={async () => {
            try {
              applyHub(await api.hubAcceptPeer(trust.login));
            } catch (e) {
              setError(e instanceof Error ? e.message : "Не удалось продолжить");
            }
          }}
        >
          Это он — продолжить
        </button>
      </div>
    </div>
  ) : null;

  return (
    <>
      <div className={`app-shell${sidebarView === "files" ? " files-mode" : ""}`}>
        <IconRail
          sidebarView={sidebarView}
          showSettings={showSettings}
          emojiPickerTarget={emojiPickerTarget}
          selfEmoji={settings.selfEmoji}
          onEmojiTargetChange={setEmojiPickerTarget}
          onSelfEmojiChange={(emoji) => {
            updateSettings({ selfEmoji: emoji });
            setEmojiPickerTarget(null);
          }}
          onSidebarViewChange={setSidebarView}
          onSettings={() => {
            setActiveSettingsSection(null);
            setShowSettings(true);
          }}
          onLogout={() => void handleLogout()}
        />

        {filesOpened && (
          <div style={{ display: sidebarView === "files" ? "contents" : "none" }}>
            <Files deleteAfterUpload={settings.workspaceDeleteAfterUpload} />
          </div>
        )}

        {sidebarView !== "files" && (
          <>
            {sidebarView === "search" ? (
              <SearchPanel
                directory={names}
                selfLogin={auth.user.login}
                blocked={chatsApi.blocked}
                onUnblock={chatsApi.unblock}
                query={searchQuery}
                onQueryChange={setSearchQuery}
                getAvatar={getAvatar}
                onOpen={(u) => void handleOpenUser(u)}
                onError={setError}
              />
            ) : chatsOpen || chats.length > 0 ? (
              <PeersPanel
                query={query}
                onQueryChange={setQuery}
                chats={filteredChats}
                selectedChatId={selectedChatId}
                onSelectChat={(chatId) => {
                  setChatContextMenu(null);
                  setSelectedChatId(chatId);
                }}
                onChatContextMenu={(event, chatId) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setChatContextMenu({ chatId, x: event.clientX, y: event.clientY });
                }}
                getPeerAvatar={getChatAvatar}
              />
            ) : (
              <GateView embedded gate={hub?.gate ?? { status: "checking" }} onRetry={refreshHub} onSignedOut={setAuth} />
            )}

            <ChatArea
              selectedChat={selectedChat}
              selectedMessages={selectedMessages}
              composer={composer}
              messageStreamRef={messageStreamRef}
              banner={banner}
              onComposerChange={setComposer}
              onSend={() => void handleSend()}
              onSendPaths={chatsApi.sendPaths}
              onSendFile={chatsApi.sendBlob}
              onNotify={(msg, kind) => showToast(msg, kind)}
            />
          </>
        )}
      </div>

      {showSettings ? (
        <SettingsPopover
          user={auth.user}
          quota={quota}
          hub={hub}
          onHub={applyHub}
          onSignedOut={setAuth}
          activeSettingsSection={activeSettingsSection}
          notificationsEnabled={settings.notificationsEnabled}
          notificationPreview={settings.notificationPreview}
          notificationSound={settings.notificationSound}
          appLanguage={settings.appLanguage}
          themePreference={settings.themePreference}
          resolvedTheme={resolvedTheme}
          selectedAppIcon={selectedAppIcon}
          currentAppIcon={currentAppIcon}
          t={t}
          onClose={() => {
            setShowSettings(false);
            setActiveSettingsSection(null);
          }}
          onSectionChange={setActiveSettingsSection}
          onNotificationsEnabledChange={(value) => updateSettings({ notificationsEnabled: value })}
          onNotificationPreviewChange={(value) => updateSettings({ notificationPreview: value })}
          onNotificationSoundChange={(value) => updateSettings({ notificationSound: value })}
          onLanguageChange={(value) => updateSettings({ appLanguage: value })}
          onThemeChange={(value) => updateSettings({ themePreference: value })}
          onAppIconChange={setSelectedAppIcon}
          autoLogoutEnabled={settings.autoLogoutEnabled}
          autoLogoutHours={settings.autoLogoutHours}
          workspaceDeleteAfterUpload={settings.workspaceDeleteAfterUpload}
          onWorkspaceDeleteAfterUploadChange={(value) => updateSettings({ workspaceDeleteAfterUpload: value })}
          onAutoLogoutEnabledChange={(value) => updateSettings({ autoLogoutEnabled: value })}
          onAutoLogoutHoursChange={(value) => updateSettings({ autoLogoutHours: value })}
        />
      ) : null}


      {rosterPrompt ? (
        <div className="fx-modal-backdrop">
          <div className="fx-modal fx-modal-small">
            <div className="fx-modal-title">Сверьте ключ сервера колледжа</div>
            <div className="fx-modal-text">
              Отпечаток должен совпасть с тем, что показывает Syne Study на доверенном устройстве («Устройства и безопасность»). Без этого составам групп верить нельзя.
            </div>
            <div className="cx-safety">{rosterPrompt.match(/.{1,4}/g)?.join(" ")}</div>
            <div className="fx-modal-actions">
              <button className="fx-btn" onClick={async () => applyHub(await api.hubRoster(false))}>
                Не совпадает
              </button>
              <button className="fx-btn dk-primary" onClick={async () => applyHub(await api.hubRoster(true))}>
                Совпадает
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <ErrorToast error={error} kind={toastKind} errorToastKey={errorToastKey} onClose={() => setErrorText("")} />

      <ContextMenus
        chatContextMenu={chatContextMenu}
        onHideChat={handleHideChat}
        onBlockChat={
          chatContextMenu && chats.find((c) => c.chat_id === chatContextMenu.chatId)?.block_key ? handleBlockChat : null
        }
      />
    </>
  );
}


