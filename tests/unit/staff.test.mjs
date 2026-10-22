import { reset, state, post, get, body, ORIGIN } from "./_mock.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
const staff = (await import("../../netlify/functions/staff.mjs")).default;
const T = "11111111-1111-4111-8111-111111111111";
const auth = { authorization: "Bearer token" };
const patch = (b) => new Request(ORIGIN + "/api/staff", { method: "PATCH", headers: { origin: ORIGIN, "content-type": "application/json", ...auth }, body: JSON.stringify(b) });

test("team API refuses anyone without a session or who isn't treasurer", async () => {
  reset({ admins: [{ user_id: T, role: "recorder", active: true }] });
  assert.equal((await staff(get("/api/staff"))).status, 403);
  state.authUser = { id: T, email: "t@example.org" };
  assert.equal((await staff(get("/api/staff", auth))).status, 403);
});
test("treasurer can list and add team members", async () => {
  reset({ admins: [{ user_id: T, role: "treasurer", active: true, display_name: "Tess", created_at: "1" }] });
  state.users = [{ id: T, email: "t@example.org" }];
  state.authUser = { id: T, email: "t@example.org" };
  const list = await body(await staff(get("/api/staff", auth)));
  assert.equal(list.status, 200); assert.equal(list.data.seats, 5); assert.equal(list.data.staff[0].email, "t@example.org");
  const add = await body(await staff(post("/api/staff", { email: "Rory@Example.org", displayName: "Rory", role: "recorder" }, auth)));
  assert.equal(add.status, 201);
  assert.equal(state.tables.admins.length, 2);
  assert.equal(state.users.at(-1).email, "rory@example.org");
});
test("team API validates input and protects the treasurer's own access", async () => {
  assert.equal((await staff(post("/api/staff", { email: "bad", displayName: "X", role: "recorder" }, auth))).status, 400);
  assert.equal((await staff(post("/api/staff", { email: "a@b.org", displayName: "X", role: "owner" }, auth))).status, 400);
  assert.equal((await staff(patch({ userId: T, active: false }))).status, 400);
  assert.equal((await staff(post("/api/staff", { email: "a@b.org", displayName: "X", role: "recorder" }, { ...auth, origin: "https://evil.example" }))).status, 403);
});
