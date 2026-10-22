import { $, h, fill, fmt, live, renderTiles, renderScale, renderAreas, wireChartTooltip, renderFooterLegal } from "./common.js";
import { goalPrompts, giftImpact, suggestedAmounts } from "./prompts.js";

let LEDGER = null, CONFIG = {}, turnstileId = null;

function note(el, text, kind = "") { el.textContent = text; el.className = "note" + (kind ? " " + kind : ""); el.hidden = !text; }

function renderRecent(d) {
  const list = (d.receipts || []).slice(0, 6);
  fill($("recentList"), list.length
    ? h("div", { class: "tablewrap" }, h("table", {}, h("tbody", {}, list.map((r) =>
        h("tr", {}, h("td", {}, r.label, h("div", { class: "hint" }, r.area)), h("td", { class: "r num" }, fmt(r.amount)))))))
    : h("p", { class: "empty" }, "No contributions recorded yet. Be the first."));
}

function renderPay(d) {
  const box = $("payBox");
  const kids = [];
  if (d.org.acceptOnline) kids.push(h("p", { class: "hint" }, "After you record your pledge, you'll go to a secure Stripe page to pay by card, Apple Pay or Google Pay."));
  else kids.push(h("div", { class: "note warn" }, "Online card payments open as soon as the fund's state registration is complete. Record your pledge now and the treasurer will email you when you can pay."));
  if (d.org.gofundmeUrl) kids.push(h("p", {}, h("a", { class: "btn ghost", href: d.org.gofundmeUrl, target: "_blank", rel: "noopener noreferrer" }, "Give through GoFundMe instead")));
  fill(box, kids);
}

function renderClosed(d) {
  const closed = d.org.fundStatus && d.org.fundStatus !== "open";
  const form = $("pledgeForm");
  form.querySelectorAll("input, select, button").forEach((el) => { el.disabled = closed; });
  $("closedNote").hidden = !closed;
  if (closed) $("closedNote").textContent = d.org.fundStatus === "closed"
    ? `The fund closed${d.org.closedOn ? " on " + d.org.closedOn : ""} and is no longer accepting pledges. ${d.org.closingNote || "Remaining money is being returned in proportion to each contribution."}`
    : `The fund is closing and is no longer accepting pledges. ${d.org.closingNote || ""}`;
}

function renderPrompts(d) {
  const p = goalPrompts(d);
  $("prompts").hidden = !p;
  if (!p) return;
  $("promptHead").textContent = p.headline;
  fill($("promptList"), p.lines.map((l) => h("li", {}, l)));
}

// Giving options follow the treasurer's limits: suggested amounts, minimum and maximum, plans on or off.
const isPlan = () => !$("giveType").hidden && $("gPlan").checked;
function limitsNow() { return LEDGER?.limits || { minGift: 1, maxGift: 2000000, maxPledge: 2000000, allowPlans: false, maxPlanPayments: 24 }; }
function renderGiving(d) {
  const L = limitsNow();
  $("giveType").hidden = !L.allowPlans;
  if (!L.allowPlans) $("gOnce").checked = true;
  const amts = suggestedAmounts(L);
  if (amts.length) {
    const cur = $("pAmt").value;
    fill($("amtChips"), amts.map((a) => h("button", { type: "button", "data-amt": String(a), "aria-pressed": String(String(a) === cur) }, fmt(a).replace(/\.00$/, ""))));
  }
  $("pCount").max = String(L.maxPlanPayments || 24);
  syncPlan();
}
function syncPlan() {
  const L = limitsNow(), plan = isPlan();
  $("planBox").hidden = !plan;
  $("amtLabel").textContent = plan ? "Each payment" : "Amount";
  $("pAmt").min = String(L.minGift || 1);
  $("pAmt").max = String(plan ? L.maxGift : L.maxPledge || 2000000);
  $("pSubmit").textContent = plan ? "Set up my giving plan" : "Record my pledge";
  updateImpact();
}
function updateImpact() {
  const a = Number($("pAmt").value);
  $("impact").textContent = LEDGER ? giftImpact(LEDGER, a, isPlan() ? { payments: Number($("pCount").value) || 0 } : null) : "";
}

function render(d) {
  LEDGER = d;
  renderClosed(d);
  renderPrompts(d);
  renderGiving(d);
  renderTiles(d.totals);
  renderScale(d.totals.received, d.milestones);
  renderAreas(d.areas || []);
  renderRecent(d);
  renderPay(d);
  renderFooterLegal(d.org);
  $("status").hidden = true;
}

// Amount chips (re-drawn from the treasurer's suggested amounts, so listen on the group)
$("amtChips").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-amt]"); if (!b) return;
  $("amtChips").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  $("pAmt").value = b.dataset.amt; updateImpact();
});
$("pAmt").addEventListener("input", () => { $("amtChips").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.amt === $("pAmt").value))); updateImpact(); });
["gOnce", "gPlan", "pFreq", "pCount"].forEach((id) => $(id).addEventListener("change", syncPlan));
$("pCount").addEventListener("input", updateImpact);

// Bot protection (Cloudflare Turnstile, loaded only if configured)
async function loadConfig() {
  try { CONFIG = await (await fetch("/api/config")).json(); } catch { CONFIG = {}; }
  if (!CONFIG.turnstileSiteKey) return;
  window.onTurnstileLoad = () => { turnstileId = window.turnstile.render("#turnstile", { sitekey: CONFIG.turnstileSiteKey, appearance: "interaction-only" }); };
  document.head.append(h("script", { src: "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onTurnstileLoad", async: true, defer: true }));
}

$("pledgeForm").addEventListener("submit", async (ev) => {
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
  btn.disabled = true; note(msg, "Saving your pledge…");
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
    $("pledgeForm").reset(); $("pAmt").value = "100"; syncPlan();
  } catch (e) {
    note(msg, e.message, "err");
  } finally {
    btn.disabled = false;
    if (turnstileId != null && window.turnstile) window.turnstile.reset(turnstileId);
  }
});

wireChartTooltip();
loadConfig();
live(render, () => { const s = $("status"); s.textContent = "Live figures are temporarily unavailable. Please refresh in a minute."; s.hidden = false; });
