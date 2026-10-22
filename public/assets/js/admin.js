// Staff console. Sign-in uses a one-time email code. What each person can see and change
// is enforced by Postgres Row Level Security (treasurer / recorder / auditor / developer), not by
// this page; the page only hides controls a role cannot use. A developer (temporary, invited by
// the treasurer) sees only the System and activity tab. Every list is paged from the database,
// so the console works the same with 10 or 10,000 contributors.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/+esm";
import { $, h, fill, fmt, emptyRow } from "./common.js";

const PAGE = 25;
const today = () => new Date().toISOString().slice(0, 10);
function showToast(text, kind = "ok") {
  if (!text) return;
  let tc = $("toastContainer");
  if (!tc) {
    tc = h("div", { id: "toastContainer", className: "toast-container", "aria-live": "polite" });
    document.body.appendChild(tc);
  }
  const icon = kind === "err" ? "✕" : kind === "warn" ? "⚠" : "✓";
  const toast = h("div", { className: `toast ${kind}` },
    h("span", { className: "t-icon" }, icon),
    h("div", { className: "t-text" }, text),
    h("button", { className: "t-close", type: "button", "aria-label": "Close", onclick: (e) => { e.stopPropagation(); dismissToast(toast); } }, "×")
  );
  tc.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("show"));
  toast._timer = setTimeout(() => dismissToast(toast), 4000);
}

function dismissToast(toast) {
  if (!toast || toast._dismissed) return;
  toast._dismissed = true;
  clearTimeout(toast._timer);
  toast.classList.remove("show");
  toast.classList.add("hide");
  setTimeout(() => toast.remove(), 250);
}

function setBtnLoading(btn, text = "Saving...") {
  if (!btn) return () => {};
  const origText = btn.textContent;
  btn.disabled = true;
  btn.classList.add("loading");
  btn.replaceChildren(h("span", { className: "spin" }), document.createTextNode(" " + text));
  return (success = true, successText = "✓ Saved") => {
    if (success) {
      btn.replaceChildren(document.createTextNode(successText));
      setTimeout(() => {
        btn.textContent = origText;
        btn.disabled = false;
        btn.classList.remove("loading");
      }, 1000);
    } else {
      btn.textContent = origText;
      btn.disabled = false;
      btn.classList.remove("loading");
    }
  };
}

const note = (el, text, kind = "") => {
  if (el) {
    el.textContent = text;
    el.className = "note" + (kind ? " " + kind : " ok");
    el.hidden = !text;
  }
  if (text) showToast(text, kind || "ok");
};
const RANK = { developer: 0, auditor: 1, recorder: 2, treasurer: 3 };
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,63}\.[^\s@]{2,24}$/;
const KIND = { refund: "Refund", dispute_lost: "Chargeback", closing_payout: "Closing payout" };
let sb, role = null, session = null, settings = null, staffNames = new Map();
const can = (need) => (RANK[role] ?? -1) >= RANK[need] && (need === "developer" || role !== "developer");
/** May this role see an element? data-roles lists roles; data-need is a minimum; tabs default to "auditor". */
function allowed(el) {
  if (el.dataset.roles) return el.dataset.roles.split(/\s+/).includes(role);
  const need = el.dataset.need || (el.matches("[data-ctab],[data-cpanel]") ? "auditor" : null);
  return !need || can(need);
}
const FREQ = { weekly: "Weekly", monthly: "Monthly", quarterly: "Every 3 months" };
const PLAN_STATUS = { pending: ["Waiting for setup", "pend"], active: ["Active", "ok"], past_due: ["Payment failed", "due"], completed: ["Completed", "ok"], cancelled: ["Stopped", "cancelled"] };
function nextDue(p) {
  if (["completed", "cancelled"].includes(p.status)) return "—";
  const d = new Date(p.start_on + "T12:00:00");
  if (p.frequency === "weekly") d.setDate(d.getDate() + 7 * p.paid_count); else d.setMonth(d.getMonth() + (p.frequency === "quarterly" ? 3 : 1) * p.paid_count);
  return d.toISOString().slice(0, 10);
}
async function api(path, method = "GET", body) {
  const { data: { session: s } } = await sb.auth.getSession();
  const r = await fetch(path, { method, headers: { authorization: "Bearer " + s.access_token, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || "The request failed.");
  return d;
}
/** Write to the activity log (sign-in, downloads, page errors). Never interrupts the work. */
const logAct = (act, info = {}) => { try { sb?.rpc("log_activity", { act, info }).then(() => {}, () => {}); } catch {} };
let errorsLogged = 0;
window.addEventListener("error", (e) => { if (role && errorsLogged++ < 3) logAct("client.error", { message: String(e.message || "error").slice(0, 200), page: "admin" }); });

export function publicLabel(full, mode) {
  if (mode === "anon") return "Anonymous neighbor";
  const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "Neighbor";
  const first = parts[0].charAt(0).toUpperCase() + parts[0].slice(1, 30);
  return parts.length > 1 ? `${first} ${parts[parts.length - 1][0].toUpperCase()}.` : first;
}
const friendly = (error) => {
  const m = String(error?.message || error || "");
  if (/row-level security|permission denied|not allowed/i.test(m)) return "Your role can't make this change.";
  if (/contributors_email_uq/i.test(m)) return "Someone with that email is already a contributor. Search for them instead.";
  if (/more than what is left/i.test(m)) return m;
  if (/no longer accepting/i.test(m)) return "The fund is closing, so new pledges can't be added. Reopen it in the Closing tab first.";
  if (/limit set by the treasurer|must be between|at most \d+ payments|must be at most/i.test(m)) return m.replace(/(\d+)\.00\b/g, (x, n) => "$" + Number(n).toLocaleString("en-US"));
  if (/settings_limits/i.test(m)) return "Check the limits: the smallest gift must be below the largest, and nothing above $2,000,000.";
  if (/settings_milestones/i.test(m)) return "Each goal needs an amount above $0 and a title (up to 10 goals).";
  if (/settings_amounts/i.test(m)) return "Suggested amounts must be 1 to 8 numbers between $1 and $2,000,000.";
  if (/check constraint|violates check/i.test(m)) return "One of the values isn't allowed. Check the amount and fields.";
  if (/JWT|expired/i.test(m)) return "Your session expired. Please sign in again.";
  return "Could not save. Please try again.";
};
const who = (id) => (id ? staffNames.get(id) || "Former staff" : "Website / Stripe");
const safeQ = (q) => String(q || "").replace(/[,()*%\\:"']/g, " ").trim().slice(0, 60);
const btn = (label, onclick, cls = "btn small ghost") => h("button", { class: cls, type: "button", onclick }, label);

/** Ask before doing something; replaces the cell's buttons with Yes / No. */
function confirmAct(cellBtn, question, action, done) {
  const wrap = cellBtn.closest("td") || cellBtn.parentElement;
  const keep = [...wrap.childNodes];
  fill(wrap, h("span", { class: "confirm" }, h("span", { class: "hint" }, question + " "),
    btn("Yes", async (e) => {
      const finish = setBtnLoading(e.currentTarget, "Working...");
      try {
        const r = await action();
        fill(wrap, keep);                       // put the original buttons back before anything re-renders
        if (r?.error) note($("status"), friendly(r.error), "err");
        else { $("status").hidden = true; showToast("Action completed.", "ok"); }
        done ? done() : refresh();
      } catch (err) {
        fill(wrap, keep);
        note($("status"), friendly(err), "err");
      }
    }, "btn small danger"),
    btn("No", () => fill(wrap, keep))));
}

function pager(el, page, total, go) {
  const pages = Math.max(1, Math.ceil((total || 0) / PAGE));
  fill(el, total > PAGE ? [h("span", {}, `Page ${page + 1} of ${pages} · ${total.toLocaleString()} total`),
    btn("Previous", () => go(page - 1)), btn("Next", () => go(page + 1))] : total ? h("span", {}, `${total.toLocaleString()} total`) : null);
  if (total > PAGE) { el.children[1].disabled = page <= 0; el.children[2].disabled = page >= pages - 1; }
}

function csvDownload(name, rows) {
  const q = (v) => typeof v === "number" ? String(v) : `"${String(v ?? "").replace(/"/g, '""').replace(/^[=+\-@\t\r]/, "'$&")}"`;
  const blob = new Blob(["﻿" + rows.map((r) => r.map(q).join(",")).join("\r\n")], { type: "text/csv" });
  const a = h("a", { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
}
/** Fetch every row of a query, 1,000 at a time (the database's per-request limit). */
async function fetchAll(make) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await make().range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

// ---------- Boot ----------
const cfg = await (await fetch("/api/config")).json().catch(() => ({}));
if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
  note($("authMsg"), "The site is not configured yet (SUPABASE_URL and SUPABASE_ANON_KEY).", "err");
} else {
  sb = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: true, storageKey: "fund-staff", flowType: "pkce" } });
  sb.auth.onAuthStateChange((evt) => { if (evt === "SIGNED_OUT") location.reload(); });
  boot();
}

$("emailForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("aEmail").value.trim();
  if (!EMAIL.test(email)) return note($("authMsg"), "Enter a valid email address.", "err");
  const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
  $("codeForm").hidden = false; $("aCode").focus();
  note($("authMsg"), error && /rate/i.test(error.message) ? "Too many requests. Wait a minute and try again." : "If that email belongs to a team member, a 6-digit code is on its way.");
});
$("codeForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { error } = await sb.auth.verifyOtp({ email: $("aEmail").value.trim(), token: $("aCode").value.trim(), type: "email" });
  if (error) return note($("authMsg"), "That code didn't work or has expired. Request a new one.", "err");
  boot();
});
$("signOut").addEventListener("click", async () => { try { await sb.rpc("log_activity", { act: "client.sign_out", info: { page: "admin" } }); } catch {} sb.auth.signOut(); });

