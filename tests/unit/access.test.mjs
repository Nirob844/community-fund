// v3.2 access control: temporary developer access the treasurer grants and removes,
// expired access, the system health page, activity logging of refusals, and no dev backdoors.
import { reset, state, post, get, body, ORIGIN } from "./_mock.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
const staff = (await import("../../netlify/functions/staff.mjs")).default;
const health = (await import("../../netlify/functions/health.mjs")).default;
const refund = (await import("../../netlify/functions/refund.mjs")).default;
import { sameOrigin, verifyTurnstile, requireStaff } from "../../netlify/lib/util.mjs";

const T = "11111111-1111-4111-8111-111111111111", D = "33333333-3333-4333-8333-333333333333", A = "44444444-4444-4444-8444-444444444444";
const auth = { authorization: "Bearer token" };
const patch = (b) => new Request(ORIGIN + "/api/staff", { method: "PATCH", headers: { origin: ORIGIN, "content-type": "application/json", ...auth }, body: JSON.stringify(b) });
const soon = (h) => new Date(Date.now() + h * 3600000).toISOString();
const team = (devOver = {}) => ({
  admins: [{ user_id: T, role: "treasurer", active: true, display_name: "Tess", created_at: "1" },
    { user_id: A, role: "auditor", active: true, display_name: "Ada", created_at: "2" },
    { user_id: D, role: "developer", active: true, display_name: "Dev", created_at: "3", access_expires_at: soon(48), purpose: "Fix emails", ...devOver }],
  activity_log: [], settings: [{ id: 1 }],
});
const asUser = (id, email) => { state.authUser = { id, email }; };

test("the treasurer invites a developer for a limited time and a stated purpose", async () => {
  reset({ ...team(), admins: team().admins.slice(0, 2) });
  state.users = [{ id: T, email: "t@example.org" }];
  asUser(T, "t@example.org");
  for (const [b, re] of [[{ days: 0, purpose: "Fix emails" }, /1 to 30 days/], [{ days: 31, purpose: "Fix emails" }, /1 to 30 days/],
    [{ days: 7, purpose: "x" }, /issue/], [{ purpose: "Fix emails" }, /1 to 30 days/]]) {
    const r = await body(await staff(post("/api/staff", { email: "dev@example.org", displayName: "Dev", role: "developer", ...b }, auth)));
    assert.equal(r.status, 400); assert.match(r.data.error, re);
  }
  const r = await body(await staff(post("/api/staff", { email: "dev@example.org", displayName: "Dev", role: "developer", days: 7, purpose: "Receipt emails not arriving" }, auth)));
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const row = state.tables.admins.find((a) => a.role === "developer");
  const days = (new Date(row.access_expires_at) - Date.now()) / 86400000;
  assert.ok(days > 6.9 && days <= 7, "expires in 7 days, got " + days);
  assert.equal(row.purpose, "Receipt emails not arriving"); assert.equal(row.invited_by, T);
  assert.ok(state.userUpdates.some((u) => u.id === row.user_id && u.ban_duration === "none"));
  const log = state.tables.activity_log.find((a) => a.action === "developer.invite");
  assert.equal(log.level, "security"); assert.equal(log.actor, T); assert.equal(log.detail.purpose, "Receipt emails not arriving");
});

test("the treasurer can remove a developer at any time; they are also blocked from signing in", async () => {
  reset(team()); state.users = [{ id: T, email: "t@example.org" }, { id: D, email: "d@example.org" }];
  asUser(T, "t@example.org");
  assert.equal((await staff(patch({ userId: D, active: false }))).status, 200);
  assert.equal(state.tables.admins.find((a) => a.user_id === D).active, false);
  assert.ok(state.userUpdates.some((u) => u.id === D && u.ban_duration === "876000h"), "banned from signing in");
  assert.ok(state.tables.activity_log.some((a) => a.action === "developer.remove"));
  // re-enabling an ended developer needs a new end date
  state.tables.admins.find((a) => a.user_id === D).access_expires_at = soon(-1);
  assert.equal((await staff(patch({ userId: D, active: true }))).status, 400);
  assert.equal((await staff(patch({ userId: D, extendDays: 3 }))).status, 200);
  assert.ok(state.userUpdates.some((u) => u.id === D && u.ban_duration === "none"));
  assert.equal((await staff(patch({ userId: D, extendDays: 45 }))).status, 400);
});

