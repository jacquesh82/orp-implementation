/**
 * Minimal, typed i18n — no dependency.
 *
 *   - `en` is the reference dictionary (and the default language); `fr` must
 *     provide exactly the same keys (checked at compile time).
 *   - Static markup: `data-i18n` (text), `data-i18n-html` (trusted markup from
 *     the dictionaries), `data-i18n-aria`, `data-i18n-title`,
 *     `data-i18n-placeholder`. Re-applied on every language change.
 *   - Dynamic text: `t(key, { var })` with `{var}` placeholders; views that
 *     render text themselves subscribe with `onLangChange`.
 */
import { en, type Messages } from "./en";
import { fr } from "./fr";

export type Lang = "en" | "fr";
export type Key = keyof Messages;

const DICTS: Record<Lang, Messages> = { en, fr };
export const LANGS: { code: Lang; label: string; name: string }[] = [
  { code: "en", label: "EN", name: "English" },
  { code: "fr", label: "FR", name: "Français" },
];
const STORAGE_KEY = "optirelay-studio.lang";
const DEFAULT_LANG: Lang = "en";

function stored(): Lang | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "en" || v === "fr" ? v : null;
  } catch {
    return null;
  }
}

/** `?lang=fr` wins (shareable link), then the saved choice, then English. */
function initial(): Lang {
  const q = new URLSearchParams(location.search).get("lang");
  if (q === "en" || q === "fr") return q;
  return stored() ?? DEFAULT_LANG;
}

let current: Lang = initial();
const listeners = new Set<(lang: Lang) => void>();

export const lang = () => current;
/** BCP 47 tag for Intl / toLocaleString. */
export const locale = () => (current === "fr" ? "fr-FR" : "en-US");

export function t(key: Key, vars?: Record<string, string | number>): string {
  let s: string = DICTS[current][key] ?? en[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
  return s;
}

export function applyStatic(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n as Key)));
  root.querySelectorAll<HTMLElement>("[data-i18n-html]").forEach((el) => (el.innerHTML = t(el.dataset.i18nHtml as Key)));
  root.querySelectorAll<HTMLElement>("[data-i18n-aria]").forEach((el) => el.setAttribute("aria-label", t(el.dataset.i18nAria as Key)));
  root.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((el) => (el.title = t(el.dataset.i18nTitle as Key)));
  root.querySelectorAll<HTMLElement>("[data-i18n-placeholder]").forEach((el) => el.setAttribute("placeholder", t(el.dataset.i18nPlaceholder as Key)));
  document.documentElement.lang = current;
  document.title = t("meta.title");
  document.querySelector('meta[name="description"]')?.setAttribute("content", t("meta.description"));
}

export function setLang(next: Lang): void {
  if (next === current) return;
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* private mode: the choice simply is not remembered */
  }
  applyStatic();
  for (const fn of listeners) fn(next);
}

export function onLangChange(fn: (lang: Lang) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