async function boot() {
  ({ data: { session } } = await sb.auth.getSession());
  if (!session) { $("auth").hidden = false; $("console").hidden = true; return; }
  const { data: r } = await sb.rpc("staff_role");
  role = r || null;
  if (!role) { note($("authMsg"), "This account is not an active team member.", "err"); await sb.auth.signOut(); return; }
  $("auth").hidden = true; $("console").hidden = false;
  $("who").textContent = session.user.email;
  const badge = $("roleBadge"); badge.textContent = role[0].toUpperCase() + role.slice(1); badge.className = "pill role-" + role;
  document.querySelectorAll("[data-need],[data-roles],[data-ctab]").forEach((el) => { if (!allowed(el)) el.hidden = true; });
  ["plDate", "rDate", "eDate", "nDate"].forEach((id) => { $(id).value = today(); });
  try { const k = "fund-signin-" + session.user.id + "-" + String(session.access_token).slice(-12); if (!sessionStorage.getItem(k)) { sessionStorage.setItem(k, "1"); logAct("client.sign_in", { page: "admin" }); } } catch { logAct("client.sign_in", { page: "admin" }); }
  if (role === "developer") {
    $("staffSum").hidden = true; document.querySelector(".staffbar .hint").hidden = true;
    note($("fundBanner"), "Developer access: system checks and the activity log only. People, pledges and money are not visible to this role. Your access ends automatically.", "warn");
  } else {
    const { data: st } = await sb.from("admins").select("user_id, display_name");
    staffNames = new Map((st || []).map((x) => [x.user_id, x.display_name || "Staff"]));
    await loadTop();
  }
  if (["treasurer", "developer"].includes(role)) loadIssues();
  const first = [...document.querySelectorAll(".ctabs [role=tab]")].find((b) => !b.hidden);
  showTab(first.dataset.ctab);
}

async function loadTop() {
  const [{ data: t, error }, { data: s }] = await Promise.all([sb.rpc("ledger_totals"), sb.from("settings").select("*").eq("id", 1).maybeSingle()]);
  if (error) return note($("status"), friendly(error), "err");
  settings = s;
  $("tCash").textContent = fmt(Number(t.cash)); $("tRec").textContent = fmt(Number(t.received));
  $("tOut").textContent = fmt(Number(t.outstandingPledges)); $("tExp").textContent = fmt(Number(t.expenses));
  const st = s?.fund_status || "open";
  $("fundBanner").hidden = st === "open";
  $("fundBanner").textContent = st === "closing" ? "The fund is closing: the website no longer accepts pledges. Finish the payouts in the Closing tab." : st === "closed" ? `The fund is closed${s.closed_on ? " (" + s.closed_on + ")" : ""}.` : "";
  return t;
}

// ---------- Tabs ----------
let current = null;
const loaders = {};
function showTab(name) {
  current = name;
  document.querySelectorAll(".ctabs [role=tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.ctab === name)));
  document.querySelectorAll("[data-cpanel]").forEach((p) => { p.hidden = p.dataset.cpanel !== name || !allowed(p); });
  loaders[name]?.();
}
document.querySelectorAll(".ctabs [role=tab]").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.ctab)));
function refresh() { if (role !== "developer") loadTop(); loaders[current]?.(); }

/** Problems in the last 7 days (errors and security events), shown to the treasurer and developer. */
async function loadIssues() {
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const { count } = await sb.from("activity_log").select("id", { count: "exact", head: true }).in("level", ["error", "security"]).gte("at", since);
  const el = $("issueBanner");
  if (!count) { el.hidden = true; return; }
  fill(el, `${count} problem${count === 1 ? "" : "s"} in the last 7 days (errors or refused access). `, btn("Review in the activity log", () => { $("acLevel").value = "problems"; showTab("system"); }, "btn small"));
  el.hidden = false;
}

