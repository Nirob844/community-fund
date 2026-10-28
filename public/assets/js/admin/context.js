// Shared context, application state, and core utilities for admin dashboard
import { $, h, fill, fmt, emptyRow } from "../common.js";
export { $, h, fill, fmt, emptyRow } from "../common.js";

export const PAGE = 25;
export const today = () => new Date().toISOString().slice(0, 10);
export const RANK = { developer: 0, auditor: 1, recorder: 2, treasurer: 3 };
export const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,63}\.[^\s@]{2,24}$/;
export const FREQ = { weekly: "Weekly", monthly: "Monthly", quarterly: "Every 3 months" };
export const PLAN_STATUS = {
  pending: ["Waiting for setup", "pend"],
  active: ["Active", "ok"],
  past_due: ["Payment failed", "due"],
  completed: ["Completed", "ok"],
  cancelled: ["Stopped", "cancelled"]
};

export const KIND = { refund: "Refund", dispute_lost: "Chargeback", closing_payout: "Closing payout" };
export const TAB_TITLES = {
  record: "Quick Record",
  pledges: "Pledges & Giving Plans",
  money: "Money In & Out",
  people: "Contributors & Community",
  news: "Blog & Updates",
  records: "Audit & Exports",
  closing: "Fund Closing & Payouts",
  team: "Team Management",
  settings: "Fund Settings",
  system: "System & Health",
};

// Global shared state container
export const state = {
  sb: null,
  role: null,
  session: null,
  settings: null,
  staffNames: new Map(),
  loaders: {},
  currentTab: null
};

