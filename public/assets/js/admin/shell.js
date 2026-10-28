// Shell & Navigation domain module (sidebar, tabs, drawer, issues banner)
import { $, fill } from "../common.js";
import { state, allowed, TAB_TITLES, btn } from "./context.js";

export function showTab(name) {
  state.currentTab = name;
  document.querySelectorAll(".ctabs [role=tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.ctab === name)));
  document.querySelectorAll("[data-cpanel]").forEach((p) => { p.hidden = p.dataset.cpanel !== name || !allowed(p); });
  if ($("dashCurrentTitle")) $("dashCurrentTitle").textContent = TAB_TITLES[name] || "Console";
  $("dashSidebar")?.classList.remove("open");
  $("dashBackdrop")?.classList.remove("open");
  state.loaders[name]?.();
}

export async function loadIssues() {
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const { count } = await state.sb.from("activity_log").select("id", { count: "exact", head: true }).in("level", ["error", "security"]).gte("at", since);
  const el = $("issueBanner");
  if (!el) return;
  if (!count) { el.hidden = true; return; }
  fill(el, `${count} problem${count === 1 ? "" : "s"} in the last 7 days (errors or refused access). `, btn("Review in the activity log", () => {
    if ($("acLevel")) $("acLevel").value = "problems";
    showTab("system");
  }, "btn small"));
  el.hidden = false;
}

export function initShell() {
  document.querySelectorAll(".ctabs [role=tab]").forEach((b) => {
    b.addEventListener("click", () => showTab(b.dataset.ctab));
  });

  $("dashMenuToggle")?.addEventListener("click", () => {
    $("dashSidebar")?.classList.toggle("open");
    $("dashBackdrop")?.classList.toggle("open");
  });

  $("dashBackdrop")?.addEventListener("click", () => {
    $("dashSidebar")?.classList.remove("open");
    $("dashBackdrop")?.classList.remove("open");
  });
}
