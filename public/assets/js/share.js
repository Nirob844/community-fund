import { $, h, fill, fmt } from "./common.js";

const params = new URLSearchParams(location.search);
let token = params.get("t");
try { if (token) localStorage.setItem("fundShareToken", token); else token = localStorage.getItem("fundShareToken"); } catch {}
// Remove the private token from the address bar so it isn't shared by accident.
if (params.has("t")) history.replaceState(null, "", location.pathname);

const FREQ = { weekly: "every week", monthly: "every month", quarterly: "every 3 months" };
const STATUS = { pending: "Waiting for setup", active: "Active", past_due: "Payment didn't go through", completed: "Completed", cancelled: "Stopped" };
const PILL = { pending: "pend", active: "ok", past_due: "due", completed: "ok", cancelled: "cancelled" };
const note = (el, text, kind = "") => { el.textContent = text; el.className = "note" + (kind ? " " + kind : ""); el.hidden = !text; };
const post = async (url, body) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || "Something went wrong. Please try again.");
  return d;
};

function planCard(p, reload) {
  const left = Math.max(p.payments - p.paidCount, 0);
  const acts = h("div", { class: "btnrow" });
  if (["pending", "active", "past_due"].includes(p.status)) {
    const stop = h("button", { class: "btn small ghost", type: "button" }, "Stop this plan");
    stop.addEventListener("click", () => fill(acts, h("span", { class: "hint" }, "Stop all future payments? "),
      h("button", { class: "btn small danger", type: "button", onclick: async (e) => {
        e.currentTarget.disabled = true;
        try { await post("/api/plan", { t: token, planId: p.id }); reload(["Your giving plan has stopped. No more payments will be taken. Thank you for what you gave.", ""]); }
        catch (err) { reload([err.message, "err"]); }
      } }, "Yes, stop it"),
      h("button", { class: "btn small ghost", type: "button", onclick: () => reload() }, "Keep it")));
    acts.append(stop);
  }
  return h("div", { class: "plan-card" },
    h("div", {}, h("strong", { class: "num" }, `${fmt(Number(p.installment))} ${FREQ[p.frequency] || p.frequency}`),
      h("div", { class: "meta" }, `${p.paidCount} of ${p.payments} payments made (${fmt(Number(p.paidTotal))})`,
        p.nextDue && left ? ` · next about ${new Date(p.nextDue + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}` : "",
        p.method === "manual" ? " · paid to the treasurer" : "")),
    h("span", { class: "pill " + (PILL[p.status] || "pend") }, STATUS[p.status] || p.status), acts);
}