// ---------- Contributor picker (server-side search) ----------
function makePicker(p, { onChange, allowNew = true } = {}) {
  const input = $(p + "Find"), list = $(p + "Results"), chosen = $(p + "Chosen");
  let picked = null, timer, hits = [], active = -1;
  const show = () => {
    if (picked) fill(chosen, h("strong", {}, picked.full_name), ` · ${picked.public_label} · ${picked.area || "no area"}${picked.email ? " · " + picked.email : ""}`, btn("Change", () => set(null)));
    else fill(chosen, allowNew ? "New contributor" : "Search and choose a person");
  };
  const set = (c) => { picked = c; list.hidden = true; input.value = ""; show(); onChange?.(c); };
  const draw = () => fill(list, hits.map((c, i) => h("li", { role: "option", "aria-selected": String(i === active), onmousedown: (e) => { e.preventDefault(); set(c); } },
    h("strong", {}, c.full_name), ` · ${c.area || "no area"}${c.email ? " · " + c.email : ""}`)));
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = safeQ(input.value);
    if (q.length < 2) { list.hidden = true; return; }
    timer = setTimeout(async () => {
      const { data } = await sb.from("contributors").select("id, full_name, email, area, public_label")
        .or(`full_name.ilike.%${q}%,email.ilike.%${q}%,public_label.ilike.%${q}%`).order("full_name").limit(12);
      hits = data || []; active = -1;
      list.hidden = !hits.length; draw();
    }, 250);
  });
  input.addEventListener("keydown", (e) => {
    if (list.hidden) return;
    if (e.key === "ArrowDown") { active = Math.min(hits.length - 1, active + 1); draw(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { active = Math.max(0, active - 1); draw(); e.preventDefault(); }
    else if (e.key === "Enter" && active >= 0) { set(hits[active]); e.preventDefault(); }
    else if (e.key === "Escape") list.hidden = true;
  });
  input.addEventListener("blur", () => setTimeout(() => { list.hidden = true; }, 150));
  show();
  return { get: () => picked, set };
}

async function balance(cid) {
  const [p, r, f] = await Promise.all([
    sb.from("pledges").select("amount, status").eq("contributor_id", cid),
    sb.from("receipts").select("amount").eq("contributor_id", cid),
    sb.from("refunds").select("amount, kind").eq("contributor_id", cid),
  ]);
  const pledged = (p.data || []).filter((x) => !["cancelled", "withdrawn"].includes(x.status)).reduce((a, x) => a + Number(x.amount), 0);
  const received = (r.data || []).reduce((a, x) => a + Number(x.amount), 0) - (f.data || []).filter((x) => x.kind !== "closing_payout").reduce((a, x) => a + Number(x.amount), 0);
  return { pledged, received, owed: Math.max(0, pledged - received) };
}

/** Create a contributor from the "new" fields; returns the row or throws. */
async function newContributor({ full, email, address, area, label }) {
  email = (email || "").trim().toLowerCase();
  if (email && !EMAIL.test(email)) throw new Error("Enter a valid email, or leave it blank.");
  const { data, error } = await sb.from("contributors").insert({ full_name: full, email, address: address || "", area, public_label: label, offline: true }).select("id, public_label, area").single();
  if (error) throw new Error(friendly(error));
  return data;
}
async function emailAbout(kind, id) {
  const { data: { session: s } } = await sb.auth.getSession();
  const r = await fetch("/api/notify", { method: "POST", headers: { authorization: "Bearer " + s.access_token, "content-type": "application/json" }, body: JSON.stringify({ kind, id }) });
  const d = await r.json().catch(() => ({}));
  return r.ok ? d.status : "failed";
}
const emailWord = (st) => ({ sent: "A receipt was emailed.", skipped: "Email isn't set up yet, so no receipt was sent.", "no-address": "No email on file, so no receipt was sent." }[st] || "The receipt email could not be sent.");

// ---------- RECORD ----------
const plPick = makePicker("pl", { onChange: (c) => { $("plNew").hidden = !!c; } });
let rPlans = [];
const rPick = makePicker("r", { onChange: async (c) => {
  $("rNew").hidden = !!c; $("rOwed").hidden = !c; $("rAmt").value = ""; $("rPlanBox").hidden = true; rPlans = [];
  if (!c) return;
  const [b, { data: gp }] = await Promise.all([balance(c.id), sb.from("giving_plans").select("id, pledge_id, installment, frequency, payments, paid_count, status, method").eq("contributor_id", c.id)]);
  $("rOwed").textContent = b.owed > 0 ? `${c.public_label} has pledged ${fmt(b.pledged)} and paid ${fmt(b.received)}. Still owed: ${fmt(b.owed)}.` : `${c.public_label} has no unpaid pledge. This deposit will be recorded as an extra gift.`;
  if (b.owed > 0) $("rAmt").value = b.owed.toFixed(2);
  rPlans = (gp || []).filter((p) => p.method === "manual" && ["pending", "active", "past_due"].includes(p.status));
  if (rPlans.length) {
    fill($("rPlan"), h("option", { value: "" }, "Not part of a plan"), rPlans.map((p) => h("option", { value: p.id }, `${fmt(Number(p.installment))} ${FREQ[p.frequency].toLowerCase()}, payment ${p.paid_count + 1} of ${p.payments}`)));
    $("rPlan").value = rPlans[0].id; $("rAmt").value = Number(rPlans[0].installment).toFixed(2); $("rPlanBox").hidden = false;
  }
} });
$("rPlan").addEventListener("change", () => { const p = rPlans.find((x) => x.id === $("rPlan").value); if (p) $("rAmt").value = Number(p.installment).toFixed(2); });
const planTotal = () => { const t = Math.round(Number($("plInst").value) * Number($("plCount").value) * 100) / 100; if (t > 0) $("plAmt").value = t.toFixed(2); };
$("plPlan").addEventListener("change", () => { $("plPlanBox").hidden = !$("plPlan").checked; $("plAmt").readOnly = $("plPlan").checked; planTotal(); });
["plInst", "plCount"].forEach((id) => $(id).addEventListener("input", planTotal));
loaders.record = () => {};

$("plForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const btn = ev.target.querySelector('button[type="submit"]');
  const done = setBtnLoading(btn, "Saving pledge...");
  const msg = $("plMsg"), amount = Number($("plAmt").value), date = $("plDate").value;
  if (!(amount >= 1 && amount <= 2000000)) { done(false); return note(msg, "Enter a pledge between $1 and $2,000,000.", "err"); }
  if (!date) { done(false); return note(msg, "Enter the date pledged.", "err"); }
  try {
    let cid = plPick.get()?.id;
    if (!cid) {
      const full = $("plName").value.trim(), area = $("plArea").value.trim();
      if (!full || !area) { done(false); return note(msg, "Search for the person, or enter a new person's name and neighborhood.", "err"); }
      cid = (await newContributor({ full, email: $("plEmail").value, address: $("plAddr").value.trim(), area, label: publicLabel(full, $("plShow").value) })).id;
    }
    const plan = $("plPlan").checked ? { installment: Number($("plInst").value), frequency: $("plFreq").value, payments: Number($("plCount").value) } : null;
    if (plan && !(plan.installment > 0 && Number.isInteger(plan.payments) && plan.payments >= 2 && plan.payments <= 120)) throw new Error("Enter each payment and between 2 and 120 payments.");
    const { data: pl, error } = await sb.from("pledges").insert({ contributor_id: cid, amount, pledged_on: date, source: "staff",
      note: plan ? `Giving plan: ${fmt(plan.installment)} ${FREQ[plan.frequency].toLowerCase()} x ${plan.payments}` : "" }).select("id").single();
    if (error) throw new Error(friendly(error));
    if (plan) {
      const { error: e2 } = await sb.from("giving_plans").insert({ contributor_id: cid, pledge_id: pl.id, ...plan, method: "manual", start_on: date });
      if (e2) throw new Error(friendly(e2));
    }
    done(true);
    note(msg, plan ? `Giving plan saved: ${plan.payments} payments of ${fmt(plan.installment)} (${fmt(amount)}). Record each payment as a deposit; it counts toward the plan.`
      : `Pledge of ${fmt(amount)} saved. It now shows in the ledger, statistics and reports.`);
    ["plAmt", "plName", "plEmail", "plAddr", "plArea", "plInst"].forEach((id) => { $(id).value = ""; });
    $("plPlan").checked = false; $("plPlanBox").hidden = true; $("plAmt").readOnly = false;
    plPick.set(null); loadTop();
  } catch (e) { done(false); note(msg, e.message, "err"); }
});

$("rForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const btn = ev.target.querySelector('button[type="submit"]');
  const done = setBtnLoading(btn, "Saving deposit...");
  const msg = $("rMsg"), amount = Number($("rAmt").value), date = $("rDate").value;
  if (!(amount > 0 && amount <= 2000000) || !date) { done(false); return note(msg, "Enter the amount and the date received.", "err"); }
  if (date > today()) { done(false); return note(msg, "The date received can't be in the future.", "err"); }
  try {
    let c = rPick.get(), cid = c?.id || null, label = c?.public_label, area = c?.area || "";
    if (!c) {
      const full = $("rFull").value.trim();
      label = $("rLabel").value.trim() || "Anonymous neighbor"; area = $("rArea").value.trim();
      if (full) cid = (await newContributor({ full, email: $("rEmail").value, area, label })).id;
    }
    const plan = !$("rPlanBox").hidden && rPlans.find((p) => p.id === $("rPlan").value);
    const { data, error } = await sb.from("receipts").insert({ contributor_id: cid, public_label: label, area, amount, received_on: date, method: $("rMethod").value, reference: $("rNote").value.trim(), deposit_ref: $("rDep").value.trim(),
      ...(plan ? { plan_id: plan.id, pledge_id: plan.pledge_id } : {}) }).select("id").single();
    if (error) throw new Error(friendly(error));
    let extra = "";
    if ($("rEmailReceipt").checked && cid) extra = " " + emailWord(await emailAbout("receipt", data.id));
    done(true);
    note(msg, `Deposit of ${fmt(amount)} from ${label} saved and applied to any open pledge.${extra}`);
    ["rAmt", "rNote", "rLabel", "rArea", "rFull", "rEmail"].forEach((id) => { $(id).value = ""; });
    rPick.set(null); loadTop();
  } catch (e) { done(false); note(msg, e.message, "err"); }
});

$("eForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const btn = ev.target.querySelector('button[type="submit"]');
  const done = setBtnLoading(btn, "Saving expense...");
  const msg = $("eMsg"), amount = Number($("eAmt").value), payee = $("ePayee").value.trim();
  if (!(amount > 0) || !payee || !$("eDate").value) { done(false); return note(msg, "Enter the date, amount and who was paid.", "err"); }
  const status = $("eStatus").value;
  const { error } = await sb.from("expenses").insert({ spent_on: $("eDate").value, amount, payee, category: $("eCat").value, status, paid_on: status === "paid" ? $("eDate").value : null, description: $("eDesc").value.trim() });
  if (error) { done(false); return note(msg, friendly(error), "err"); }
  done(true);
  note(msg, `Expense of ${fmt(amount)} to ${payee} saved.`);
  ["eAmt", "ePayee", "eDesc"].forEach((id) => { $(id).value = ""; });
  loadTop();
});

