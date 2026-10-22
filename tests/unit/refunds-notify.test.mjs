import { reset, state, post, get, body, ORIGIN } from "./_mock.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
const refund = (await import("../../netlify/functions/refund.mjs")).default;
const notify = (await import("../../netlify/functions/notify.mjs")).default;
const updates = (await import("../../netlify/functions/updates.mjs")).default;
const T = "11111111-1111-4111-8111-111111111111", RID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab";
const auth = { authorization: "Bearer token" };
const base = (role = "treasurer") => ({
  admins: [{ user_id: T, role, active: true }],
  contributors: [{ id: "C1", email: "m@example.org", full_name: "Maria Gomez", public_label: "Maria G.", area: "MP" }],
  receipts: [{ id: RID, contributor_id: "C1", public_label: "Maria G.", area: "MP", amount: "100", method: "Online (Stripe)", stripe_charge_id: "ch_1", received_on: "2026-10-10" }],
  refunds: [], settings: [{ id: 1 }],
});
const signedIn = () => { state.authUser = { id: T, email: "t@example.org" }; };

test("card refunds: treasurer only", async () => {
  reset(base("recorder")); signedIn();
  assert.equal((await refund(post("/api/refund", { receiptId: RID, amount: 10 }, auth))).status, 403);
  reset(base()); assert.equal((await refund(post("/api/refund", { receiptId: RID, amount: 10 }))).status, 403);
});
test("card refund goes to Stripe for the right amount, is recorded, and the person is emailed", async () => {
  reset(base()); signedIn();
  const { status } = await body(await refund(post("/api/refund", { receiptId: RID, amount: 40, reason: "Moved away" }, auth)));
  assert.equal(status, 200);
  assert.equal(state.stripeRefunds[0].params.amount, "4000"); assert.equal(state.stripeRefunds[0].params.charge, "ch_1");
  assert.equal(state.tables.refunds[0].amount, 40); assert.equal(state.tables.refunds[0].created_by, T);
  assert.match(state.emails.at(-1).subject, /Refund of \$40\.00/);
});
test("refunds can't exceed what is left, and non-card payments are sent to the manual flow", async () => {
  reset({ ...base(), refunds: [{ receipt_id: RID, amount: "80", kind: "refund" }] }); signedIn();
  const over = await body(await refund(post("/api/refund", { receiptId: RID, amount: 30 }, auth)));
  assert.equal(over.status, 400); assert.match(over.data.error, /up to 20\.00/);
  reset(base()); signedIn(); state.tables.receipts[0].method = "Check";
  assert.match((await body(await refund(post("/api/refund", { receiptId: RID, amount: 5 }, auth)))).data.error, /manual refund/);
  assert.equal(state.stripeRefunds.length, 0);
});
test("receipt emails: recorders may send; the server decides the content and recipient", async () => {
  reset(base("recorder")); signedIn();
  const r = await body(await notify(post("/api/notify", { kind: "receipt", id: RID, to: "attacker@evil.example" }, auth)));
  assert.equal(r.data.status, "sent"); assert.deepEqual(state.emails[0].to, ["m@example.org"]);
  assert.equal((await notify(post("/api/notify", { kind: "refund", id: RID }, auth))).status, 403, "refund emails are treasurer-only");
  assert.equal((await notify(post("/api/notify", { kind: "receipt", id: RID }))).status, 403, "needs a session");
});
test("with no email service configured, emails are logged as skipped, not lost silently", async () => {
  reset(base("recorder")); signedIn(); const k = process.env.RESEND_API_KEY; delete process.env.RESEND_API_KEY;
  try {
    const r = await body(await notify(post("/api/notify", { kind: "receipt", id: RID }, auth)));
    assert.equal(r.data.status, "skipped"); assert.equal(state.tables.email_log[0].status, "skipped");
  } finally { process.env.RESEND_API_KEY = k; }
});
test("updates: only published posts are public", async () => {
  reset({ posts: [{ slug: "first-hearing", title: "Hearing", published: true, published_on: "2026-10-01" }, { slug: "draft", title: "Draft", published: false }] });
  const list = await body(await updates(get("/api/updates")));
  assert.deepEqual(list.data.posts.map((p) => p.slug), ["first-hearing"]);
  assert.equal((await updates(get("/api/updates?slug=draft"))).status, 404);
  assert.equal((await updates(get("/api/updates?slug=../etc"))).status, 404);
  assert.equal((await updates(get("/api/updates?slug=first-hearing"))).status, 200);
});
