export type ThemePreference = "system" | "light" | "dark";
const KEY = "syne.theme";

export function loadTheme(): ThemePreference {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* хранилище недоступно */
  }
  return "system";
}

export function applyTheme(pref: ThemePreference) {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* не страшно */
  }
  const dark = pref === "dark" || (pref === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}