export function showToast(text, kind = "ok") {
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

export function dismissToast(toast) {
  if (!toast || toast._dismissed) return;
  toast._dismissed = true;
  clearTimeout(toast._timer);
  toast.classList.remove("show");
  toast.classList.add("hide");
  setTimeout(() => toast.remove(), 250);
}

export function setBtnLoading(btn, text = "Saving...") {
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

export const note = (el, text, kind = "") => {
  if (el) {
    el.textContent = text;
    el.className = "note" + (kind ? " " + kind : " ok");
    el.hidden = !text;
  }
};

export const can = (need) => (RANK[state.role] ?? -1) >= RANK[need] && (need === "developer" || state.role !== "developer");

export function allowed(el) {
  if (el.dataset.roles) return el.dataset.roles.split(/\s+/).includes(state.role);
  const need = el.dataset.need || (el.matches("[data-ctab],[data-cpanel]") ? "auditor" : null);
  return !need || can(need);
}

export function nextDue(p) {
  if (["completed", "cancelled"].includes(p.status)) return "—";
  const d = new Date(p.start_on + "T12:00:00");
  if (p.frequency === "weekly") d.setDate(d.getDate() + 7 * p.paid_count);
  else d.setMonth(d.getMonth() + (p.frequency === "quarterly" ? 3 : 1) * p.paid_count);
  return d.toISOString().slice(0, 10);
}

export async function api(path, method = "GET", body) {
  const { data: { session: s } } = await state.sb.auth.getSession();
  const r = await fetch(path, {
    method,
    headers: { authorization: "Bearer " + s.access_token, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || "The request failed.");
  return d;
}

export const logAct = (act, info = {}) => {
  try { state.sb?.rpc("log_activity", { act, info }).then(() => {}, () => {}); } catch {}
};

export function publicLabel(full, mode) {
  if (mode === "anon") return "Anonymous neighbor";
  const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "Neighbor";
  const first = parts[0].charAt(0).toUpperCase() + parts[0].slice(1, 30);
  return parts.length > 1 ? `${first} ${parts[parts.length - 1][0].toUpperCase()}.` : first;
}

export const friendly = (error) => {
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

export const who = (id) => (id ? state.staffNames.get(id) || "Former staff" : "Website / Stripe");
export const safeQ = (q) => String(q || "").replace(/[,()*%\\:"']/g, " ").trim().slice(0, 60);
export const btn = (label, onclick, cls = "btn small ghost") => h("button", { class: cls, type: "button", onclick }, label);

export function confirmAct(cellBtn, question, action, done) {
  const wrap = cellBtn.closest("td") || cellBtn.parentElement;
  const keep = [...wrap.childNodes];
  fill(wrap, h("span", { class: "confirm" }, h("span", { class: "hint" }, question + " "),
    btn("Yes", async (e) => {
      const finish = setBtnLoading(e.currentTarget, "Working...");
      try {
        const r = await action();
        fill(wrap, keep);
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

export function pager(el, page, total, go, pageSize = PAGE) {
  if (!el) return;
  const size = pageSize || PAGE;
  const totalCount = Number(total) || 0;
  const pages = Math.max(1, Math.ceil(totalCount / size));
  const currentPage = Math.max(0, Math.min(page, pages - 1));

  const start = totalCount === 0 ? 0 : currentPage * size + 1;
  const end = Math.min((currentPage + 1) * size, totalCount);

  const infoText = totalCount === 0
    ? "No entries to display"
    : `Showing ${start.toLocaleString()}–${end.toLocaleString()} of ${totalCount.toLocaleString()} entries`;

  const info = h("div", { className: "pager-info" }, infoText);
  const nav = h("div", { className: "pager-nav" });

  const prevBtn = btn("← Prev", () => { if (currentPage > 0) go(currentPage - 1); }, "pager-btn");
  prevBtn.disabled = currentPage <= 0;
  nav.appendChild(prevBtn);

  let pStart = Math.max(0, currentPage - 2);
  let pEnd = Math.min(pages, pStart + 5);
  if (pEnd - pStart < 5) pStart = Math.max(0, pEnd - 5);
  pStart = Math.max(0, pStart);

  for (let i = pStart; i < pEnd; i++) {
    const isCur = i === currentPage;
    const pNum = btn(String(i + 1), () => { if (!isCur) go(i); }, `pager-btn pager-num${isCur ? " active" : ""}`);
    if (isCur) pNum.setAttribute("aria-current", "page");
    nav.appendChild(pNum);
  }

  const nextBtn = btn("Next →", () => { if (currentPage < pages - 1) go(currentPage + 1); }, "pager-btn");
  nextBtn.disabled = currentPage >= pages - 1;
  nav.appendChild(nextBtn);

  fill(el, [info, nav]);
}

export function makePicker(p, { onChange, allowNew = true } = {}) {
  const input = $(p + "Find"), list = $(p + "Results"), chosen = $(p + "Chosen");
  if (!input || !list || !chosen) return { get: () => null, set: () => {} };
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
      const { data } = await state.sb.from("contributors").select("id, full_name, email, area, public_label")
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

export async function balance(cid) {
  const [p, r, f] = await Promise.all([
    state.sb.from("pledges").select("amount, status").eq("contributor_id", cid),
    state.sb.from("receipts").select("amount").eq("contributor_id", cid),
    state.sb.from("refunds").select("amount, kind").eq("contributor_id", cid),
  ]);
  const pledged = (p.data || []).filter((x) => !["cancelled", "withdrawn"].includes(x.status)).reduce((a, x) => a + Number(x.amount), 0);
  const received = (r.data || []).reduce((a, x) => a + Number(x.amount), 0) - (f.data || []).filter((x) => x.kind !== "closing_payout").reduce((a, x) => a + Number(x.amount), 0);
  return { pledged, received, owed: Math.max(0, pledged - received) };
}

export async function newContributor({ full, email, address, area, label }) {
  email = (email || "").trim().toLowerCase();
  if (email && !EMAIL.test(email)) throw new Error("Enter a valid email, or leave it blank.");
  const { data, error } = await state.sb.from("contributors").insert({ full_name: full, email, address: address || "", area, public_label: label, offline: true }).select("id, public_label, area").single();
  if (error) throw new Error(friendly(error));
  return data;
}

export async function emailAbout(kind, id) {
  const { data: { session: s } } = await state.sb.auth.getSession();
  const r = await fetch("/api/notify", { method: "POST", headers: { authorization: "Bearer " + s.access_token, "content-type": "application/json" }, body: JSON.stringify({ kind, id }) });
  const d = await r.json().catch(() => ({}));
  return r.ok ? d.status : "failed";
}

export const emailWord = (st) => ({
  sent: "A receipt was emailed.",
  skipped: "Email isn't set up yet, so no receipt was sent.",
  "no-address": "No email on file, so no receipt was sent."
}[st] || "The receipt email could not be sent.");

export function refresh() {
  if (state.role !== "developer") loadTop();
  state.loaders[state.currentTab]?.();
}

export async function loadTop() {
  const [{ data: t, error }, { data: s }] = await Promise.all([
    state.sb.rpc("ledger_totals"),
    state.sb.from("settings").select("*").eq("id", 1).maybeSingle()
  ]);
  if (error) return note($("status"), friendly(error), "err");
  state.settings = s;
  $("tCash").textContent = fmt(Number(t.cash));
  $("tRec").textContent = fmt(Number(t.received));
  $("tOut").textContent = fmt(Number(t.outstandingPledges));
  $("tExp").textContent = fmt(Number(t.expenses));
  const st = s?.fund_status || "open";
  $("fundBanner").hidden = st === "open";
  $("fundBanner").textContent = st === "closing"
    ? "The fund is closing: the website no longer accepts pledges. Finish the payouts in the Closing tab."
    : st === "closed"
    ? `The fund is closed${s.closed_on ? " (" + s.closed_on + ")" : ""}.`
    : "";
  return t;
}

export function csvDownload(name, rows) {
  const q = (v) => typeof v === "number" ? String(v) : `"${String(v ?? "").replace(/"/g, '""').replace(/^[=+\-@\t\r]/, "'$&")}"`;
  const blob = new Blob(["\ufeff" + rows.map((r) => r.map(q).join(",")).join("\r\n")], { type: "text/csv" });
  const a = h("a", { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
}

export async function fetchAll(make) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await make().range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) return out;
  }
}