// ---------- PLEDGES ----------
let pgPage = 0;
loaders.pledges = async (page = pgPage) => {
  pgPage = Math.max(0, page);
  let q = sb.from("pledges").select("*, contributors!inner(full_name, email, public_label, area)", { count: "exact" });
  const st = $("pgStatus").value, s = safeQ($("pgSearch").value);
  if (st) q = q.eq("status", st);
  if (s) q = q.or(`full_name.ilike.%${s}%,email.ilike.%${s}%`, { referencedTable: "contributors" });
  const { data, count, error } = await q.order("pledged_on", { ascending: false }).order("created_at", { ascending: false }).range(pgPage * PAGE, pgPage * PAGE + PAGE - 1);
  if (error) return note($("status"), friendly(error), "err");
  fill($("pledgeRows"), data.length ? data.map(pledgeRow) : emptyRow(7, "No pledges match."));
  pager($("pledgePager"), pgPage, count || 0, (p) => loaders.pledges(p));
  loadPlans();
};
function pledgeRow(p) {
  const c = p.contributors || {};
  const statusCls = { paid: "ok", partial: "partial", open: "pend", withdrawn: "withdrawn", cancelled: "cancelled" }[p.status];
  const actions = h("td", { class: "r" });
  if (can("treasurer")) {
    if (["open", "partial", "paid"].includes(p.status)) actions.append(btn("Edit", () => editPledge(actions, p)), btn("Withdraw", (e) => confirmAct(e.currentTarget, "Mark withdrawn?", () => sb.from("pledges").update({ status: "withdrawn" }).eq("id", p.id))),
      btn("Cancel", (e) => confirmAct(e.currentTarget, "Cancel this pledge?", () => sb.from("pledges").update({ status: "cancelled" }).eq("id", p.id))));
    else actions.append(btn("Reinstate", (e) => confirmAct(e.currentTarget, "Reinstate?", () => sb.from("pledges").update({ status: "open" }).eq("id", p.id))));
  }
  return h("tr", {}, h("td", { class: "num" }, p.pledged_on), h("td", {}, c.full_name || "—", h("div", { class: "hint" }, c.public_label || "")), h("td", {}, c.area || ""),
    h("td", { class: "r num" }, fmt(Number(p.amount))), h("td", {}, h("span", { class: "pill " + statusCls }, p.status), p.note ? h("div", { class: "hint" }, p.note) : null),
    h("td", { class: "hint" }, p.source === "website" ? "Website" : who(p.created_by)), actions);
}
function editPledge(cell, p) {
  const amt = h("input", { type: "number", min: "1", max: "2000000", step: "0.01", value: p.amount, "aria-label": "Pledge amount" });
  const day = h("input", { type: "date", value: p.pledged_on, "aria-label": "Date pledged" });
  const nt = h("input", { maxlength: "160", value: p.note || "", placeholder: "Note", "aria-label": "Note" });
  fill(cell, h("div", { class: "edit-inline" }, amt, day, nt, btn("Save", async () => {
    const a = Number(amt.value);
    if (!(a >= 1 && a <= 2000000)) return note($("status"), "Enter a pledge between $1 and $2,000,000.", "err");
    const { error } = await sb.from("pledges").update({ amount: a, pledged_on: day.value, note: nt.value.trim() }).eq("id", p.id);
    if (error) note($("status"), friendly(error), "err"); else $("status").hidden = true;
    refresh();
  }, "btn small"), btn("Cancel", () => refresh())));
}
$("pgStatus").addEventListener("change", () => loaders.pledges(0));
let gpPage = 0;
async function loadPlans(page = gpPage) {
  gpPage = Math.max(0, page);
  let q = sb.from("giving_plans").select("*, contributors(full_name, public_label, area)", { count: "exact" });
  if ($("gpStatus").value) q = q.eq("status", $("gpStatus").value);
  const { data, count, error } = await q.order("created_at", { ascending: false }).range(gpPage * PAGE, gpPage * PAGE + PAGE - 1);
  if (error) return note($("status"), friendly(error), "err");
  fill($("gplanRows"), data.length ? data.map((p) => {
    const c = p.contributors || {}, [label, cls] = PLAN_STATUS[p.status] || [p.status, "pend"];
    const acts = h("td", { class: "r" });
    if (can("treasurer") && ["pending", "active", "past_due"].includes(p.status)) acts.append(btn("Stop plan", (e) => confirmAct(e.currentTarget, "Stop all future payments?", async () => {
      try { await api("/api/plan", "POST", { planId: p.id, reason: "Stopped by the treasurer" }); return {}; } catch (err) { return { error: err }; }
    }, () => loaders.pledges())));
    return h("tr", {}, h("td", { class: "num" }, p.start_on), h("td", {}, c.full_name || "—", h("div", { class: "hint" }, `${c.public_label || ""}${p.method === "manual" ? " · paid by hand" : " · card"}`)),
      h("td", { class: "r num" }, fmt(Number(p.installment))), h("td", {}, FREQ[p.frequency] || p.frequency),
      h("td", { class: "num" }, `${p.paid_count} of ${p.payments}`, h("div", { class: "hint" }, fmt(Number(p.paid_total || 0)))), h("td", { class: "num" }, nextDue(p)),
      h("td", {}, h("span", { class: "pill " + cls }, label), p.cancel_reason ? h("div", { class: "hint" }, p.cancel_reason) : null), acts);
  }) : emptyRow(8, "No giving plans yet."));
  pager($("gplanPager"), gpPage, count || 0, loadPlans);
}
$("gpStatus").addEventListener("change", () => loadPlans(0));
let pgT; $("pgSearch").addEventListener("input", () => { clearTimeout(pgT); pgT = setTimeout(() => loaders.pledges(0), 300); });

// ---------- MONEY ----------
let dpPage = 0, rfPage = 0, exPage = 0, refundTarget = null;
loaders.money = async () => { await Promise.all([loadDeposits(dpPage), loadRefunds(rfPage), loadExpenses(exPage)]); };
async function loadDeposits(page = 0) {
  dpPage = Math.max(0, page);
  let q = sb.from("receipts").select("*", { count: "exact" });
  const m = $("mgMethod").value, s = safeQ($("mgSearch").value);
  if (m) q = q.eq("method", m);
  if (s) q = q.or(`public_label.ilike.%${s}%,reference.ilike.%${s}%,deposit_ref.ilike.%${s}%`);
  const { data, count, error } = await q.order("received_on", { ascending: false }).order("created_at", { ascending: false }).range(dpPage * PAGE, dpPage * PAGE + PAGE - 1);
  if (error) return note($("status"), friendly(error), "err");
  fill($("depositRows"), data.length ? data.map((r) => {
    const acts = h("td", { class: "r" });
    if (r.contributor_id && can("recorder")) acts.append(btn("Email receipt", async (e) => { e.currentTarget.disabled = true; note($("status"), emailWord(await emailAbout("receipt", r.id)), ""); }));
    if (can("treasurer")) acts.append(btn("Refund", () => openRefund(r)), btn("Delete", (e) => confirmAct(e.currentTarget, "Delete this deposit?", () => sb.from("receipts").delete().eq("id", r.id))));
    return h("tr", {}, h("td", { class: "num" }, r.received_on), h("td", {}, r.public_label, h("div", { class: "hint" }, r.area)),
      h("td", {}, r.method, r.disputed ? [" ", h("span", { class: "pill due" }, "Disputed")] : null),
      h("td", { class: "hint" }, [r.reference, r.deposit_ref && "slip " + r.deposit_ref].filter(Boolean).join(" · ")),
      h("td", { class: "r num" }, fmt(Number(r.amount))), h("td", { class: "hint" }, who(r.created_by)), acts);
  }) : emptyRow(7, "No deposits match."));
  pager($("depositPager"), dpPage, count || 0, loadDeposits);
}
$("mgMethod").addEventListener("change", () => loadDeposits(0));
let mgT; $("mgSearch").addEventListener("input", () => { clearTimeout(mgT); mgT = setTimeout(() => loadDeposits(0), 300); });