function giveAgain(d) {
  const L = d.limits || {};
  const amts = (L.suggestedAmounts || [25, 50, 100]).filter((a) => a >= L.minGift && a <= L.maxGift);
  const plans = !!L.allowPlans;
  const box = h("form", { class: "giveagain", id: "gaForm", novalidate: true },
    h("h3", {}, "Give again"),
    plans ? h("fieldset", { class: "field givetype" }, h("legend", { class: "lbl" }, "How would you like to give?"),
      h("label", { class: "choice" }, h("input", { type: "radio", name: "gaType", id: "gaOnce", value: "once", checked: true }), h("span", {}, "One gift")),
      h("label", { class: "choice" }, h("input", { type: "radio", name: "gaType", id: "gaPlan", value: "plan" }), h("span", {}, "Smaller payments over time"))) : null,
    h("div", { class: "amounts", role: "group", "aria-label": "Suggested amounts" }, amts.map((a) => h("button", { type: "button", "data-amt": String(a), "aria-pressed": "false" }, fmt(a).replace(/\.00$/, "")))),
    h("div", { class: "row" },
      h("div", { class: "field" }, h("label", { for: "gaAmt", id: "gaAmtLabel" }, "Amount"), h("input", { id: "gaAmt", type: "number", min: String(L.minGift || 1), max: String(L.maxGift || 2000000), step: "1", value: String(amts[1] || amts[0] || 50), inputmode: "decimal" }))),
    plans ? h("div", { class: "row", id: "gaPlanBox", hidden: true },
      h("div", { class: "field" }, h("label", { for: "gaFreq" }, "How often"), h("select", { id: "gaFreq" }, h("option", { value: "weekly" }, "Every week"), h("option", { value: "monthly", selected: true }, "Every month"), h("option", { value: "quarterly" }, "Every 3 months"))),
      h("div", { class: "field" }, h("label", { for: "gaCount" }, "Number of payments"), h("input", { id: "gaCount", type: "number", min: "2", max: String(L.maxPlanPayments || 24), value: "6", step: "1" }))) : null,
    h("button", { class: "btn sun", type: "submit", id: "gaGo" }, "Continue to secure payment"));
  box.querySelector(".amounts").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-amt]"); if (!b) return;
    box.querySelectorAll(".amounts button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    box.querySelector("#gaAmt").value = b.dataset.amt;
  });
  const isPlan = () => plans && box.querySelector("#gaPlan").checked;
  if (plans) box.addEventListener("change", () => {
    box.querySelector("#gaPlanBox").hidden = !isPlan();
    box.querySelector("#gaAmtLabel").textContent = isPlan() ? "Each payment" : "Amount";
  });
  box.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const amount = Number(box.querySelector("#gaAmt").value);
    if (!(amount >= L.minGift && amount <= L.maxGift)) return note($("shareMsg"), `Please enter an amount between ${fmt(L.minGift)} and ${fmt(L.maxGift)}.`, "err");
    const body = { t: token, amount };
    if (isPlan()) body.plan = { frequency: box.querySelector("#gaFreq").value, payments: Number(box.querySelector("#gaCount").value) };
    box.querySelector("#gaGo").disabled = true; note($("shareMsg"), "Opening the secure payment page…");
    try { const d2 = await post("/api/give", body); location.assign(d2.url); }
    catch (e) { note($("shareMsg"), e.message, "err"); box.querySelector("#gaGo").disabled = false; }
  });
  return box;
}

async function load(message) {
  const box = $("shareBox");
  if (!token) { fill(box, h("p", { class: "note warn" }, "Open this page from the private link you received when you pledged.")); return; }
  try {
    const r = await fetch("/api/my-share?t=" + encodeURIComponent(token));
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Link not recognized.");
    const owed = Number(d.owed ?? Math.max(d.pledged - d.received, 0));
    const plans = d.plans || [];
    const payOwed = d.acceptOnline && owed >= 1 ? h("button", { class: "btn", type: "button", id: "payOwed", onclick: async (e) => {
      e.currentTarget.disabled = true; note($("shareMsg"), "Opening the secure payment page…");
      try { const x = await post("/api/give", { t: token, payOwed: true }); location.assign(x.url); }
      catch (err) { note($("shareMsg"), err.message, "err"); e.currentTarget.disabled = false; }
    } }, `Pay what I still owe (${fmt(owed)})`) : null;
    fill(box,
      h("h2", {}, `Hello, ${d.label}`),
      h("p", { class: "sub" }, d.area),
      h("div", { class: "explain" },
        h("div", {}, h("div", { class: "k" }, "You pledged"), h("div", { class: "v" }, fmt(d.pledged))),
        h("div", {}, h("div", { class: "k" }, "Received from you"), h("div", { class: "v" }, fmt(d.received))),
        h("div", {}, h("div", { class: "k" }, "Your share of the fund"), h("div", { class: "v" }, (d.share * 100).toFixed(2) + "%"))),
      h("div", { class: "note" }, `The fund has received ${fmt(d.fundReceived)} and spent ${fmt(d.fundExpenses)}, leaving ${fmt(d.availableToReturn)}. If the fund closed today, you would receive `, h("strong", { class: "num" }, fmt(d.refund)), "."),
      h("div", { id: "shareMsg", class: "note", hidden: true, role: "status", "aria-live": "polite" }),
      plans.length ? [h("h3", {}, "Your giving plans"), h("div", { class: "plans-list" }, plans.map((p) => planCard(p, (m) => load(m))))] : null,
      payOwed ? h("div", { class: "btnrow block" }, payOwed) : null,
      d.acceptOnline && d.fundStatus === "open" ? giveAgain(d) : h("p", { class: "hint" }, "To give again, contact the treasurer. Online payments open after the fund's state registration is complete."));
    if (Array.isArray(message)) note($("shareMsg"), message[0], message[1]);
  } catch (e) {
    fill(box, h("p", { class: "note err" }, e.message));
  }
}
load();
