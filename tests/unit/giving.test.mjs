// v3.2 giving: limits, giving plans (several smaller payments over time), giving again,
// paying what is owed, stopping a plan, and the Stripe events that drive plans.
import { reset, state, post, body, ORIGIN } from "./_mock.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import Stripe from "stripe";
const pledge = (await import("../../netlify/functions/pledge.mjs")).default;
const checkout = (await import("../../netlify/functions/checkout.mjs")).default;
const give = (await import("../../netlify/functions/give.mjs")).default;
const plan = (await import("../../netlify/functions/plan.mjs")).default;
const webhook = (await import("../../netlify/functions/stripe-webhook.mjs")).default;

const OPEN = { id: 1, org_name: "Fund", accept_online: true, fdacs_reg: "CH12345", fund_status: "open", min_gift: 5, max_gift: 1000, max_pledge: 20000, allow_plans: true, max_plan_payments: 12 };
const person = { name: "Maria Gomez", email: "m@example.org", address: "12 Oak St", area: "Magnolia Point", show: "initial", turnstileToken: "ok" };
const TOK = "c".repeat(36), OTHER = "d".repeat(36);
const PL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", PL2 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const T = "11111111-1111-4111-8111-111111111111", RC = "22222222-2222-4222-8222-222222222222";

// ---------- limits ----------
test("one-time pledges follow the treasurer's minimum and maximum", async () => {
  reset({ settings: [{ ...OPEN, accept_online: false }], contributors: [], pledges: [] });
  let r = await body(await pledge(post("/api/pledge", { ...person, amount: 25000 })));
  assert.equal(r.status, 400); assert.match(r.data.error, /\$5\.00 and \$20,000\.00/);
  r = await body(await pledge(post("/api/pledge", { ...person, amount: 4 })));
  assert.equal(r.status, 400);
  r = await body(await pledge(post("/api/pledge", { ...person, amount: 20000 })));
  assert.equal(r.status, 201); assert.equal(state.tables.pledges[0].amount, 20000);
});

test("a card payment never exceeds the per-payment limit; the rest stays owed", async () => {
  reset({ settings: [OPEN], contributors: [{ id: "C1", email: "m@example.org" }], pledges: [{ id: PL, contributor_id: "C1", amount: "5000", status: "open", pledged_on: "2026-10-01", created_at: "1" }], receipts: [], refunds: [] });
  const r = await body(await checkout(post("/api/checkout", { pledgeId: PL })));
  assert.equal(r.status, 200); assert.equal(r.data.amount, 1000); assert.equal(r.data.partOfPledge, true);
  assert.equal(state.stripeSessions[0].params["line_items[0][price_data][unit_amount]"], "100000");
});

// ---------- giving plans ----------
const planReq = (over = {}) => ({ ...person, amount: 25, plan: { frequency: "monthly", payments: 6 }, ...over });
test("a giving plan records the total pledge and a plan of smaller payments", async () => {
  reset({ settings: [OPEN], contributors: [], pledges: [], giving_plans: [] });
  const r = await body(await pledge(post("/api/pledge", planReq())));
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(state.tables.pledges[0].amount, 150); assert.match(state.tables.pledges[0].note, /\$25\.00 monthly x 6/);
  const g = state.tables.giving_plans[0];
  assert.equal(g.installment, 25); assert.equal(g.payments, 6); assert.equal(g.method, "card"); assert.equal(g.pledge_id, state.tables.pledges[0].id);
  assert.equal(r.data.planId, g.id);
  assert.match(state.emails[0].text, /giving plan of \$25\.00 monthly, 6 payments \(\$150\.00 in all\)/);
});
for (const [name, over, code, re] of [
  ["too many payments", { plan: { frequency: "monthly", payments: 13 } }, 400, /between 2 and 12/],
  ["one payment only", { plan: { frequency: "monthly", payments: 1 } }, 400, /between 2 and 12/],
  ["unknown frequency", { plan: { frequency: "daily", payments: 6 } }, 400, /how often/],
  ["payment above the limit", { amount: 1500 }, 400, /between \$5\.00 and \$1,000\.00/],
  ["total above the pledge limit", { amount: 1000, plan: { frequency: "weekly", payments: 12 } }, 200, null],
]) test(`giving plan: ${name}`, async () => {
  reset({ settings: [{ ...OPEN, max_pledge: 20000 }], contributors: [], pledges: [], giving_plans: [] });
  const r = await body(await pledge(post("/api/pledge", planReq(over))));
  if (code === 200) { assert.equal(r.status, 201); return; }
  assert.equal(r.status, code); assert.match(r.data.error, re); assert.equal(state.tables.pledges.length, 0);
});
test("giving plans are refused when switched off or before card payments open", async () => {
  for (const st of [{ ...OPEN, allow_plans: false }, { ...OPEN, accept_online: false }, { ...OPEN, fdacs_reg: "" }]) {
    reset({ settings: [st], contributors: [], pledges: [], giving_plans: [] });
    const r = await body(await pledge(post("/api/pledge", planReq())));
    assert.equal(r.status, 409); assert.equal(state.tables.pledges.length, 0);
  }
});