async function openRefund(r) {
  refundTarget = r;
  const { data: prior } = await sb.from("refunds").select("amount, kind").eq("receipt_id", r.id);
  const left = Number(r.amount) - (prior || []).filter((x) => x.kind !== "closing_payout").reduce((a, x) => a + Number(x.amount), 0);
  refundTarget.left = Math.round(left * 100) / 100;
  const card = r.method === "Online (Stripe)";
  $("rfTitle").textContent = `Refund ${r.public_label} (${fmt(Number(r.amount))} on ${r.received_on}; up to ${fmt(refundTarget.left)} left)`;
  $("rfAmt").value = refundTarget.left.toFixed(2); $("rfAmt").max = refundTarget.left;
  $("rfMethod").disabled = card;
  if (card) fill($("rfMethod"), h("option", {}, "Back to the card (Stripe)")); else fill($("rfMethod"), ["Check", "Zelle", "Cash", "Bank transfer", "Other"].map((m) => h("option", {}, m)));
  $("rfMsg").hidden = true; $("rfForm").hidden = false; $("rfAmt").focus();
}
$("rfCancel").addEventListener("click", () => { $("rfForm").hidden = true; });
$("rfForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const btn = ev.target.querySelector('button[type="submit"]');
  const done = setBtnLoading(btn, "Issuing refund...");
  const r = refundTarget, msg = $("rfMsg"), amount = Math.round(Number($("rfAmt").value) * 100) / 100, reason = $("rfReason").value.trim();
  if (!r || !(amount > 0) || amount > r.left) { done(false); return note(msg, `Enter an amount up to ${fmt(r?.left || 0)}.`, "err"); }
  if (r.method === "Online (Stripe)") {
    const { data: { session: s } } = await sb.auth.getSession();
    const res = await fetch("/api/refund", { method: "POST", headers: { authorization: "Bearer " + s.access_token, "content-type": "application/json" }, body: JSON.stringify({ receiptId: r.id, amount, reason }) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { done(false); return note(msg, d.error || "The refund could not be made.", "err"); }
  } else {
    const { data, error } = await sb.from("refunds").insert({ receipt_id: r.id, contributor_id: r.contributor_id, public_label: r.public_label, area: r.area, amount, kind: "refund", method: $("rfMethod").value, reason }).select("id").single();
    if (error) { done(false); return note(msg, friendly(error), "err"); }
    if (r.contributor_id) await emailAbout("refund", data.id);
  }
  done(true);
  $("rfForm").hidden = true; note($("status"), `Refund of ${fmt(amount)} to ${r.public_label} recorded.`, "");
  refresh();
});

async function loadRefunds(page = 0) {
  rfPage = Math.max(0, page);
  const { data, count, error } = await sb.from("refunds").select("*", { count: "exact" }).order("refunded_on", { ascending: false }).order("created_at", { ascending: false }).range(rfPage * PAGE, rfPage * PAGE + PAGE - 1);
  if (error) return note($("status"), friendly(error), "err");
  fill($("refundRows"), data.length ? data.map((f) => h("tr", {}, h("td", { class: "num" }, f.refunded_on), h("td", {}, f.public_label), h("td", {}, h("span", { class: "pill kind-" + f.kind }, KIND[f.kind])),
    h("td", {}, f.method), h("td", { class: "hint" }, f.reason), h("td", { class: "r num" }, fmt(-Number(f.amount))), h("td", { class: "hint" }, who(f.created_by)),
    h("td", { class: "r" }, can("treasurer") && !f.stripe_ref ? btn("Delete", (e) => confirmAct(e.currentTarget, "Delete?", () => sb.from("refunds").delete().eq("id", f.id))) : null)))
    : emptyRow(8, "No refunds, chargebacks or payouts."));
  pager($("refundPager"), rfPage, count || 0, loadRefunds);
}
async function loadExpenses(page = 0) {
  exPage = Math.max(0, page);
  const { data, count, error } = await sb.from("expenses").select("*", { count: "exact" }).order("spent_on", { ascending: false }).order("created_at", { ascending: false }).range(exPage * PAGE, exPage * PAGE + PAGE - 1);
  if (error) return note($("status"), friendly(error), "err");
  fill($("expenseRows"), data.length ? data.map((e) => h("tr", {}, h("td", { class: "num" }, e.spent_on), h("td", {}, e.payee, e.description ? h("div", { class: "hint" }, e.description) : null), h("td", {}, e.category),
    h("td", {}, h("span", { class: e.status === "unpaid" ? "pill due" : "pill ok" }, e.status === "unpaid" ? "Unpaid" : "Paid")), h("td", { class: "r num" }, fmt(Number(e.amount))), h("td", { class: "hint" }, who(e.created_by)),
    h("td", { class: "r" }, can("treasurer") ? [e.status === "unpaid" ? btn("Mark paid", (ev) => confirmAct(ev.currentTarget, "Mark paid?", () => sb.from("expenses").update({ status: "paid", paid_on: today() }).eq("id", e.id))) : null,
      !e.stripe_ref ? btn("Delete", (ev) => confirmAct(ev.currentTarget, "Delete?", () => sb.from("expenses").delete().eq("id", e.id))) : null] : null)))
    : emptyRow(7, "No expenses yet."));
  pager($("expensePager"), exPage, count || 0, loadExpenses);
}

// ---------- PEOPLE ----------
let ppPage = 0, editing = null, mergeFrom = null;
loaders.people = async (page = ppPage) => {
  ppPage = Math.max(0, page);
  let q = sb.from("contributors").select("*", { count: "exact" });
  const s = safeQ($("ppSearch").value);
  if (s) q = q.or(`full_name.ilike.%${s}%,email.ilike.%${s}%,area.ilike.%${s}%,public_label.ilike.%${s}%`);
  const { data, count, error } = await q.order("full_name").range(ppPage * PAGE, ppPage * PAGE + PAGE - 1);
  if (error) return note($("status"), friendly(error), "err");
  fill($("peopleRows"), data.length ? data.map((c) => h("tr", {}, h("td", {}, c.full_name), h("td", {}, c.email), h("td", {}, c.address), h("td", {}, c.area), h("td", {}, c.public_label),
    h("td", { class: "r" }, can("treasurer") && c.full_name !== "[erased]" ? [btn("Edit", () => openEdit(c)), btn("Combine", () => openMerge(c)),
      btn("Erase", (e) => confirmAct(e.currentTarget, "Erase this person's details for good?", () => sb.rpc("anonymize_contributor", { cid: c.id })))] : null)))
    : emptyRow(6, "No contributors match."));
  pager($("peoplePager"), ppPage, count || 0, (p) => loaders.people(p));
};
let ppT; $("ppSearch").addEventListener("input", () => { clearTimeout(ppT); ppT = setTimeout(() => loaders.people(0), 300); });
function openEdit(c) {
  editing = c; $("mForm").hidden = true;
  $("cName").value = c.full_name; $("cEmail").value = c.email; $("cAddr").value = c.address; $("cArea").value = c.area; $("cLabel").value = c.public_label;
  $("cMsg").hidden = true; $("cForm").hidden = false; $("cName").focus();
}
$("cCancel").addEventListener("click", () => { $("cForm").hidden = true; });
$("cForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const btn = ev.target.querySelector('button[type="submit"]');
  const done = setBtnLoading(btn, "Updating...");
  const email = $("cEmail").value.trim().toLowerCase();
  if (!$("cName").value.trim() || !$("cLabel").value.trim()) { done(false); return note($("cMsg"), "Name and public label are required.", "err"); }
  if (email && !EMAIL.test(email)) { done(false); return note($("cMsg"), "Enter a valid email, or leave it blank.", "err"); }
  const { error } = await sb.from("contributors").update({ full_name: $("cName").value.trim(), email, address: $("cAddr").value.trim(), area: $("cArea").value.trim(), public_label: $("cLabel").value.trim() }).eq("id", editing.id);
  if (error) { done(false); return note($("cMsg"), friendly(error), "err"); }
  done(true);
  $("cForm").hidden = true; note($("status"), "Contributor updated. Public ledger lines now use the new label.", ""); refresh();
});
const mPick = makePicker("m", { allowNew: false });
function openMerge(c) {
  mergeFrom = c; $("cForm").hidden = true; mPick.set(null);
  $("mTitle").textContent = `Combine "${c.full_name}" into another record`;
  $("mMsg").hidden = true; $("mForm").hidden = false; $("mFind").focus();
}
$("mCancel").addEventListener("click", () => { $("mForm").hidden = true; });
$("mForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const btn = ev.target.querySelector('button[type="submit"]');
  const done = setBtnLoading(btn, "Combining...");
  const dst = mPick.get();
  if (!dst || dst.id === mergeFrom.id) { done(false); return note($("mMsg"), "Choose a different person to keep.", "err"); }
  const { error } = await sb.rpc("merge_contributors", { src: mergeFrom.id, dst: dst.id });
  if (error) { done(false); return note($("mMsg"), friendly(error), "err"); }
  done(true);
  $("mForm").hidden = true; note($("status"), `Combined into ${dst.full_name}. All pledges and money moved.`, ""); refresh();
});

