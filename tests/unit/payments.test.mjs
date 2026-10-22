import { reset, state, post, body } from "./_mock.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import Stripe from "stripe";
const checkout = (await import("../../netlify/functions/checkout.mjs")).default;
const webhook = (await import("../../netlify/functions/stripe-webhook.mjs")).default;
const PID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const base = () => ({
  settings: [{ id: 1, accept_online: true, org_name: "Fund", fdacs_reg: "CH12345" }],
  contributors: [{ id: "C1", email: "m@example.org", full_name: "Maria Gomez", public_label: "Maria G.", area: "Magnolia Point" }],
  pledges: [{ id: PID, contributor_id: "C1", amount: "100", status: "open", pledged_on: "2026-10-01", created_at: "1" }],
  receipts: [], expenses: [],
});

test("checkout is refused until online payments are opened", async () => {
  reset({ ...base(), settings: [{ id: 1, accept_online: false }] });
  assert.equal((await checkout(post("/api/checkout", { pledgeId: PID }))).status, 409);
});
test("checkout is refused without a registration number, even if payments were switched on", async () => {
  reset({ ...base(), settings: [{ id: 1, accept_online: true, fdacs_reg: "" }] });
  assert.equal((await checkout(post("/api/checkout", { pledgeId: PID }))).status, 409);
  assert.equal(state.stripeSessions.length, 0);
});
test("checkout charges the amount from the database, not the browser", async () => {
  reset(base());
  const { status, data } = await body(await checkout(post("/api/checkout", { pledgeId: PID, amount: 1 })));
  assert.equal(status, 200); assert.match(data.url, /checkout\.stripe\.com/);
  assert.equal(state.stripeSessions[0].params["line_items[0][price_data][unit_amount]"], "10000");
});
test("checkout charges only what is still owed on a partly paid pledge", async () => {
  reset({ ...base(), receipts: [{ contributor_id: "C1", amount: "40" }] });
  state.tables.pledges[0].status = "partial";
  await checkout(post("/api/checkout", { pledgeId: PID }));
  assert.equal(state.stripeSessions[0].params["line_items[0][price_data][unit_amount]"], "6000");
});
test("checkout refuses paid pledges and unknown ids", async () => {
  reset({ ...base() }); state.tables.pledges[0].status = "paid";
  assert.equal((await checkout(post("/api/checkout", { pledgeId: PID }))).status, 409);
  assert.equal((await checkout(post("/api/checkout", { pledgeId: "not-a-uuid" }))).status, 400);
});

const event = (type = "checkout.session.completed", paid = "paid") => JSON.stringify({
  id: "evt_1", type, created: 1792000000,
  data: { object: { id: "cs_test_123", payment_status: paid, amount_total: 10000, metadata: { pledge_id: PID, contributor_id: "C1" } } },
});
const signed = (payload, secret = "whsec_test_secret") => new Request("https://fund.example.org/api/stripe-webhook", {
  method: "POST", body: payload, headers: { "stripe-signature": Stripe.webhooks.generateTestHeaderString({ payload, secret }) },
});

test("webhook rejects forged signatures", async () => {
  reset(base());
  assert.equal((await webhook(signed(event(), "whsec_wrong"))).status, 400);
  assert.equal(state.tables.receipts.length, 0);
});
test("webhook records the receipt with the public label and the Stripe fee as an expense", async () => {
  reset(base());
  const r = await webhook(signed(event()));
  assert.equal(r.status, 200);
  assert.equal(state.tables.receipts.length, 1);
  const rc = state.tables.receipts[0];
  assert.equal(rc.amount, 100); assert.equal(rc.public_label, "Maria G."); assert.equal(rc.method, "Online (Stripe)");
  assert.equal(state.tables.expenses[0].amount, 3.2); assert.equal(state.tables.expenses[0].category, "Platform and bank fees");
  assert.equal(rc.stripe_charge_id, "ch_1", "charge id stored for later refunds and disputes");
  assert.equal(state.emails.length, 1); assert.match(state.emails[0].subject, /Receipt/); assert.match(state.emails[0].text, /R-[0-9A-F]{10}/);
});
test("webhook retries do not double-count or re-send the receipt", async () => {
  await webhook(signed(event()));
  assert.equal(state.tables.receipts.length, 1);
  assert.equal(state.tables.expenses.length, 1);
  assert.equal(state.emails.length, 1);
});
test("checkout is refused once the fund has closed", async () => {
  reset({ ...base(), settings: [{ id: 1, accept_online: true, fund_status: "closed", fdacs_reg: "CH12345" }] });
  const { status, data } = await body(await checkout(post("/api/checkout", { pledgeId: PID })));
  assert.equal(status, 409); assert.match(data.error, /closed/);
});
test("checkout subtracts earlier refunds when working out what is owed", async () => {
  reset({ ...base(), receipts: [{ contributor_id: "C1", amount: "100" }], refunds: [{ contributor_id: "C1", amount: "30", kind: "refund" }] });
  state.tables.pledges[0].status = "partial";
  await checkout(post("/api/checkout", { pledgeId: PID }));
  assert.equal(state.stripeSessions[0].params["line_items[0][price_data][unit_amount]"], "3000");
});