const planRow = (over = {}) => ({ id: PL2, contributor_id: "C1", pledge_id: PL, installment: "25", frequency: "quarterly", payments: 3, method: "card", status: "pending", paid_count: 0, ...over });
test("a plan's payment page sets up recurring payments from the database amounts", async () => {
  reset({ settings: [OPEN], contributors: [{ id: "C1", email: "m@example.org" }], giving_plans: [planRow()] });
  const r = await body(await checkout(post("/api/checkout", { planId: PL2, amount: 1 })));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const p = state.stripeSessions[0].params;
  assert.equal(p.mode, "subscription");
  assert.equal(p["line_items[0][price_data][unit_amount]"], "2500");
  assert.equal(p["line_items[0][price_data][recurring][interval]"], "month");
  assert.equal(p["line_items[0][price_data][recurring][interval_count]"], "3");
  assert.equal(p["metadata[plan_id]"], PL2); assert.equal(p["subscription_data[metadata][plan_id]"], PL2);
  state.tables.giving_plans[0].status = "active";
  assert.equal((await checkout(post("/api/checkout", { planId: PL2 }))).status, 409, "an active plan can't be set up twice");
});
test("a plan pledge can't also be paid as a one-time payment", async () => {
  reset({ settings: [OPEN], contributors: [{ id: "C1" }], pledges: [{ id: PL, contributor_id: "C1", amount: "75", status: "open" }], giving_plans: [planRow()], receipts: [], refunds: [] });
  assert.equal((await checkout(post("/api/checkout", { pledgeId: PL }))).status, 409);
});