// ---------- CLOSING ----------
let plan = [];
loaders.closing = async () => {
  const [t, { data, error }] = await Promise.all([loadTop(), sb.rpc("closing_plan")]);
  if (error) return note($("status"), friendly(error), "err");
  plan = data || [];
  const st = settings?.fund_status || "open";
  $("clStatus").textContent = { open: "Open", closing: "Closing", closed: "Closed" }[st];
  $("clPool").textContent = fmt(Number(t?.closingPool || 0)); $("clPaid").textContent = fmt(Number(t?.payouts || 0));
  $("clNote").value = settings?.closing_note || "";
  $("clStart").hidden = st !== "open"; $("clFinish").hidden = st !== "closing"; $("clReopen").hidden = st === "open";
  const unpaid = Number(t?.expensesUnpaid || 0);
  note($("clMsg"), unpaid > 0 ? `There are ${fmt(unpaid)} of unpaid bills. Pay them before making payouts so the plan doesn't change.` : "", "warn");
  const remaining = plan.reduce((a, r) => a + Number(r.remaining), 0);
  $("planNote").textContent = plan.length ? `${plan.length} contributors · ${fmt(plan.reduce((a, r) => a + Number(r.due), 0))} due in total · ${fmt(remaining)} still to pay. Anonymous gifts with no contact details can't be returned and stay with the fund.` : "";
  fill($("planRows"), plan.length ? plan.map((r) => {
    const cell = h("td", { class: "r" });
    if (can("treasurer") && st !== "open" && Number(r.remaining) > 0 && r.contributor_id) {
      const m = h("select", { "aria-label": "Payout method" }, ["Check", "Zelle", "Bank transfer", "Cash", "Other"].map((x) => h("option", {}, x)));
      cell.append(h("div", { class: "edit-inline" }, m, btn("Record payout", async (e) => {
        e.currentTarget.disabled = true;
        const { data: row, error: err } = await sb.from("refunds").insert({ contributor_id: r.contributor_id, public_label: r.label, area: r.area, amount: Number(r.remaining), kind: "closing_payout", method: m.value, reason: "Final distribution" }).select("id").single();
        if (err) return note($("status"), friendly(err), "err");
        await emailAbout("payout", row.id);
        loaders.closing();
      }, "btn small")));
    }
    return h("tr", {}, h("td", {}, r.full_name || r.label, h("div", { class: "hint" }, r.area)), h("td", {}, r.email || "—"), h("td", { class: "r num" }, fmt(Number(r.contributed))),
      h("td", { class: "r num" }, (Number(r.share) * 100).toFixed(2) + "%"), h("td", { class: "r num" }, fmt(Number(r.due))), h("td", { class: "r num" }, fmt(Number(r.paid_out))),
      h("td", { class: "r num" }, fmt(Number(r.remaining))), cell);
  }) : emptyRow(8, "Nobody has contributed yet."));
};
const setStatus = async (fund_status, extra = {}) => {
  const { error } = await sb.from("settings").update({ fund_status, closing_note: $("clNote").value.trim(), updated_at: new Date().toISOString(), ...extra }).eq("id", 1);
  if (error) note($("status"), friendly(error), "err"); else $("status").hidden = true;
  loaders.closing();
};
$("clStart").addEventListener("click", (e) => confirmAct(e.currentTarget, "Stop accepting new pledges?", () => setStatus("closing"), () => {}));
$("clFinish").addEventListener("click", (e) => confirmAct(e.currentTarget, "Mark the fund closed?", () => setStatus("closed", { closed_on: today(), accept_online: false }), () => {}));
$("clReopen").addEventListener("click", (e) => confirmAct(e.currentTarget, "Reopen the fund?", () => setStatus("open", { closed_on: null }), () => {}));
$("clCsv").addEventListener("click", () => csvDownload(`payout-plan-${today()}.csv`, [["contributor", "email", "area", "contributed", "share_percent", "due", "paid_out", "remaining"],
  ...plan.map((r) => [r.full_name || r.label, r.email || "", r.area, Number(r.contributed), Number((Number(r.share) * 100).toFixed(4)), Number(r.due), Number(r.paid_out), Number(r.remaining)])]));

// ---------- UPDATES (news) ----------
let editingPost = null;
const slugify = (t) => String(t).toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-").slice(0, 80).replace(/^-|-$/g, "");
loaders.news = async () => {
  const { data, error } = await sb.from("posts").select("*").order("published_on", { ascending: false });
  if (error) return note($("status"), friendly(error), "err");
  fill($("newsRows"), data.length ? data.map((p) => h("tr", {}, h("td", { class: "num" }, p.published_on), h("td", {}, p.title), h("td", {}, h("span", { class: p.published ? "pill ok" : "pill pend" }, p.published ? "Published" : "Draft")),
    h("td", { class: "r" }, btn("Edit", () => editPost(p)), btn("Delete", (e) => confirmAct(e.currentTarget, "Delete?", () => sb.from("posts").delete().eq("id", p.id)))))) : emptyRow(4, "No updates yet."));
};
function editPost(p) {
  editingPost = p;
  $("nTitle").textContent = p ? "Edit update" : "New update";
  $("nHead").value = p?.title || ""; $("nSlug").value = p?.slug || ""; $("nDate").value = p?.published_on || today();
  $("nSummary").value = p?.summary || ""; $("nBody").value = p?.body || ""; $("nPub").checked = !!p?.published; $("nMsg").hidden = true;
}
$("nNew").addEventListener("click", () => editPost(null));
$("nHead").addEventListener("input", () => { if (!editingPost) $("nSlug").value = slugify($("nHead").value); });
$("nForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const btn = ev.target.querySelector('button[type="submit"]');
  const done = setBtnLoading(btn, "Saving post...");
  const title = $("nHead").value.trim(), slug = slugify($("nSlug").value || title);
  if (title.length < 3) { done(false); return note($("nMsg"), "Give the update a title.", "err"); }
  if (!slug) { done(false); return note($("nMsg"), "Give the update a web address (letters and numbers).", "err"); }
  const row = { title, slug, published_on: $("nDate").value || today(), summary: $("nSummary").value.trim(), body: $("nBody").value, published: $("nPub").checked, updated_at: new Date().toISOString() };
  const { error } = editingPost ? await sb.from("posts").update(row).eq("id", editingPost.id) : await sb.from("posts").insert(row);
  if (error) { done(false); return note($("nMsg"), /duplicate|unique/i.test(error.message) ? "Another update already uses that web address." : friendly(error), "err"); }
  done(true);
  note($("nMsg"), row.published ? "Saved and published. It appears on the Updates page within a minute." : "Saved as a draft.");
  editPost(null); loaders.news();
});

// ---------- AUDIT AND EXPORTS ----------
let auPage = 0;
const LABEL = { receipts: "Deposits", pledges: "Pledges", refunds: "Refunds and payouts", expenses: "Expenses", contributors: "Contributors", settings: "Settings", admins: "Team", posts: "Updates" };
function summary(x) {
  if (x.op === "ERASE") return "Personal details erased on request";
  const o = x.old_row || {}, n = x.new_row || {};
  if (x.op === "INSERT") return ["amount", "public_label", "full_name", "title", "payee", "status", "role"].filter((k) => n[k] != null).map((k) => `${k.replace("_", " ")}: ${n[k]}`).join(" · ");
  if (x.op === "DELETE") return ["amount", "public_label", "full_name", "title", "payee"].filter((k) => o[k] != null).map((k) => `${k.replace("_", " ")}: ${o[k]}`).join(" · ");
  return Object.keys(n).filter((k) => !["updated_at", "created_at"].includes(k) && JSON.stringify(o[k]) !== JSON.stringify(n[k])).map((k) => `${k.replace("_", " ")}: ${o[k] ?? "—"} → ${n[k] ?? "—"}`).join(" · ").slice(0, 300);
}
async function checkIntegrity() {
  const el = $("auIntegrity");
  const { data: v, error } = await sb.rpc("audit_verify");
  if (error || !v) return note(el, "The integrity check could not run.", "warn");
  note(el, v.ok ? `Integrity verified: all ${Number(v.checked).toLocaleString()} entries are intact${v.erased ? ` (${v.erased} with personal details erased on request)` : ""}.`
    : `Warning: the audit log has been tampered with at entry ${v.firstBadId}. ${v.reason}. Tell the board and keep a copy of the latest export.`, v.ok ? "" : "err");
}
loaders.records = async (page = auPage) => {
  if (page === 0 || auPage === 0) checkIntegrity();
  auPage = Math.max(0, page);
  let q = sb.from("audit_log").select("*", { count: "exact" });
  if ($("auTable").value) q = q.eq("table_name", $("auTable").value);
  if ($("auOp").value) q = q.eq("op", $("auOp").value);
  const { data, count, error } = await q.order("at", { ascending: false }).range(auPage * PAGE, auPage * PAGE + PAGE - 1);
  if (error) return note($("status"), friendly(error), "err");
  fill($("auditRows"), data.length ? data.map((x) => h("tr", {}, h("td", { class: "num" }, new Date(x.at).toLocaleString()), h("td", {}, who(x.actor)), h("td", {}, LABEL[x.table_name] || x.table_name),
    h("td", {}, { INSERT: "Added", UPDATE: "Changed", DELETE: "Deleted", ERASE: "Erased" }[x.op] || x.op), h("td", { class: "hint" }, summary(x)))) : emptyRow(5, "No changes match."));
  pager($("auditPager"), auPage, count || 0, (p) => loaders.records(p));
};
$("auTable").addEventListener("change", () => loaders.records(0));
$("auOp").addEventListener("change", () => loaders.records(0));

