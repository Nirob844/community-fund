import { reset, state, post, body } from "./_mock.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
const pledge = (await import("../../netlify/functions/pledge.mjs")).default;
const good = { name: "maria gomez", email: "Maria@Example.org", address: "12 Oak St", area: "Magnolia Point", amount: 100, show: "initial", turnstileToken: "ok" };

test("valid pledge creates a private contributor and a pledge, and emails a confirmation", async () => {
  reset({ contributors: [], pledges: [], settings: [{ id: 1, accept_online: false }] });
  const { status, data } = await body(await pledge(post("/api/pledge", good)));
  assert.equal(status, 201);
  assert.match(data.shareUrl, /\/share\/\?t=/);
  const c = state.tables.contributors[0];
  assert.equal(c.email, "maria@example.org"); assert.equal(c.public_label, "Maria G.");
  assert.equal(state.tables.pledges[0].amount, 100);
  assert.equal(state.emails.length, 1); assert.deepEqual(state.emails[0].to, ["maria@example.org"]);
  assert.match(state.emails[0].text, /\$100\.00/); assert.match(state.emails[0].text, /not tax-deductible/);
  assert.equal(state.tables.email_log[0].status, "sent");
});
test("PRIVACY: a pledge using someone else's email never reveals their private link", async () => {
  const { status, data } = await body(await pledge(post("/api/pledge", { ...good, name: "Impostor Person", address: "Elsewhere", amount: 50 })));
  assert.equal(status, 201);
  assert.equal(data.shareUrl, null, "existing contributor's link must not be returned to the browser");
  assert.ok(!JSON.stringify(data).includes("b".repeat(36)));
  assert.deepEqual(state.emails.at(-1).to, ["maria@example.org"], "the link goes only to the address on file");
});
test("a second pledge with the same email reuses the contributor and does not overwrite their details", async () => {
  assert.equal(state.tables.contributors.length, 1);
  assert.equal(state.tables.contributors[0].address, "12 Oak St");
  assert.equal(state.tables.pledges.length, 2);
});
for (const [name, patch, re] of [
  ["missing name", { name: "" }, /name/], ["bad email", { email: "nope" }, /email/], ["zero amount", { amount: 0 }, /between/],
  ["over $2M", { amount: 2000001 }, /between/], ["text amount", { amount: "lots" }, /between/],
]) test(`rejects ${name}`, async () => {
  reset({ contributors: [], pledges: [] });
  const { status, data } = await body(await pledge(post("/api/pledge", { ...good, ...patch })));
  assert.equal(status, 400); assert.match(data.error, re);
  assert.equal(state.tables.pledges.length, 0);
});
test("rejects when the bot check fails", async () => {
  reset({ contributors: [], pledges: [] }); state.turnstileOk = false;
  assert.equal((await pledge(post("/api/pledge", good))).status, 400);
});
test("rejects cross-site posts, oversized bodies and bad JSON", async () => {
  reset({});
  assert.equal((await pledge(post("/api/pledge", good, { origin: "https://evil.example" }))).status, 403);
  assert.equal((await pledge(post("/api/pledge", "x".repeat(5000)))).status, 413);
  assert.equal((await pledge(post("/api/pledge", "{not json"))).status, 400);
});
test("pledges are refused politely once the fund has closed", async () => {
  reset({ contributors: [], pledges: [] });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, i) => (String(u).includes("/rest/v1/pledges") && i?.method === "POST")
    ? new Response(JSON.stringify({ code: "23514", message: "The fund is no longer accepting pledges." }), { status: 400, headers: { "content-type": "application/json" } })
    : realFetch(u, i);
  try {
    const { status, data } = await body(await pledge(post("/api/pledge", good)));
    assert.equal(status, 409); assert.match(data.error, /closed/);
  } finally { globalThis.fetch = realFetch; }
});
test("honeypot submissions are silently dropped", async () => {
  reset({ contributors: [], pledges: [] });
  const r = await pledge(post("/api/pledge", { ...good, website: "http://spam" }));
  assert.equal(r.status, 200); assert.equal(state.tables.pledges.length, 0);
});
test("markup in names is neutralised", async () => {
  reset({ contributors: [], pledges: [] });
  await pledge(post("/api/pledge", { ...good, name: "<img src=x onerror=alert(1)> Smith" }));
  assert.ok(!/[<>]/.test(state.tables.contributors[0].full_name + state.tables.contributors[0].public_label));
});
