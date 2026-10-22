// The post-deploy checker must pass a correct deployment and catch a broken one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../../scripts/verify-deploy.mjs";

const SITE = "https://fund.example.net";
const anonKey = "x." + Buffer.from(JSON.stringify({ role: "anon" })).toString("base64url") + ".y";
const serviceKey = "x." + Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url") + ".y";
const goodHeaders = {
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  "content-security-policy": "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; object-src 'none'; frame-ancestors 'none'; base-uri 'self'",
  "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "strict-origin-when-cross-origin", "permissions-policy": "camera=(), microphone=()",
};
function site(broken = {}) {
  return async (url, init = {}) => {
    const u = new URL(url), p = u.pathname, m = (init.method || "GET").toUpperCase();
    const res = (status, body = "", headers = {}) => new Response(body, { status, headers });
    if (u.protocol === "http:") return res(broken.noRedirect ? 200 : 301, "", { location: SITE + "/" });
    if (p === "/") return res(200, "<html>", broken.noHsts ? { ...goodHeaders, "strict-transport-security": "" } : goodHeaders);
    if (p === "/admin/") return res(200, "", { "x-robots-tag": "noindex, nofollow", "cache-control": "no-store", "content-security-policy": "connect-src 'self' https://*.supabase.co" });
    if (p === "/share/") return res(200, "", { "x-robots-tag": "noindex", "referrer-policy": "no-referrer" });
    if (p === "/robots.txt") return res(200, `Disallow: /admin/\nSitemap: ${broken.exampleDomain ? "https://example.org" : SITE}/sitemap.xml`);
    if (p === "/sitemap.xml") return res(200, `<loc>${broken.exampleDomain ? "https://example.org" : SITE}/</loc>`);
    if (p === "/.env") return res(broken.envExposed ? 200 : 404);
    if (p === "/api/ledger") return res(200, JSON.stringify({ totals: { received: 1 }, org: { acceptOnline: !!broken.payNoReg, fdacsReg: "" }, people: broken.leak ? [{ email: "a@b.com" }] : [] }));
    if (p === "/api/config") return res(200, JSON.stringify({ supabaseUrl: "https://abc.supabase.co", supabaseAnonKey: broken.serviceKey ? serviceKey : anonKey }));
    if (p === "/api/pledge") return res(broken.openPledge ? 201 : 403);
    if (p === "/api/stripe-webhook") return res(400);
    if (["/api/refund", "/api/notify", "/api/staff", "/api/health"].includes(p)) return res((broken.openStaff && p === "/api/staff") || (broken.openHealth && p === "/api/health") ? 200 : 403);
    if (["/api/give", "/api/plan"].includes(p)) return res(new Headers(init.headers).get("origin") !== SITE ? (broken.giveCrossSite ? 201 : 403) : broken.giveNoToken ? 201 : 404);
    if (p === "/api/checkout") return res(400);
    return res(404);
  };
}

test("a correct deployment passes every check", async () => {
  const r = await run(SITE, site());
  assert.deepEqual(r.filter((x) => !x.ok), []);
  assert.ok(r.length >= 15);
});
for (const [flaw, expect] of [["noRedirect", /http:\/\/ redirects/], ["noHsts", /HSTS/], ["exampleDomain", /real domain/], ["envExposed", /not downloadable/],
  ["leak", /personal data/], ["serviceKey", /anon key/], ["openPledge", /other websites/], ["openStaff", /Staff-only/], ["payNoReg", /personal data/],
  ["openHealth", /Staff-only|forged staff session/], ["giveNoToken", /private link/], ["giveCrossSite", /private link/]]) {
  test(`catches: ${flaw}`, async () => {
    const bad = (await run(SITE, site({ [flaw]: true }))).filter((x) => !x.ok);
    assert.ok(bad.some((x) => expect.test(x.name)), `${flaw} not caught: ${JSON.stringify(bad)}`);
  });
}
