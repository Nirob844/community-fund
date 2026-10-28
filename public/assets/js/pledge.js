import { $, h, fill, fmt } from "./common.js";
import { giftImpact, suggestedAmounts } from "./prompts.js";

let LEDGER = null, CONFIG = {}, turnstileId = null;

export function note(el, text, kind = "") {
  if (!el) return;
  el.textContent = text;
  el.className = "note" + (kind ? " " + kind : "");
  el.hidden = !text;
}

export function limitsNow() {
  return LEDGER?.limits || { minGift: 1, maxGift: 2000000, maxPledge: 2000000, allowPlans: false, maxPlanPayments: 24 };
}

export const isPlan = () => {
  const gt = $("giveType");
  return gt && !gt.hidden && $("gPlan")?.checked;
};

export function updateImpact() {
  const amtEl = $("pAmt");
  if (!amtEl) return;
  const a = Number(amtEl.value);
  const imp = $("impact");
  if (imp) {
    const cnt = $("pCount");
    imp.textContent = LEDGER ? giftImpact(LEDGER, a, isPlan() ? { payments: Number(cnt?.value) || 0 } : null) : "";
  }
}

export function syncPlan() {
  const L = limitsNow(), plan = isPlan();
  const pBox = $("planBox");
  if (pBox) pBox.hidden = !plan;
  const lbl = $("amtLabel");
  if (lbl) lbl.textContent = plan ? "Each payment" : "Amount";
  const amt = $("pAmt");
  if (amt) {
    amt.min = String(L.minGift || 1);
    amt.max = String(plan ? L.maxGift : L.maxPledge || 2000000);
  }
  const sub = $("pSubmit");
  if (sub) sub.textContent = plan ? "Set up my giving plan" : "Record my pledge";
  updateImpact();
}

export function renderGiving(d) {
  const L = limitsNow();
  const gt = $("giveType");
  if (gt) {
    gt.hidden = !L.allowPlans;
    if (!L.allowPlans && $("gOnce")) $("gOnce").checked = true;
  }
  const amts = suggestedAmounts(L);
  const IMPACTS = { 25: "Public records", 50: "Town hall outreach", 100: "Legal research", 250: "Drainage review", 500: "Litigation defense", 1000: "Full expert study" };
  const chips = $("amtChips");
  if (chips && amts.length) {
    const cur = $("pAmt")?.value;
    fill(chips, amts.map((a) => {
      const val = h("span", { class: "chip-val" }, fmt(a).replace(/\.00$/, ""));
      const sub = IMPACTS[a] ? h("span", { class: "chip-sub" }, IMPACTS[a]) : null;
      return h("button", { type: "button", "data-amt": String(a), "aria-pressed": String(String(a) === cur) }, sub ? [val, sub] : val);
    }));
  }
  const cnt = $("pCount");
  if (cnt) cnt.max = String(L.maxPlanPayments || 24);
  syncPlan();
}

export function renderPay(d) {
  const box = $("payBox");
  if (!box) return;
  const kids = [];
  if (d.org.acceptOnline) kids.push(h("p", { class: "hint" }, "After you record your pledge, you'll go to a secure Stripe page to pay by card, Apple Pay or Google Pay."));
  else kids.push(h("div", { class: "note warn" }, "Online card payments open as soon as the fund's state registration is complete. Record your pledge now and the treasurer will email you when you can pay."));
  if (d.org.gofundmeUrl) kids.push(h("p", {}, h("a", { class: "btn ghost", href: d.org.gofundmeUrl, target: "_blank", rel: "noopener noreferrer" }, "Give through GoFundMe instead")));
  fill(box, kids);
}

export function renderClosed(d) {
  const closed = d.org.fundStatus && d.org.fundStatus !== "open";
  const form = $("pledgeForm");
  if (!form) return;
  form.querySelectorAll("input, select, button").forEach((el) => { el.disabled = closed; });
  const noteEl = $("closedNote");
  if (!noteEl) return;
  noteEl.hidden = !closed;
  if (closed) noteEl.textContent = d.org.fundStatus === "closed"
    ? `The fund closed${d.org.closedOn ? " on " + d.org.closedOn : ""} and is no longer accepting pledges. ${d.org.closingNote || "Remaining money is being returned in proportion to each contribution."}`
    : `The fund is closing and is no longer accepting pledges. ${d.org.closingNote || ""}`;
}

export function renderRecent(d) {
  const box = $("recentList");
  if (!box) return;
  const list = (d.receipts || []).slice(0, 6);
  fill(box, list.length
    ? h("div", { class: "tablewrap" }, h("table", {}, h("tbody", {}, list.map((r) =>
        h("tr", {}, h("td", {}, r.label, h("div", { class: "hint" }, r.area)), h("td", { class: "r num" }, fmt(r.amount)))))))
    : h("p", { class: "empty" }, "No contributions recorded yet. Be the first."));
}

export function renderPledgeState(d) {
  LEDGER = d;
  renderClosed(d);
  renderGiving(d);
  renderRecent(d);
  renderPay(d);
}

