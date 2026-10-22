import "./_mock.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { publicLabel, clean, money, sameOrigin } from "../../netlify/lib/util.mjs";
import { ORIGIN } from "./_mock.mjs";

test("public label shows first name and last initial only", () => {
  assert.equal(publicLabel("peter  powell"), "Peter P.");
  assert.equal(publicLabel("Mary Ann de la Cruz"), "Mary C.");
  assert.equal(publicLabel("Cher"), "Cher");
  assert.equal(publicLabel("Anyone Here", "anon"), "Anonymous neighbor");
  assert.equal(publicLabel("   "), "Neighbor");
});
test("clean strips markup and control characters and enforces length", () => {
  assert.equal(clean("<script>alert(1)</script>", 80), "script alert(1) /script");
  assert.equal(clean("a\u0000b\nc", 80), "a b c");
  assert.equal(clean("x".repeat(200), 10).length, 10);
});
test("money rounds to cents and rejects junk", () => {
  assert.equal(money("10.005"), 10.01);
  assert.ok(Number.isNaN(money("abc")));
});
test("same-origin check", () => {
  assert.equal(sameOrigin(new Request(ORIGIN, { headers: { origin: ORIGIN } })), true);
  assert.equal(sameOrigin(new Request(ORIGIN, { headers: { origin: "https://evil.example" } })), false);
  assert.equal(sameOrigin(new Request(ORIGIN)), false);
});