// ---- refunds and disputes arriving from Stripe ----
const ev = (type, object) => JSON.stringify({ id: "evt_" + type, type, created: 1792000000, data: { object } });
const withReceipt = () => ({ ...base(), receipts: [{ id: "R1", contributor_id: "C1", public_label: "Maria G.", area: "Magnolia Point", amount: "100", stripe_charge_id: "ch_1", disputed: false }], refunds: [], expenses: [] });

test("a refund made in Stripe is recorded once, and removed if it fails", async () => {
  reset(withReceipt());
  await webhook(signed(ev("refund.created", { id: "re_9", charge: "ch_1", amount: 2500, status: "succeeded", created: 1792000000, reason: "requested_by_customer" })));
  await webhook(signed(ev("refund.updated", { id: "re_9", charge: "ch_1", amount: 2500, status: "succeeded", created: 1792000000 })));
  assert.equal(state.tables.refunds.length, 1);
  assert.deepEqual([state.tables.refunds[0].amount, state.tables.refunds[0].kind, state.tables.refunds[0].receipt_id], [25, "refund", "R1"]);
  await webhook(signed(ev("refund.updated", { id: "re_9", charge: "ch_1", amount: 2500, status: "failed", created: 1792000000 })));
  assert.equal(state.tables.refunds.length, 0);
});
test("a dispute flags the payment, records Stripe's fee and alerts the treasurer", async () => {
  reset(withReceipt()); process.env.TREASURER_EMAIL = "treasurer@example.org";
  await webhook(signed(ev("charge.dispute.created", { id: "dp_1", charge: "ch_1", amount: 10000, reason: "fraudulent", status: "needs_response", created: 1792000000, balance_transactions: [{ fee: 1500 }] })));
  assert.equal(state.tables.receipts[0].disputed, true);
  assert.equal(state.tables.expenses[0].amount, 15); assert.equal(state.tables.expenses[0].stripe_ref, "dfee_dp_1");
  assert.deepEqual(state.emails.at(-1).to, ["treasurer@example.org"]);
});
test("a lost dispute becomes a chargeback; a won dispute clears the flag", async () => {
  reset(withReceipt());
  await webhook(signed(ev("charge.dispute.closed", { id: "dp_1", charge: "ch_1", amount: 10000, reason: "fraudulent", status: "lost", created: 1792000000, balance_transactions: [{ fee: 1500 }, { fee: 0 }] })));
  assert.equal(state.tables.refunds[0].kind, "dispute_lost"); assert.equal(state.tables.refunds[0].amount, 100);
  assert.equal(state.tables.receipts[0].disputed, false);
  reset(withReceipt()); state.tables.receipts[0].disputed = true;
  await webhook(signed(ev("charge.dispute.closed", { id: "dp_2", charge: "ch_1", amount: 10000, status: "won", created: 1792000000, balance_transactions: [{ fee: 1500 }, { fee: -1500 }] })));
  assert.equal(state.tables.refunds.length, 0); assert.equal(state.tables.receipts[0].disputed, false);
  assert.equal(state.tables.expenses.length, 0, "a returned dispute fee leaves no expense");
});
test("webhook ignores unpaid sessions and other events", async () => {
  reset(base());
  await webhook(signed(event("checkout.session.completed", "unpaid")));
  await webhook(signed(event("customer.created")));
  assert.equal(state.tables.receipts.length, 0);
});