const EXPORTS = {
  journal: async () => [["date", "entry", "account", "debit", "credit", "memo", "ref"], ...(await fetchAll(() => sb.rpc("export_journal"))).map((r) => [r.entry_date, r.entry, r.account, Number(r.debit), Number(r.credit), r.memo, r.ref])],
  receipts: async () => [["date", "public_label", "area", "method", "amount", "reference", "deposit_slip", "disputed", "contributor_id", "entered_by", "id"],
    ...(await fetchAll(() => sb.from("receipts").select("*").order("received_on").order("id"))).map((r) => [r.received_on, r.public_label, r.area, r.method, Number(r.amount), r.reference, r.deposit_ref, r.disputed ? "yes" : "no", r.contributor_id || "", who(r.created_by), r.id])],
  refunds: async () => [["date", "type", "public_label", "area", "method", "reason", "amount", "receipt_id", "contributor_id", "entered_by", "id"],
    ...(await fetchAll(() => sb.from("refunds").select("*").order("refunded_on").order("id"))).map((r) => [r.refunded_on, KIND[r.kind], r.public_label, r.area, r.method, r.reason, Number(r.amount), r.receipt_id || "", r.contributor_id || "", who(r.created_by), r.id])],
  expenses: async () => [["date", "payee", "category", "description", "status", "paid_on", "amount", "entered_by", "id"],
    ...(await fetchAll(() => sb.from("expenses").select("*").order("spent_on").order("id"))).map((e) => [e.spent_on, e.payee, e.category, e.description, e.status, e.paid_on || "", Number(e.amount), who(e.created_by), e.id])],
  pledges: async () => [["date", "contributor", "email", "area", "amount", "status", "source", "note", "entered_by", "id"],
    ...(await fetchAll(() => sb.from("pledges").select("*, contributors(full_name, email, area)").order("pledged_on").order("id"))).map((p) => [p.pledged_on, p.contributors?.full_name, p.contributors?.email, p.contributors?.area, Number(p.amount), p.status, p.source, p.note, p.source === "website" ? "Website" : who(p.created_by), p.id])],
  contributors: async () => [["name", "email", "address", "area", "public_label", "created", "id"],
    ...(await fetchAll(() => sb.from("contributors").select("*").order("full_name").order("id"))).map((c) => [c.full_name, c.email, c.address, c.area, c.public_label, String(c.created_at).slice(0, 10), c.id])],
  audit: async () => [["when", "who", "area", "change", "details", "row_id"],
    ...(await fetchAll(() => sb.from("audit_log").select("*").order("at").order("id"))).map((x) => [x.at, who(x.actor), LABEL[x.table_name] || x.table_name, x.op, summary(x), x.row_id])],
  emails: async () => [["when", "kind", "to", "status", "error"],
    ...(await fetchAll(() => sb.from("email_log").select("*").order("at").order("id"))).map((x) => [x.at, x.kind, x.to_email, x.status, x.error || ""])],
  activity: async () => [["when", "who", "role", "action", "level", "path", "details", "ip_fingerprint", "id"],
    ...(await fetchAll(() => sb.from("activity_log").select("*").order("id"))).map((x) => [x.at, x.actor_label || (x.actor ? "staff" : "website / server"), x.role, x.action, x.level, x.path, JSON.stringify(x.detail || {}), x.ip_hash, x.id])],
};
document.querySelectorAll("[data-export]").forEach((b) => b.addEventListener("click", async () => {
  const k = b.dataset.export, m = $(b.dataset.msg || "xMsg"); b.disabled = true; note(m, "Preparing the file…");
  try {
    const rows = await EXPORTS[k]();
    csvDownload(`${k}${k === "contributors" ? "-PRIVATE" : ""}-${today()}.csv`, rows);
    note(m, `Downloaded ${(rows.length - 1).toLocaleString()} rows.`);
    logAct("client.export", { file: k, rows: String(rows.length - 1) });
  } catch (e) { note(m, friendly(e), "err"); }
  b.disabled = false;
}));

