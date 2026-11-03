// Fonts (Aspekta, IBM Plex Mono) are bundled by style.css from src/assets/:
// no third-party request, the showcase CSP only allows its own origin.
import "./style.css";
import "./site-nav.css";
import { initLab } from "./lab";
import { initLive, leaveLive } from "./live";
import { initAnatomy, leaveAnatomy } from "./anatomy";
import { $, $$ } from "./ui";
import { LANGS, applyStatic, lang, onLangChange, setLang } from "./i18n";

// ── Language ──────────────────────────────────────────────────────────────

function buildLangSwitch(): void {
  const box = $("#lang-switch");
  box.replaceChildren(
    ...LANGS.map(({ code, label, name }) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.lang = code;
      b.title = name;
      b.dataset.lang = code;
      b.onclick = () => setLang(code);
      return b;
    }),
  );
  syncLangSwitch();
}

function syncLangSwitch(): void {
  $$<HTMLButtonElement>("#lang-switch button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.lang === lang())));
}

// Served by the OptiRelay showcase (/studio/, outside the Android app): its
// menu stays at the top of the page, to get back to the site. The HTML ships
// in that state (first paint without layout shift); anywhere else it is
// taken down here.
if (location.host === "appassets.androidplatform.net" || !location.pathname.includes("/studio/")) {
  document.getElementById("site-nav")!.hidden = true;
  document.body.classList.remove("on-showcase");
}
// GitHub menu of the showcase bar: closes on a click elsewhere or Escape.
for (const menu of document.querySelectorAll<HTMLDetailsElement>(".nav-menu")) {
  document.addEventListener("click", (e) => {
    if (menu.open && !menu.contains(e.target as Node)) menu.open = false;
  });
  menu.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !menu.open) return;
    menu.open = false;
    menu.querySelector("summary")?.focus();
  });
}

applyStatic();
buildLangSwitch();
onLangChange(syncLangSwitch);

// ── Views ─────────────────────────────────────────────────────────────────

const VIEWS = ["lab", "live", "anatomy"] as const;
type View = (typeof VIEWS)[number];
const started = new Set<View>();
let currentView: View | null = null;

function route(): void {
  const hash = location.hash.slice(1) as View;
  const view: View = VIEWS.includes(hash) ? hash : "lab";
  if (currentView === "live" && view !== "live") leaveLive();
  if (currentView === "anatomy" && view !== "anatomy") leaveAnatomy();
  currentView = view;
  for (const v of VIEWS) document.getElementById(`view-${v}`)!.hidden = v !== view;
  $$(".top nav a").forEach((a) => a.toggleAttribute("aria-current", a.dataset.view === view));
  if (!started.has(view)) {
    started.add(view);
    ({ lab: initLab, live: initLive, anatomy: initAnatomy })[view]();
  }
}

window.addEventListener("hashchange", route);
route();