test("developer access can't be turned into a team role, or a team role into developer access", async () => {
  reset(team()); asUser(T, "t@example.org");
  assert.equal((await staff(patch({ userId: D, role: "treasurer" }))).status, 400);
  assert.equal((await staff(patch({ userId: A, role: "developer" }))).status, 400);
  assert.equal((await staff(patch({ userId: A, extendDays: 3 }))).status, 400);
});

test("the team list shows developer end dates and doesn't count them as a seat", async () => {
  reset(team()); state.users = [{ id: T, email: "t@example.org" }, { id: A, email: "a@example.org" }, { id: D, email: "d@example.org" }];
  asUser(T, "t@example.org");
  const r = await body(await staff(get("/api/staff", auth)));
  assert.equal(r.data.seatsUsed, 2);
  const dev = r.data.staff.find((x) => x.role === "developer");
  assert.ok(dev.accessExpiresAt); assert.equal(dev.purpose, "Fix emails"); assert.equal(dev.active, true);
});

test("a developer can't manage the team, refund money, or act like staff", async () => {
  reset(team()); asUser(D, "d@example.org");
  assert.equal((await staff(get("/api/staff", auth))).status, 403);
  assert.equal((await refund(post("/api/refund", { receiptId: T, amount: 1 }, auth))).status, 403);
  assert.equal(await requireStaff(get("/x", auth), "auditor"), null, "developer is below every staff role");
  assert.ok(await requireStaff(get("/x", auth), "developer"));
  const denied = state.tables.activity_log.filter((a) => a.action === "access.denied");
  assert.ok(denied.length >= 3); assert.ok(denied.every((a) => a.level === "security" && a.actor === D));
});

test("expired developer access is refused everywhere, even before anyone removes it", async () => {
  reset(team({ access_expires_at: soon(-0.1) })); asUser(D, "d@example.org");
  assert.equal(await requireStaff(get("/x", auth), "developer"), null);
  assert.equal((await health(get("/api/health", auth))).status, 403);
  assert.match(state.tables.activity_log.at(-1).detail.reason, /expired/);
});

test("system health is for the treasurer and developer only, and never reveals a key", async () => {
  reset(team());
  state.rpc.security_audit = () => ({ ok: true, checks: [{ name: "Row Level Security on every table", ok: true }] });
  asUser(A, "a@example.org");
  assert.equal((await health(get("/api/health", auth))).status, 403, "auditor");
  asUser(D, "d@example.org");
  const r = await body(await health(get("/api/health", auth)));
  assert.equal(r.status, 200);
  assert.equal(r.data.env.STRIPE_SECRET_KEY, true); assert.equal(r.data.stripeMode, "test"); assert.equal(r.data.security.ok, true);
  const text = JSON.stringify(r.data);
  for (const secret of [process.env.STRIPE_SECRET_KEY, process.env.SUPABASE_SERVICE_ROLE_KEY, process.env.STRIPE_WEBHOOK_SECRET, process.env.TURNSTILE_SECRET_KEY]) {
    assert.ok(!text.includes(secret), "leaked a key");
  }
  assert.ok(state.tables.activity_log.some((a) => a.action === "health.view" && a.actor === D));
  assert.equal((await health(get("/api/health"))).status, 403, "no session");
});

test("no development shortcut can be switched on in production", async () => {
  const saved = { ...process.env };
  try {
    delete process.env.TURNSTILE_SECRET_KEY;
    process.env.CONTEXT = "dev";                          // someone sets CONTEXT alone on the live site
    assert.equal(sameOrigin(new Request(ORIGIN, { headers: { origin: "https://evil.example" } })), false);
    assert.equal(await verifyTurnstile("", "1.2.3.4"), false);
    process.env.NETLIFY_DEV = "true"; process.env.NETLIFY = "true";   // the live platform marks itself
    assert.equal(sameOrigin(new Request(ORIGIN, { headers: { origin: "https://evil.example" } })), false);
    delete process.env.NETLIFY;                           // only a real `netlify dev` on a laptop
    assert.equal(sameOrigin(new Request(ORIGIN, { headers: { origin: "http://localhost:8888" } })), true);
  } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
});
