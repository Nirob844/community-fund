// System & Health domain module (activity log, security checks, handover)
import { $, fill, h, emptyRow } from "../common.js";
import { state, note, safeQ, btn, confirmAct, pager, friendly, today, api, PAGE } from "./context.js";

const ACT = {
  "client.sign_in": "Signed in", "client.sign_out": "Signed out", "client.export": "Downloaded a file", "client.error": "Error on a staff page",
  "access.denied": "Access refused", "team.add": "Team member added", "team.invite": "Team member invited", "team.change": "Team member changed",
  "team.deactivate": "Access removed", "team.reactivate": "Access restored", "team.delete": "Team member deleted",
  "developer.invite": "Developer invited", "developer.remove": "Developer removed", "developer.extend": "Developer access extended", "developer.change": "Developer access changed",
  "settings.limits": "Limits changed", "settings.goals": "Goals changed", "settings.payments": "Card payments switched", "settings.change": "Settings changed",
  "handover.complete": "Handover confirmed", "health.view": "System check run", "refund.issue": "Card refund issued", "refund.failed": "Card refund failed",
  "plan.cancel": "Giving plan stopped", "plan.cancel_failed": "Stopping a plan failed", "plan.payment_failed": "Plan payment declined",
  "donor.bad_link": "Unknown private link used", "donor.give_again": "Donor gave again", "donor.plan_start": "Donor started a plan",
  "webhook.bad_signature": "Forged payment notice refused", "webhook.error": "Payment notice failed", "server.error": "Server error",
};

let acPage = 0;

async function loadHandover() {
  const { data: s } = await state.sb.from("settings").select("handover_at, keys_rotated_on").eq("id", 1).maybeSingle();
  $("hoStatus").textContent = s?.handover_at ? `Last handover confirmed ${new Date(s.handover_at).toLocaleString()}${s.keys_rotated_on ? `; keys changed ${s.keys_rotated_on}` : ""}.` : "No handover has been confirmed yet.";
  if (!$("hoKeys").value) $("hoKeys").value = today();
}

export function initSystem() {
  state.loaders.system = async (page = 0) => {
    if (page === 0) {
      state.sb.rpc("activity_verify").then(({ data: v, error }) => {
        if (error || !v) return note($("acIntegrity"), "The integrity check could not run.", "warn");
        note($("acIntegrity"), v.ok ? `Integrity verified: all ${Number(v.checked).toLocaleString()} entries are intact.` : `Warning: the activity log was tampered with at entry ${v.firstBadId}. Tell the board.`, v.ok ? "" : "err");
      });
      if (state.role === "treasurer") loadHandover();
    }
    acPage = Math.max(0, page);
    let q = state.sb.from("activity_log").select("*", { count: "exact" });
    const lv = $("acLevel")?.value, sq = safeQ($("acSearch")?.value).replace(/\s+/g, "_");
    if (lv === "problems") q = q.in("level", ["error", "security"]); else if (lv) q = q.eq("level", lv);
    if (sq) q = q.ilike("action", `%${sq}%`);
    const { data, count, error } = await q.order("id", { ascending: false }).range(acPage * PAGE, acPage * PAGE + PAGE - 1);
    if (error) return note($("status"), friendly(error), "err");
    fill($("activityRows"), data.length ? data.map((x) => h("tr", {},
      h("td", { class: "num" }, new Date(x.at).toLocaleString()),
      h("td", {}, x.actor_label || (x.actor ? "Staff" : "Website / server"), x.role ? h("div", { class: "hint" }, x.role) : null),
      h("td", {}, ACT[x.action] || x.action, h("div", { class: "hint" }, x.action + (x.path ? " · " + x.path : ""))),
      h("td", {}, h("span", { class: "pill lvl-" + x.level }, x.level)),
      h("td", { class: "hint" }, Object.entries(x.detail || {}).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join(" · ").slice(0, 300))
    )) : emptyRow(5, "Nothing matches."));
    pager($("activityPager"), acPage, count || 0, (p) => state.loaders.system(p));
  };

  $("acLevel")?.addEventListener("change", () => state.loaders.system(0));
  let acT;
  $("acSearch")?.addEventListener("input", () => {
    clearTimeout(acT);
    acT = setTimeout(() => state.loaders.system(0), 300);
  });

  $("hRun")?.addEventListener("click", async () => {
    $("hRun").disabled = true;
    note($("hMsg"), "Running the checks…");
    try {
      const d = await api("/api/health");
      const checks = d.security?.checks || [];
      fill($("secRows"), checks.length ? checks.map((c) => h("tr", {},
        h("td", {}, c.name),
        h("td", {}, h("span", { class: "pill " + (c.ok ? "ok" : "due") }, c.ok ? "Passed" : "Needs attention")),
        h("td", { class: "hint" }, c.detail || "")
      )) : emptyRow(3, d.security?.error || "No checks returned."));
      const missing = Object.entries(d.env || {}).filter(([, v]) => !v).map(([k]) => k);
      $("envLine").textContent = `Version ${d.version} (${d.context}) · Stripe ${d.stripeMode} mode · ${missing.length ? "Not configured: " + missing.join(", ") : "All services configured"}${d.activity?.issuesLast7Days != null ? ` · ${d.activity.issuesLast7Days} problem${d.activity.issuesLast7Days === 1 ? "" : "s"} in 7 days` : ""}.`;
      note($("hMsg"), d.security?.ok ? "Every security check passed." : "Some checks need attention. See the list below.", d.security?.ok ? "" : "warn");
    } catch (e) {
      note($("hMsg"), e.message, "err");
    }
    $("hRun").disabled = false;
  });

  $("hoConfirm")?.addEventListener("click", (e) => {
    if ([...document.querySelectorAll(".ho")].some((c) => !c.checked)) return note($("hoMsg"), "Tick every step first. Each one closes a way back in.", "err");
    if (!$("hoKeys").value || $("hoKeys").value > today()) return note($("hoMsg"), "Enter the date the keys were changed.", "err");
    confirmAct(e.currentTarget, "Confirm the handover and remove all developer access?", async () => {
      const r = await state.sb.from("settings").update({ handover_at: new Date().toISOString(), keys_rotated_on: $("hoKeys").value }).eq("id", 1);
      if (!r.error) note($("hoMsg"), "Handover confirmed. All developer access has been removed and the handover is in the activity log.");
      return r;
    }, () => state.loaders.system(0));
  });
}
