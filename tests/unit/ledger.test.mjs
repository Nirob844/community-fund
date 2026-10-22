// The public ledger endpoint now returns the database's own calculation (public_ledger_v2).
// The money math itself is tested against real Postgres in tests/db.
import { reset, state, get, body } from "./_mock.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
const ledger = (await import("../../netlify/functions/ledger.mjs")).default;
const share = (await import("../../netlify/functions/my-share.mjs")).default;

test("ledger returns the database calculation and is edge-cacheable for 30 seconds", async () => {
  reset(); state.rpc.public_ledger_v2 = () => ({ totals: { received: 200 }, people: [] });
  const r = await ledger(get("/api/ledger"));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).totals.received, 200);
  assert.match(r.headers.get("netlify-cdn-cache-control"), /s-maxage=30/);
  assert.ok(state.calls.some((c) => c.path === "/rest/v1/rpc/public_ledger_v2"));
  assert.ok(!state.calls.some((c) => /\/rest\/v1\/(receipts|contributors)/.test(c.path)), "must not page through raw tables");
});
test("ledger hides database errors", async () => {
  reset();
  const { status, data } = await body(await ledger(get("/api/ledger")));
  assert.equal(status, 500); assert.doesNotMatch(data.error, /rpc|sql/i);
});
test("my-share validates the token before asking the database", async () => {
  reset(); state.rpc.my_share_v2 = ({ token }) => (token === "c".repeat(36) ? { label: "Ann A.", received: 60 } : null);
  assert.equal((await share(get("/api/my-share?t=zzz"))).status, 404);
  assert.equal(state.calls.length, 0);
  assert.equal((await share(get("/api/my-share?t=" + "d".repeat(36)))).status, 404);
  const ok = await share(get("/api/my-share?t=" + "c".repeat(36)));
  assert.equal(ok.status, 200); assert.equal(ok.headers.get("referrer-policy"), "no-referrer");
});