// ---------- TEAM (treasurer only, through /api/staff) ----------
async function staffApi(method, body) {
  const { data: { session: s } } = await sb.auth.getSession();
  const r = await fetch("/api/staff", { method, headers: { authorization: "Bearer " + s.access_token, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || "Could not update the team.");
  return d;
}
const patchStaff = (body) => async () => { try { await staffApi("PATCH", body); return {}; } catch (e) { return { error: e }; } };
loaders.team = async () => {
  try {
    const d = await staffApi("GET");
    $("seatNote").textContent = `· ${d.seatsUsed} of ${d.seats} seats used`;
    fill($("teamRows"), d.staff.map((m) => {
      const dev = m.role === "developer";
      const status = dev ? (m.active ? `Access until ${new Date(m.accessExpiresAt).toLocaleString()}` : m.expired ? "Access ended" : "Removed") : (m.active ? "Active" : "Inactive");
      const acts = m.userId === session.user.id ? h("span", { class: "hint" }, "You")
        : dev ? [m.active ? btn("Remove access now", (ev) => confirmAct(ev.currentTarget, "Remove the developer's access now?", patchStaff({ userId: m.userId, active: false }), () => loaders.team()), "btn small danger") : null,
            btn(m.active ? "Extend 7 days" : "Give 7 more days", (ev) => confirmAct(ev.currentTarget, "Allow access for 7 days from now?", patchStaff({ userId: m.userId, extendDays: 7 }), () => loaders.team()))]
        : btn(m.active ? "Deactivate" : "Reactivate", (ev) => confirmAct(ev.currentTarget, m.active ? "Deactivate?" : "Reactivate?", patchStaff({ userId: m.userId, active: !m.active }), () => loaders.team()));
      return h("tr", {}, h("td", {}, m.displayName || "—"), h("td", {}, m.email), h("td", {}, h("span", { class: "pill role-" + m.role }, m.role)),
        h("td", { class: "hint" }, m.lastSignIn ? new Date(m.lastSignIn).toLocaleDateString() : "Never"),
        h("td", {}, status, dev && m.purpose ? h("div", { class: "hint" }, "Issue: " + m.purpose) : null), h("td", { class: "r" }, acts));
    }));
  } catch (e) { note($("tMsg"), e.message, "err"); }
};
$("tRole").addEventListener("change", () => { const dev = $("tRole").value === "developer"; $("tDevBox").hidden = !dev; $("tAdd").textContent = dev ? "Invite developer" : "Add team member"; });
$("tForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const btn = ev.target.querySelector('button[type="submit"]');
  const done = setBtnLoading(btn, "Saving...");
  try {
    const dev = $("tRole").value === "developer";
    const r = await staffApi("POST", { email: $("tEmail").value.trim(), displayName: $("tName").value.trim(), role: $("tRole").value,
      ...(dev ? { days: Number($("tDays").value), purpose: $("tPurpose").value.trim() } : {}) });
    done(true);
    note($("tMsg"), dev ? `Developer invited until ${new Date(r.accessExpiresAt).toLocaleString()}. They see system checks and the activity log only, and you can remove them at any time.`
      : "Added. They can now sign in at /admin/ with a code sent to their email.");
    $("tEmail").value = ""; $("tName").value = ""; $("tPurpose").value = "";
    loaders.team();
  } catch (e) { done(false); note($("tMsg"), e.message, "err"); }
});

// ---------- SETTINGS ----------
async function loadAreas() {
  const { data, error } = await sb.rpc("area_counts");
  if (error) return note($("aMsg"), friendly(error), "err");
  fill($("areaRows"), (data || []).length ? data.map((a) => {
    const inp = h("input", { list: "areasA", maxlength: "60", value: a.area, "aria-label": `New name for ${a.area}` });
    return h("tr", {}, h("td", {}, a.area), h("td", { class: "r num" }, Number(a.contributors)), h("td", { class: "r num" }, Number(a.receipts)),
      h("td", {}, h("div", { class: "edit-inline" }, inp, btn("Apply", async () => {
        if (!inp.value.trim() || inp.value.trim() === a.area) return;
        const { data: n, error: err } = await sb.rpc("rename_area", { old_name: a.area, new_name: inp.value.trim() });
        if (err) return note($("aMsg"), friendly(err), "err");
        note($("aMsg"), `Renamed "${a.area}" on ${n} entries. Future entries using that name will follow.`);
        loadAreas(); loadTop();
      }, "btn small"))));
  }) : emptyRow(4, "No neighborhoods recorded yet."));
}
function goalRow(m = { amount: "", title: "", desc: "" }) {
  const n = $("goalRows").children.length + 1;
  return h("tr", {}, h("td", {}, h("input", { type: "number", min: "1", step: "1", value: m.amount, "aria-label": `Goal ${n} amount`, class: "g-amt" })),
    h("td", {}, h("input", { maxlength: "80", value: m.title, "aria-label": `Goal ${n} title`, class: "g-title" })),
    h("td", {}, h("input", { maxlength: "200", value: m.desc || "", "aria-label": `Goal ${n} description`, class: "g-desc" })),
    h("td", { class: "r" }, btn("Remove", (e) => { e.currentTarget.closest("tr").remove(); $("sForm").dataset.touched = "1"; })));
}
$("goalAdd").addEventListener("click", () => { $("goalRows").append(goalRow()); $("sForm").dataset.touched = "1"; });
loaders.settings = async () => {
  loadAreas();
  await loadTop();
  if (!settings || $("sForm").dataset.touched) return;
  $("sOrg").value = settings.org_name; $("sReg").value = settings.fdacs_reg; $("sGfm").value = settings.gofundme_url;
  $("sOnline").checked = settings.accept_online;
  fill($("goalRows"), []); (settings.milestones || []).forEach((m) => $("goalRows").append(goalRow(m)));
  $("sMin").value = Number(settings.min_gift ?? 5); $("sMax").value = Number(settings.max_gift ?? 10000);
  $("sMaxPledge").value = Number(settings.max_pledge ?? 2000000); $("sMaxDep").value = Number(settings.max_deposit ?? 250000);
  $("sPlans").checked = settings.allow_plans !== false; $("sPlanMax").value = settings.max_plan_payments ?? 24;
  $("sAmounts").value = (settings.suggested_amounts || [25, 50, 100, 250, 500, 1000]).join(", ");
  $("sPrompts").checked = settings.prompts_enabled !== false; $("sHeadline").value = settings.prompt_headline || ""; $("sDeadline").value = settings.goal_deadline || "";
};
$("sForm").addEventListener("input", () => { $("sForm").dataset.touched = "1"; });
$("sForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const btn = ev.target.querySelector('button[type="submit"]');
  const done = setBtnLoading(btn, "Saving settings...");
  const msg = $("sMsg"), gfm = $("sGfm").value.trim();
  if (gfm && !/^https:\/\//i.test(gfm)) { done(false); return note(msg, "The GoFundMe link must start with https://", "err"); }
  const ms = [...$("goalRows").children].map((tr) => ({ amount: Number(String(tr.querySelector(".g-amt").value).replace(/[$,]/g, "")),
    title: tr.querySelector(".g-title").value.trim(), desc: tr.querySelector(".g-desc").value.trim() })).filter((m) => m.amount || m.title);
  if (!ms.length || ms.some((m) => !(m.amount > 0) || !m.title)) { done(false); return note(msg, "Each goal needs an amount and a title.", "err"); }
  if (ms.length > 10) { done(false); return note(msg, "Up to 10 goals.", "err"); }
  const lim = { min_gift: Number($("sMin").value), max_gift: Number($("sMax").value), max_pledge: Number($("sMaxPledge").value), max_deposit: Number($("sMaxDep").value), max_plan_payments: Number($("sPlanMax").value) };
  if (!(lim.min_gift >= 1 && lim.min_gift <= lim.max_gift && lim.max_gift <= 2000000 && lim.max_pledge >= lim.min_gift && lim.max_pledge <= 2000000 && lim.max_deposit >= 1 && lim.max_deposit <= 2000000)) {
    done(false); return note(msg, "Check the limits: the smallest gift must be below the largest, and nothing above $2,000,000.", "err");
  }
  if (!(Number.isInteger(lim.max_plan_payments) && lim.max_plan_payments >= 2 && lim.max_plan_payments <= 120)) { done(false); return note(msg, "A plan can have 2 to 120 payments.", "err"); }
  const amounts = $("sAmounts").value.split(/[,\s]+/).map((x) => Number(x.replace(/[$]/g, ""))).filter((x) => x > 0);
  if (!amounts.length || amounts.length > 8 || amounts.some((a) => a > 2000000)) { done(false); return note(msg, "Enter 1 to 8 suggested amounts.", "err"); }
  const reg = $("sReg").value.trim().toUpperCase();
  if (reg && !/^[A-Z]{1,3}[0-9]{2,8}$/.test(reg)) { done(false); return note(msg, "The registration number should look like CH12345.", "err"); }
  if ($("sOnline").checked && !reg) { done(false); return note(msg, "Enter the FDACS registration number before opening online payments.", "err"); }
  const { error } = await sb.from("settings").update({ org_name: $("sOrg").value.trim(), fdacs_reg: reg, gofundme_url: gfm,
    accept_online: $("sOnline").checked, milestones: ms.sort((a, b) => a.amount - b.amount), ...lim, allow_plans: $("sPlans").checked,
    suggested_amounts: [...new Set(amounts)].sort((a, b) => a - b), prompts_enabled: $("sPrompts").checked, prompt_headline: $("sHeadline").value.trim(),
    goal_deadline: $("sDeadline").value || null, updated_at: new Date().toISOString() }).eq("id", 1);
  if (error) { done(false); return note(msg, friendly(error), "err"); }
  done(true);
  delete $("sForm").dataset.touched; note(msg, "Settings saved. The public site updates within a minute.");
  loadTop();
});

// ---------- SYSTEM AND ACTIVITY ----------
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
loaders.system = async (page = acPage) => {
  if (page === 0 || acPage === 0) {
    sb.rpc("activity_verify").then(({ data: v, error }) => {
      if (error || !v) return note($("acIntegrity"), "The integrity check could not run.", "warn");
      note($("acIntegrity"), v.ok ? `Integrity verified: all ${Number(v.checked).toLocaleString()} entries are intact.` : `Warning: the activity log was tampered with at entry ${v.firstBadId}. Tell the board.`, v.ok ? "" : "err");
    });
    if (role === "treasurer") loadHandover();
  }
  acPage = Math.max(0, page);
  let q = sb.from("activity_log").select("*", { count: "exact" });
  const lv = $("acLevel").value, sq = safeQ($("acSearch").value).replace(/\s+/g, "_");
  if (lv === "problems") q = q.in("level", ["error", "security"]); else if (lv) q = q.eq("level", lv);
  if (sq) q = q.ilike("action", `%${sq}%`);
  const { data, count, error } = await q.order("id", { ascending: false }).range(acPage * PAGE, acPage * PAGE + PAGE - 1);
  if (error) return note($("status"), friendly(error), "err");
  fill($("activityRows"), data.length ? data.map((x) => h("tr", {}, h("td", { class: "num" }, new Date(x.at).toLocaleString()),
    h("td", {}, x.actor_label || (x.actor ? "Staff" : "Website / server"), x.role ? h("div", { class: "hint" }, x.role) : null),
    h("td", {}, ACT[x.action] || x.action, h("div", { class: "hint" }, x.action + (x.path ? " · " + x.path : ""))),
    h("td", {}, h("span", { class: "pill lvl-" + x.level }, x.level)),
    h("td", { class: "hint" }, Object.entries(x.detail || {}).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join(" · ").slice(0, 300)))) : emptyRow(5, "Nothing matches."));
  pager($("activityPager"), acPage, count || 0, (p) => loaders.system(p));
};
$("acLevel").addEventListener("change", () => loaders.system(0));
let acT; $("acSearch").addEventListener("input", () => { clearTimeout(acT); acT = setTimeout(() => loaders.system(0), 300); });

$("hRun").addEventListener("click", async () => {
  $("hRun").disabled = true; note($("hMsg"), "Running the checks…");
  try {
    const d = await api("/api/health");
    const checks = d.security?.checks || [];
    fill($("secRows"), checks.length ? checks.map((c) => h("tr", {}, h("td", {}, c.name), h("td", {}, h("span", { class: "pill " + (c.ok ? "ok" : "due") }, c.ok ? "Passed" : "Needs attention")), h("td", { class: "hint" }, c.detail || ""))) : emptyRow(3, d.security?.error || "No checks returned."));
    const missing = Object.entries(d.env || {}).filter(([, v]) => !v).map(([k]) => k);
    $("envLine").textContent = `Version ${d.version} (${d.context}) · Stripe ${d.stripeMode} mode · ${missing.length ? "Not configured: " + missing.join(", ") : "All services configured"}${d.activity?.issuesLast7Days != null ? ` · ${d.activity.issuesLast7Days} problem${d.activity.issuesLast7Days === 1 ? "" : "s"} in 7 days` : ""}.`;
    note($("hMsg"), d.security?.ok ? "Every security check passed." : "Some checks need attention. See the list below.", d.security?.ok ? "" : "warn");
  } catch (e) { note($("hMsg"), e.message, "err"); }
  $("hRun").disabled = false;
});

async function loadHandover() {
  const { data: s } = await sb.from("settings").select("handover_at, keys_rotated_on").eq("id", 1).maybeSingle();
  $("hoStatus").textContent = s?.handover_at ? `Last handover confirmed ${new Date(s.handover_at).toLocaleString()}${s.keys_rotated_on ? `; keys changed ${s.keys_rotated_on}` : ""}.` : "No handover has been confirmed yet.";
  if (!$("hoKeys").value) $("hoKeys").value = today();
}
$("hoConfirm").addEventListener("click", (e) => {
  if ([...document.querySelectorAll(".ho")].some((c) => !c.checked)) return note($("hoMsg"), "Tick every step first. Each one closes a way back in.", "err");
  if (!$("hoKeys").value || $("hoKeys").value > today()) return note($("hoMsg"), "Enter the date the keys were changed.", "err");
  confirmAct(e.currentTarget, "Confirm the handover and remove all developer access?", async () => {
    const r = await sb.from("settings").update({ handover_at: new Date().toISOString(), keys_rotated_on: $("hoKeys").value }).eq("id", 1);
    if (!r.error) note($("hoMsg"), "Handover confirmed. All developer access has been removed and the handover is in the activity log.");
    return r;
  }, () => loaders.system(0));
});