// ---------- Stripe events for plans ----------
const signed = (obj) => { const payload = JSON.stringify({ id: "evt_" + Math.random(), created: 1792000000, ...obj });
  return new Request(ORIGIN + "/api/stripe-webhook", { method: "POST", body: payload, headers: { "stripe-signature": Stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_test_secret" }) } }); };
const invoice = (id, extra = {}) => signed({ type: "invoice.paid", data: { object: { id, number: "INV-" + id, amount_paid: 2500, status_transitions: { paid_at: 1792000000 },
  parent: { subscription_details: { subscription: "sub_1", metadata: { plan_id: PL2 } } }, ...extra } } });

test("finishing the plan's payment page activates the plan and confirms by email (no double-counted money)", async () => {
  reset({ settings: [OPEN], contributors: [{ id: "C1", email: "m@example.org", full_name: "Maria Gomez", public_label: "Maria G." }], giving_plans: [planRow()], receipts: [], expenses: [] });
  const r = await webhook(signed({ type: "checkout.session.completed", data: { object: { id: "cs_p", mode: "subscription", payment_status: "paid", subscription: "sub_1", customer: "cus_1", amount_total: 2500, metadata: { plan_id: PL2 } } } }));
  assert.equal(r.status, 200);
  const g = state.tables.giving_plans[0];
  assert.equal(g.status, "active"); assert.equal(g.stripe_subscription_id, "sub_1"); assert.equal(g.stripe_customer_id, "cus_1");
  assert.equal(state.tables.receipts.length, 0, "money is recorded from the invoice, not the checkout");
  assert.match(state.emails[0].subject, /giving plan is set up/);
});
test("each paid invoice becomes a receipt linked to the plan, with the fee, and retries are ignored", async () => {
  await webhook(invoice("in_1"));
  await webhook(invoice("in_1"));
  assert.equal(state.tables.receipts.length, 1);
  const rc = state.tables.receipts[0];
  assert.equal(rc.amount, 25); assert.equal(rc.plan_id, PL2); assert.equal(rc.pledge_id, PL); assert.equal(rc.stripe_invoice_id, "in_1");
  assert.equal(rc.stripe_charge_id, "ch_inv", "charge id kept for refunds and disputes"); assert.equal(rc.public_label, "Maria G.");
  assert.equal(state.tables.expenses[0].amount, 1.05);
  const mail = state.emails.filter((e) => /Receipt/.test(e.subject));
  assert.equal(mail.length, 1); assert.match(mail[0].text, /giving plan payment \d of 3/);
  assert.equal(state.stripeCancels.length, 0);
});
test("after the last payment the subscription is ended so the card is never charged again", async () => {
  state.tables.giving_plans[0].paid_count = 3;               // the database counts payments itself
  await webhook(invoice("in_3"));
  assert.deepEqual(state.stripeCancels, ["sub_1"]);
});
test("invoices from older Stripe API versions are understood too", async () => {
  reset({ settings: [OPEN], contributors: [{ id: "C1" }], giving_plans: [planRow({ status: "active", stripe_subscription_id: "sub_old" })], receipts: [], expenses: [] });
  await webhook(signed({ type: "invoice.paid", data: { object: { id: "in_old", amount_paid: 2500, subscription: "sub_old", charge: "ch_old" } } }));
  assert.equal(state.tables.receipts[0].plan_id, PL2);
});
test("a declined plan payment marks the plan past due, tells the donor once and logs a warning", async () => {
  reset({ settings: [OPEN], contributors: [{ id: "C1", email: "m@example.org", full_name: "Maria Gomez" }], giving_plans: [planRow({ status: "active", stripe_subscription_id: "sub_1" })], activity_log: [] });
  await webhook(signed({ type: "invoice.payment_failed", data: { object: { id: "in_f", attempt_count: 1, parent: { subscription_details: { subscription: "sub_1" } } } } }));
  await webhook(signed({ type: "invoice.payment_failed", data: { object: { id: "in_f", attempt_count: 2, parent: { subscription_details: { subscription: "sub_1" } } } } }));
  assert.equal(state.tables.giving_plans[0].status, "past_due");
  assert.equal(state.emails.filter((e) => /didn't go through/.test(e.subject)).length, 1);
  assert.ok(state.tables.activity_log.some((a) => a.action === "plan.payment_failed" && a.level === "warn"));
});
test("a subscription ended in Stripe stops the plan in the books", async () => {
  reset({ giving_plans: [planRow({ status: "active", stripe_subscription_id: "sub_1" })] });
  let called = null; state.rpc.cancel_plan = (a) => { called = a; return { status: "cancelled" }; };
  await webhook(signed({ type: "customer.subscription.deleted", data: { object: { id: "sub_1", metadata: {} } } }));
  assert.equal(called.pid, PL2); assert.match(called.why, /Stripe/);
});
test("a forged webhook is refused and logged as a security event", async () => {
  reset({ activity_log: [] });
  const r = await webhook(new Request(ORIGIN + "/api/stripe-webhook", { method: "POST", body: "{}", headers: { "stripe-signature": "t=1,v1=bad" } }));
  assert.equal(r.status, 400);
  assert.equal(state.tables.activity_log[0].action, "webhook.bad_signature"); assert.equal(state.tables.activity_log[0].level, "security");
});

// ---------- giving again from the private link ----------
const donor = () => ({ settings: [OPEN], contributors: [{ id: "C1", email: "m@example.org", share_token: TOK }, { id: "C2", share_token: OTHER }],
  pledges: [], giving_plans: [], receipts: [], refunds: [], activity_log: [] });
test("a donor can give again from their private link without retyping anything", async () => {
  reset(donor());
  const r = await body(await give(post("/api/give", { t: TOK, amount: 40 })));
  assert.equal(r.status, 201, JSON.stringify(r.data)); assert.match(r.data.url, /checkout\.stripe\.com/);
  assert.equal(state.tables.pledges[0].contributor_id, "C1"); assert.equal(state.tables.pledges[0].amount, 40);
  assert.equal(state.stripeSessions[0].params.cancel_url, ORIGIN + "/share/");
});
test("a donor can start a giving plan from their private link", async () => {
  reset(donor());
  const r = await body(await give(post("/api/give", { t: TOK, amount: 10, plan: { frequency: "weekly", payments: 8 } })));
  assert.equal(r.status, 201); assert.equal(r.data.plan, true);
  assert.equal(state.tables.giving_plans[0].installment, 10); assert.equal(state.stripeSessions[0].params.mode, "subscription");
});
test("'pay what I still owe' picks the oldest unpaid pledge and skips plan pledges", async () => {
  reset({ ...donor(), pledges: [
    { id: PL2, contributor_id: "C1", amount: "100", status: "open", pledged_on: "2026-09-01", created_at: "1" },
    { id: PL, contributor_id: "C1", amount: "300", status: "partial", pledged_on: "2026-10-01", created_at: "2" }],
    giving_plans: [{ id: "G1", contributor_id: "C1", pledge_id: PL2 }], receipts: [{ contributor_id: "C1", amount: "100" }] });
  const r = await body(await give(post("/api/give", { t: TOK, payOwed: true })));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(state.stripeSessions[0].params["metadata[pledge_id]"], PL);
});
test("unknown links are refused and logged; limits and closed payments apply", async () => {
  reset(donor());
  assert.equal((await give(post("/api/give", { t: "e".repeat(36), amount: 40 }))).status, 404);
  assert.equal(state.tables.activity_log[0].action, "donor.bad_link");
  assert.equal((await give(post("/api/give", { t: TOK, amount: 1 }))).status, 400);
  reset({ ...donor(), settings: [{ ...OPEN, accept_online: false }] });
  assert.equal((await give(post("/api/give", { t: TOK, amount: 40 }))).status, 409);
  assert.equal((await give(post("/api/give", { t: TOK, amount: 40 }, { origin: "https://evil.example" }))).status, 403);
});

// ---------- stopping a plan ----------
test("a donor can stop their own plan: Stripe stops, the books shrink the pledge, an email confirms", async () => {
  reset({ ...donor(), giving_plans: [planRow({ status: "active", stripe_subscription_id: "sub_9", paid_count: 1 })] });
  let called = null; state.rpc.cancel_plan = (a) => { called = a; return { status: "cancelled" }; };
  const r = await body(await plan(post("/api/plan", { t: TOK, planId: PL2 })));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(state.stripeCancels, ["sub_9"]); assert.equal(called.pid, PL2);
  assert.match(state.emails[0].subject, /stopped/);
  assert.ok(state.tables.activity_log.some((a) => a.action === "plan.cancel" && a.detail.by === "donor"));
});
test("nobody can stop someone else's plan", async () => {
  reset({ ...donor(), giving_plans: [planRow({ status: "active", stripe_subscription_id: "sub_9" })] });
  assert.equal((await plan(post("/api/plan", { t: OTHER, planId: PL2 }))).status, 404);
  assert.equal((await plan(post("/api/plan", { t: "f".repeat(36), planId: PL2 }))).status, 404);
  assert.equal(state.stripeCancels.length, 0);
});
test("the treasurer can stop a plan; other roles can't, and the attempt is logged", async () => {
  reset({ ...donor(), admins: [{ user_id: T, role: "treasurer", active: true }, { user_id: RC, role: "recorder", active: true }], giving_plans: [planRow({ status: "active", stripe_subscription_id: "sub_9" })] });
  state.rpc.cancel_plan = () => ({ status: "cancelled" });
  state.authUser = { id: RC, email: "r@example.org" };
  assert.equal((await plan(post("/api/plan", { planId: PL2 }, { authorization: "Bearer x" }))).status, 403);
  assert.ok(state.tables.activity_log.some((a) => a.action === "access.denied" && a.level === "security" && a.actor === RC));
  state.authUser = { id: T, email: "t@example.org" };
  assert.equal((await plan(post("/api/plan", { planId: PL2, reason: "Donor phoned" }, { authorization: "Bearer x" }))).status, 200);
  assert.deepEqual(state.stripeCancels, ["sub_9"]);
});