async function loadConfig() {
  try { CONFIG = await (await fetch("/api/config")).json(); } catch { CONFIG = {}; }
  if (!CONFIG.turnstileSiteKey) return;
  const renderTurnstile = () => {
    const el = $("turnstile");
    if (window.turnstile && el && turnstileId == null) {
      try {
        turnstileId = window.turnstile.render(el, { sitekey: CONFIG.turnstileSiteKey, appearance: "always" });
      } catch (err) {
        console.error("Turnstile render error:", err);
      }
    }
  };
  window.onTurnstileLoad = renderTurnstile;
  if (window.turnstile) {
    renderTurnstile();
  } else if (!document.querySelector('script[src*="turnstile"]')) {
    document.head.append(h("script", { src: "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onTurnstileLoad", async: true, defer: true }));
  }
}

export function initPledgeForm() {
  const chips = $("amtChips");
  if (chips) {
    chips.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-amt]");
      if (!b) return;
      chips.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      const amt = $("pAmt");
      if (amt) { amt.value = b.dataset.amt; updateImpact(); }
    });
  }

  const pAmt = $("pAmt");
  if (pAmt) {
    pAmt.addEventListener("input", () => {
      chips?.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.amt === pAmt.value)));
      updateImpact();
    });
  }

  ["gOnce", "gPlan", "pFreq", "pCount"].forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener("change", syncPlan);
  });

  $("pCount")?.addEventListener("input", updateImpact);

  const form = $("pledgeForm");
  if (form) {
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const msg = $("pMsg"), btn = $("pSubmit");
      const L = limitsNow(), plan = isPlan();
      const body = {
        name: $("pName").value.trim(), email: $("pEmail").value.trim(), address: $("pAddr").value.trim(),
        area: $("pArea").value.trim(), amount: Number($("pAmt").value), show: $("pShow").value, website: $("pWebsite").value,
        turnstileToken: turnstileId != null && window.turnstile ? window.turnstile.getResponse(turnstileId) : "",
      };
      if (plan) body.plan = { frequency: $("pFreq").value, payments: Number($("pCount").value) };
      if (!body.name || !body.email || !body.address || !body.area) return note(msg, "Please fill in your name, email, street address and neighborhood.", "err");
      const max = plan ? L.maxGift : L.maxPledge;
      if (!(body.amount >= L.minGift && body.amount <= max)) return note(msg, `Please enter ${plan ? "a payment" : "a pledge"} between ${fmt(L.minGift)} and ${fmt(max)}.`, "err");
      if (plan && !(Number.isInteger(body.plan.payments) && body.plan.payments >= 2 && body.plan.payments <= L.maxPlanPayments)) return note(msg, `Choose between 2 and ${L.maxPlanPayments} payments.`, "err");
      if (!$("pConsent").checked) return note(msg, "Please tick the box to confirm you have read the privacy notice.", "err");
      if (CONFIG.turnstileSiteKey && turnstileId != null && !body.turnstileToken) {
        return note(msg, "Please complete the security check above and try again.", "err");
      }
      const origBtn = btn.textContent;
      btn.disabled = true;
      btn.classList.add("loading");
      btn.replaceChildren(h("span", { className: "spin" }), document.createTextNode(" Saving your pledge…"));
      note(msg, "Saving your pledge…");
      try {
        const r = await fetch("/api/pledge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || "We could not save your pledge. Please try again.");
        if (data.shareUrl) { try { localStorage.setItem("fundShareUrl", data.shareUrl); } catch {} }
        if (LEDGER?.org?.acceptOnline) {
          note(msg, data.planId ? `Thank you. Your giving plan (${fmt(data.amount)} in all) is saved. Opening the secure page to set up the payments…`
            : `Thank you. Your pledge of ${fmt(data.amount)} is saved. Opening the secure payment page…`);
          const c = await fetch("/api/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data.planId ? { planId: data.planId } : { pledgeId: data.pledgeId }) });
          const cd = await c.json().catch(() => ({}));
          if (c.ok && cd.url) { location.assign(cd.url); return; }
          note(msg, cd.error || "Your pledge is saved, but the payment page did not open. Please try again shortly.", "warn");
        } else {
          if (data.shareUrl) fill(msg, `Thank you. Your pledge of ${fmt(data.amount)} is saved. `, h("a", { href: data.shareUrl }, "Bookmark your private share link"), " to see your contribution and refund share at any time. We've also emailed you a confirmation.");
          else fill(msg, `Thank you. Your pledge of ${fmt(data.amount)} is saved. We've emailed a confirmation and your private link to the address on file.`);
          msg.className = "note"; msg.hidden = false;
        }
        form.reset(); $("pAmt").value = "100"; syncPlan();
      } catch (e) {
        note(msg, e.message, "err");
      } finally {
        btn.disabled = false;
        btn.classList.remove("loading");
        btn.textContent = origBtn;
        if (turnstileId != null && window.turnstile) window.turnstile.reset(turnstileId);
      }
    });
  }

  loadConfig();
}
