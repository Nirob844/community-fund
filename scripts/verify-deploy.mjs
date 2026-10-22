// Post-deployment check. Run against the real site after every deploy:
//   node scripts/verify-deploy.mjs https://yourfund.org
// Checks HTTPS, security headers, private pages, exposed files, and that every API
// refuses what it should. Exits with code 1 if anything fails.

const PRIVATE_FILES = ["/.env", "/.env.example", "/package.json", "/netlify.toml", "/supabase/schema.sql", "/tests/e2e/run.mjs", "/.git/config", "/netlify/functions/pledge.mjs", "/README.md"];

export async function run(base, f = fetch) {
  base = base.replace(/\/$/, "");
  const results = [];
  const check = async (name, fn) => {
    try { const detail = await fn(); results.push({ name, ok: true, detail: detail || "" }); }
    catch (e) { results.push({ name, ok: false, detail: e.message }); }
  };
  const must = (cond, msg) => { if (!cond) throw new Error(msg); };
  const get = (p, init) => f(base + p, { redirect: "manual", ...init });
  const host = new URL(base).host;

  await check("Site uses HTTPS", async () => must(base.startsWith("https://"), "Use the https:// address"));
  await check("Plain http:// redirects to https://", async () => {
    const r = await f("http://" + host + "/", { redirect: "manual" });
    must([301, 302, 307, 308].includes(r.status) && /^https:/.test(r.headers.get("location") || ""), `got ${r.status}`);
  });

  const home = await get("/");
  const h = (k) => home.headers.get(k) || "";
  await check("Home page loads", async () => must(home.status === 200, `status ${home.status}`));
  await check("HSTS for at least a year", async () => { const m = h("strict-transport-security").match(/max-age=(\d+)/); must(m && Number(m[1]) >= 31536000, h("strict-transport-security") || "missing"); });
  await check("Content Security Policy is strict", async () => {
    const csp = h("content-security-policy");
    must(csp, "missing");
    for (const d of ["default-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'"]) must(csp.includes(d), `missing ${d}`);
    const script = (csp.match(/script-src([^;]*)/) || [])[1] || "";
    must(!/unsafe-inline|unsafe-eval/.test(script), "script-src allows unsafe code");
  });
  await check("No sniffing, no framing, private referrer", async () => {
    must(h("x-content-type-options") === "nosniff", "x-content-type-options");
    must(/deny/i.test(h("x-frame-options")), "x-frame-options");
    must(/strict-origin|no-referrer/.test(h("referrer-policy")), "referrer-policy");
    must(/camera=\(\)/.test(h("permissions-policy")), "permissions-policy");
  });
  await check("Staff console is hidden from search and never cached", async () => {
    const r = await get("/admin/");
    must(/noindex/.test(r.headers.get("x-robots-tag") || ""), "x-robots-tag");
    must(/no-store/.test(r.headers.get("cache-control") || ""), "cache-control");
    must(/supabase\.co/.test(r.headers.get("content-security-policy") || ""), "admin CSP must allow only Supabase");
  });
  await check("Private share page is not indexed and leaks no referrer", async () => {
    const r = await get("/share/");
    must(/noindex/.test(r.headers.get("x-robots-tag") || ""), "x-robots-tag");
    must(/no-referrer/.test(r.headers.get("referrer-policy") || ""), "referrer-policy");
  });
  await check("robots.txt and sitemap use the real domain", async () => {
    const robots = await (await get("/robots.txt")).text(), sm = await (await get("/sitemap.xml")).text();
    must(/Disallow: \/admin\//.test(robots), "robots must block /admin/");
    must(!/example\.org/.test(robots + sm), "still using example.org: run npm run set-domain");
    must(sm.includes(host), "sitemap does not mention " + host);
  });
  await check("Source, settings and test files are not downloadable", async () => {
    const open = [];
    for (const p of PRIVATE_FILES) { const r = await get(p); if (r.status === 200) open.push(p); }
    must(!open.length, "exposed: " + open.join(", "));
  });
  await check("Public ledger works and holds no personal data", async () => {
    const r = await get("/api/ledger"); must(r.status === 200, `status ${r.status}`);
    const text = await r.text(); const d = JSON.parse(text);
    must(d.totals && "received" in d.totals, "no totals");
    must(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text), "an email address appears in the public ledger");
    must(!/"(address|email|full_name|share_token|reference|deposit_ref)"/.test(text), "a private field appears in the public ledger");
    if (d.org?.acceptOnline) must(/^[A-Z]{1,3}\d{2,8}$/.test(d.org.fdacsReg || ""), "card payments are on without a registration number");
  });
  await check("Public config exposes only the anon key", async () => {
    const d = await (await get("/api/config")).json();
    must(/^https:\/\/.+\.supabase\.co/.test(d.supabaseUrl || ""), "supabaseUrl");
    const payload = JSON.parse(Buffer.from(String(d.supabaseAnonKey || "").split(".")[1] || "e30", "base64url").toString() || "{}");
    must(payload.role !== "service_role", "THE SERVICE ROLE KEY IS PUBLIC. Rotate it now.");
    must(payload.role === "anon" || /^sb_publishable_/.test(d.supabaseAnonKey || ""), "unexpected key type");
  });
  const post = (p, body, headers = {}) => get(p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  await check("Pledges from other websites are refused", async () => { const r = await post("/api/pledge", {}, { origin: "https://evil.example" }); must(r.status === 403, `status ${r.status}`); });
  await check("Unsigned Stripe webhooks are refused", async () => { const r = await post("/api/stripe-webhook", { type: "checkout.session.completed" }); must(r.status === 400, `status ${r.status}`); });
  await check("Staff-only endpoints refuse anonymous callers", async () => {
    const bad = [];
    for (const [p, m] of [["/api/refund", "POST"], ["/api/notify", "POST"], ["/api/staff", "GET"], ["/api/health", "GET"]]) {
      const r = m === "GET" ? await get(p) : await post(p, {}, { origin: base });
      if (![400, 401, 403].includes(r.status)) bad.push(`${p} → ${r.status}`);
    }
    must(!bad.length, bad.join(", "));
  });
  await check("Checkout refuses made-up pledges", async () => { const r = await post("/api/checkout", { pledgeId: "x" }, { origin: base }); must(r.status === 400, `status ${r.status}`); });
  await check("Giving-plan and give-again endpoints need a real private link", async () => {
    const bad = [];
    for (const p of ["/api/give", "/api/plan"]) {
      const r = await post(p, { t: "0".repeat(36), planId: "00000000-0000-4000-8000-000000000000", amount: 10 }, { origin: base });
      if (![400, 404, 409].includes(r.status)) bad.push(`${p} → ${r.status}`);
      const x = await post(p, { t: "0".repeat(36) }, { origin: "https://evil.example" });
      if (x.status !== 403) bad.push(`${p} from another site → ${x.status}`);
    }
    must(!bad.length, bad.join(", "));
  });
  await check("A forged staff session is refused by the system-health page", async () => {
    const r = await get("/api/health", { headers: { authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.e30.forged" } });
    must(r.status === 403, `status ${r.status}`);
  });
  return results;
}

if (process.argv[1] && (import.meta.url === `file://${process.argv[1]}` || import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`)) {
  const url = process.argv[2];
  if (!url) { console.error("Usage: node scripts/verify-deploy.mjs https://yourfund.org"); process.exit(2); }
  const results = await run(url);
  for (const r of results) console.log(`${r.ok ? "  ok  " : "  FAIL"} ${r.name}${r.detail ? "  (" + r.detail + ")" : ""}`);
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - bad} passed, ${bad} failed`);
  process.exit(bad ? 1 : 0);
}
