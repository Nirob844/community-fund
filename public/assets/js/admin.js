// Staff console entry point. Modular orchestrator.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/+esm";
import { $ } from "./common.js";
import { state, note, allowed, loadTop, logAct, publicLabel, today } from "./admin/context.js";
import { initAuth } from "./admin/auth.js";
import { initShell, showTab, loadIssues } from "./admin/shell.js";
import { initRecord } from "./admin/record.js";
import { initPledges } from "./admin/pledges.js";
import { initMoney } from "./admin/money.js";
import { initPeople } from "./admin/people.js";
import { initNews } from "./admin/news.js";
import { initRecords } from "./admin/records.js";
import { initClosing } from "./admin/closing.js";
import { initTeam } from "./admin/team.js";
import { initSettings } from "./admin/settings.js";
import { initSystem } from "./admin/system.js";

// Export for backward compatibility
export { publicLabel };

let errorsLogged = 0;
window.addEventListener("error", (e) => {
  if (state.role && errorsLogged++ < 3) {
    logAct("client.error", { message: String(e.message || "error").slice(0, 200), page: "admin" });
  }
});

async function boot() {
  const { data: { session } } = await state.sb.auth.getSession();
  state.session = session;
  if (!session) {
    document.body.classList.remove("logged-in");
    $("auth").hidden = false;
    $("console").hidden = true;
    return;
  }
  const { data: r } = await state.sb.rpc("staff_role");
  state.role = r || null;
  if (!state.role) {
    document.body.classList.remove("logged-in");
    note($("authMsg"), "This account is not an active team member.", "err");
    await state.sb.auth.signOut();
    return;
  }
  document.body.classList.add("logged-in");
  $("auth").hidden = true;
  $("console").hidden = false;
  $("who").textContent = session.user.email;
  const badge = $("roleBadge");
  badge.textContent = state.role[0].toUpperCase() + state.role.slice(1);
  badge.className = "pill role-" + state.role;

  document.querySelectorAll("[data-need],[data-roles],[data-ctab]").forEach((el) => {
    if (!allowed(el)) el.hidden = true;
  });
  ["plDate", "rDate", "eDate", "nDate", "plInDate", "rInDate"].forEach((id) => {
    if ($(id)) $(id).value = today();
  });

  try {
    const k = "fund-signin-" + session.user.id + "-" + String(session.access_token).slice(-12);
    if (!sessionStorage.getItem(k)) {
      sessionStorage.setItem(k, "1");
      logAct("client.sign_in", { page: "admin" });
    }
  } catch {
    logAct("client.sign_in", { page: "admin" });
  }

  if (state.role === "developer") {
    $("staffSum").hidden = true;
    const hint = document.querySelector(".staffbar .hint");
    if (hint) hint.hidden = true;
    note($("fundBanner"), "Developer access: system checks and the activity log only. People, pledges and money are not visible to this role. Your access ends automatically.", "warn");
  } else {
    const { data: st } = await state.sb.from("admins").select("user_id, display_name");
    state.staffNames = new Map((st || []).map((x) => [x.user_id, x.display_name || "Staff"]));
    const myName = state.staffNames.get(session.user.id) || session.user.email.split("@")[0];
    if ($("dashUserName")) $("dashUserName").textContent = myName;
    if ($("dashAvatar")) {
      const initials = myName.split(" ").filter(Boolean).map(w => w[0]).join("").toUpperCase().slice(0, 2) || "AD";
      $("dashAvatar").textContent = initials;
    }
    await loadTop();
  }

  if (["treasurer", "developer"].includes(state.role)) {
    loadIssues();
  }

  const first = [...document.querySelectorAll(".ctabs [role=tab]")].find((b) => !b.hidden);
  showTab(first?.dataset?.ctab || "record");
}

// Initialize Application
async function initApp() {
  const cfg = await (await fetch("/api/config")).json().catch(() => ({}));
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
    note($("authMsg"), "The site is not configured yet (SUPABASE_URL and SUPABASE_ANON_KEY).", "err");
    return;
  }

  state.sb = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { persistSession: true, storageKey: "fund-staff", flowType: "pkce" }
  });

  state.sb.auth.onAuthStateChange((evt) => {
    if (evt === "SIGNED_OUT") location.reload();
  });

  // Initialize domain modules
  initAuth(boot);
  initShell();
  initRecord();
  initPledges();
  initMoney();
  initPeople();
  initNews();
  initRecords();
  initClosing();
  initTeam();
  initSettings();
  initSystem();

  // Run boot to authenticate and load view
  boot();
}

initApp();
