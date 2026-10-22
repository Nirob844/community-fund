// End-to-end browser tests. Serves public/ locally with the production Content Security
// Policy from netlify.toml, mocks the /api endpoints and the Supabase client, then checks
// every page for errors, layout, accessibility basics, SEO tags and working features.
// Run: npm run test:e2e   (first time: npx playwright install chromium)
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { chromium } from "playwright";
import { LEDGER, EMPTY_LEDGER, POSTS, fakeSupabaseModule } from "./fixtures.mjs";

const ROOT = new URL("../../public/", import.meta.url).pathname;
const toml = readFileSync(new URL("../../netlify.toml", import.meta.url), "utf8");
const cspFor = (path) => {
  const blocks = [...toml.matchAll(/for = "([^"]+)"[\s\S]*?(?=\[\[|$)/g)];
  let csp = "";
  for (const [blk, pat] of blocks) {
    const m = blk.match(/Content-Security-Policy = "([^"]+)"/); if (!m) continue;
    const re = new RegExp("^" + pat.replace(/\*/g, ".*") + "$");
    if (re.test(path)) csp = m[1];
  }
  return csp;
};
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".xml": "application/xml", ".txt": "text/plain", ".webmanifest": "application/manifest+json" };
const server = createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let f = join(ROOT, p);
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, "index.html");
  if (!existsSync(f)) { f = join(ROOT, "404.html"); res.statusCode = 404; }
  const type = TYPES[extname(f)] || "application/octet-stream";
  const headers = { "content-type": type };
  if (type === "text/html") headers["content-security-policy"] = cspFor(p.endsWith("/") ? p + "index.html" : p);
  res.writeHead(res.statusCode, headers); res.end(readFileSync(f));
}).listen(0);
const BASE = `http://localhost:${server.address().port}`;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let passed = 0, failed = 0; const failures = [];
async function check(name, fn) {
  try { await fn(); passed++; console.log("  ok  ", name); }
  catch (e) { failed++; failures.push(name); console.log("  FAIL", name, "\n       ", e.message.split("\n")[0]); }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

async function open(path, { width = 1280, scheme = "light", ledger = LEDGER, role = "treasurer", pledgeReply, shareReply, onPage } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme });
  const page = await ctx.newPage();
  const problems = [];
  page.on("console", (m) => { if (m.type() === "error" && !/fonts\.g/.test(m.text()) && !/Failed to load resource/.test(m.text())) problems.push(m.text()); });
  page.on("pageerror", (e) => problems.push(String(e)));
  await page.addInitScript((r) => { window.__role = r; }, role);
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.route(/challenges\.cloudflare\.com/, (r) => r.abort());
  await page.route(/cdn\.jsdelivr\.net\/npm\/@supabase/, (r) => r.fulfill({ contentType: "text/javascript", body: fakeSupabaseModule }));
  await page.route("**/api/ledger", (r) => r.fulfill({ json: ledger }));
  await page.route("**/api/config", (r) => r.fulfill({ json: { supabaseUrl: "https://mock.supabase.co", supabaseAnonKey: "anon", turnstileSiteKey: "" } }));
  await page.route("**/api/my-share*", (r) => r.fulfill({ json: shareReply || { label: "Peter P.", area: "Magnolia Point", pledged: 500, received: 500, fundReceived: 3000, fundExpenses: 61.25, availableToReturn: 2938.75, share: 0.1667, refund: 489.79 } }));
  await page.route("**/api/pledge", (r) => r.fulfill(pledgeReply || { status: 201, json: { ok: true, pledgeId: "p1", amount: 100, shareUrl: BASE + "/share/?t=" + "a".repeat(36) } }));
  await page.route("**/api/updates*", (r) => { const slug = new URL(r.request().url()).searchParams.get("slug"); r.fulfill(slug ? (slug === "county-replies" ? { json: POSTS.posts[0] } : { status: 404, json: { error: "Not found." } }) : { json: POSTS }); });
  await page.route("**/api/notify", (r) => r.fulfill({ json: { status: "sent" } }));
  await page.route("**/api/staff", (r) => r.fulfill({ json: { staff: [{ userId: "u-t", role: "treasurer", displayName: "Tess", active: true, email: "t@example.org", lastSignIn: null }], seatsUsed: 1, seats: 5 } }));
  onPage && (await onPage(page));
  await page.goto(BASE + path);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(300);
  return { page, ctx, problems };
}

async function commonChecks(page, problems, { indexable = true } = {}) {
  assert(problems.length === 0, "console/CSP errors: " + problems.join(" | "));
  const sw = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert(sw <= 0, `horizontal scroll of ${sw}px`);
  const a11y = await page.evaluate(() => {
    const issues = [];
    document.querySelectorAll("input:not([type=hidden]):not([tabindex='-1']), select, textarea").forEach((el) => {
      if (el.closest("[hidden]")) return;
      const named = (el.id && document.querySelector(`label[for="${el.id}"]`)) || el.closest("label") || el.getAttribute("aria-label") || el.getAttribute("aria-labelledby");
      if (!named) issues.push("unlabelled " + (el.id || el.tagName));
    });
    document.querySelectorAll("img").forEach((i) => { if (!i.hasAttribute("alt")) issues.push("img without alt"); });
    document.querySelectorAll("button, a[href]").forEach((b) => { if (!b.textContent.trim() && !b.getAttribute("aria-label")) issues.push("unnamed " + b.tagName); });
    if (document.querySelectorAll("h1").length !== 1) issues.push("h1 count " + document.querySelectorAll("h1").length);
    if (!document.documentElement.lang) issues.push("no lang");
    const ids = [...document.querySelectorAll("[id]")].map((e) => e.id); const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
    if (dup.length) issues.push("duplicate ids " + [...new Set(dup)].join(","));
    return issues;
  });
  assert(a11y.length === 0, "accessibility: " + a11y.join("; "));
  const seo = await page.evaluate(() => {
    const q = (s) => document.querySelector(s)?.getAttribute("content") || document.querySelector(s)?.getAttribute("href") || "";
    const out = { title: document.title, desc: q('meta[name="description"]'), canonical: q('link[rel="canonical"]'), robots: q('meta[name="robots"]'), og: q('meta[property="og:image"]'), ogt: q('meta[property="og:title"]'), ld: [] };
    document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => { try { out.ld.push(JSON.parse(s.textContent)); } catch { out.ld.push(null); } });
    return out;
  });
  assert(seo.title.length >= 20 && seo.title.length <= 95, `title length ${seo.title.length}`);
  assert(seo.desc.length >= 50 && seo.desc.length <= 170, `description length ${seo.desc.length}`);
  assert(/^https:\/\//.test(seo.canonical), "canonical missing");
  assert(seo.og && seo.ogt === seo.title, "Open Graph tags missing or mismatched");
  assert(!seo.ld.includes(null), "invalid JSON-LD");
  assert(indexable ? !/noindex/.test(seo.robots) : /noindex/.test(seo.robots), "robots meta wrong: " + seo.robots);
}

console.log("Public pages");
for (const [path, idx] of [["/", true], ["/transparency/", true], ["/stats/", true], ["/updates/", true], ["/live-local-act/", true], ["/park/", true], ["/privacy/", true], ["/share/?t=" + "a".repeat(36), false], ["/thanks/", false], ["/no-such-page", false]]) {
  for (const [width, scheme] of [[1280, "light"], [390, "light"], [390, "dark"]]) {
    await check(`${path} at ${width}px ${scheme}`, async () => {
      const { page, ctx, problems } = await open(path, { width, scheme });
      await commonChecks(page, problems, { indexable: idx });
      await ctx.close();
    });
  }
}

console.log("Home page features");
await check("totals, milestone scale and neighborhood chart render from the ledger", async () => {
  const { page, ctx } = await open("/");
  assert((await page.textContent("#tRec")) === "$3,000.00", "received tile");
  assert(/Milestone 1 of 3/.test(await page.textContent("#stageLabel")), "stage label");
  assert((await page.locator("#ladder li").count()) === 3, "ladder rows");
  assert((await page.locator("#nbChart .hb").count()) === 4, "chart rows");
  const w = await page.$eval("#stageBar span", (e) => parseFloat(e.style.width));
  assert(Math.abs(w - 30) < 0.01, "progress width " + w);
  await ctx.close();
});
await check("scale moves to the next milestone after $10,000", async () => {
  const big = structuredClone(LEDGER); big.totals.received = 250000;
  const { page, ctx } = await open("/", { ledger: big });
  assert(/Milestone 2 of 3/.test(await page.textContent("#stageLabel")), "should be on milestone 2");
  assert((await page.locator("#ladder li.done").count()) === 1, "one milestone reached");
  await ctx.close();
});
await check("pledge form validates before sending", async () => {
  const { page, ctx } = await open("/");
  await page.click("#pSubmit");
  assert(/fill in your name/.test(await page.textContent("#pMsg")), "missing-fields message");
  await page.fill("#pName", "Maria Gomez"); await page.fill("#pEmail", "m@example.org"); await page.fill("#pAddr", "12 Oak St"); await page.fill("#pArea", "Magnolia Point");
  await page.click("#pSubmit");
  assert(/privacy/.test(await page.textContent("#pMsg")), "consent message");
  await ctx.close();
});
await check("pledge saves and offers the private share link", async () => {
  const { page, ctx } = await open("/");
  await page.fill("#pName", "Maria Gomez"); await page.fill("#pEmail", "m@example.org"); await page.fill("#pAddr", "12 Oak St"); await page.fill("#pArea", "Magnolia Point");
  await page.click('.amounts button[data-amt="250"]');
  assert((await page.inputValue("#pAmt")) === "250", "amount chip");
  await page.check("#pConsent"); await page.click("#pSubmit");
  await page.waitForSelector("#pMsg a");
  assert(/share link/i.test(await page.textContent("#pMsg")), "share link text");
  await ctx.close();
});
await check("server errors are shown to the person", async () => {
  const { page, ctx } = await open("/", { pledgeReply: { status: 400, json: { error: "Please complete the security check and try again." } } });
  await page.fill("#pName", "A B"); await page.fill("#pEmail", "a@b.org"); await page.fill("#pAddr", "1 St"); await page.fill("#pArea", "X");
  await page.check("#pConsent"); await page.click("#pSubmit");
  await page.waitForFunction(() => /security check/.test(document.getElementById("pMsg").textContent));
  await ctx.close();
});
await check("empty fund shows friendly empty states, not errors", async () => {
  const { page, ctx, problems } = await open("/", { ledger: EMPTY_LEDGER });
  assert(problems.length === 0, problems.join("|"));
  assert(/appear as pledges come in/.test(await page.textContent("#nbChart")), "empty chart text");
  await ctx.close();
});
await check("names with markup are shown as text, never run", async () => {
  const evil = structuredClone(LEDGER); evil.receipts[0].label = '<img src=x onerror="window.__xss=1">';
  const { page, ctx } = await open("/transparency/", { ledger: evil });
  assert(!(await page.evaluate(() => window.__xss)), "script ran");
  assert(/<img/.test(await page.textContent("#incomeRows")), "label should be visible as text");
  await ctx.close();
});

console.log("Statistics page");
await check("key figures and every chart render", async () => {
  const { page, ctx } = await open("/stats/");
  assert((await page.textContent("#kRec")) === "$3,000.00", "raised");
  assert((await page.textContent("#kPeople")) === "4", "people " + (await page.textContent("#kPeople")));
  assert((await page.textContent("#kAreas")) === "4", "areas");
  assert((await page.textContent("#kMedian")) === "$500.00", "median " + (await page.textContent("#kMedian")));
  assert((await page.locator("#nbChart .hb").count()) === 4, "community bars");
  assert(await page.locator("#timeChart svg path.line").count() === 1, "line chart");
  assert(await page.locator("#sizeChart svg path.bar").count() >= 2, "size columns");
  assert((await page.locator("#methodChart .hb").count()) === 3, "method bars");
  assert((await page.locator("#spendChart .hb").count()) === 1, "spend bars");
  assert((await page.locator("#monthRows tr").count()) === 1, "month rows");
  assert(/leads with/.test(await page.textContent("#topArea")), "top area sentence");
  await ctx.close();
});
await check("chart tooltips work by mouse and keyboard", async () => {
  const { page, ctx } = await open("/stats/");
  await page.hover("#nbChart .hb >> nth=0");
  assert(!(await page.isHidden("#tip")), "tooltip on hover");
  await page.focus("#nbChart .hb >> nth=1");
  assert(/Received/.test(await page.textContent("#tip")), "tooltip on focus");
  await page.hover("#timeChart svg rect.hit");
  assert(/Running total/.test(await page.textContent("#tip")), "line tooltip");
  await ctx.close();
});

console.log("Transparency page");
await check("statements balance", async () => {
  const { page, ctx } = await open("/transparency/");
  const t = await page.textContent("#balanceSheet");
  assert(/Netassets\$2,938\.75/.test(t.replace(/\s+/g, "")), "net assets");
  assert(/Netsurplus\$2,938\.75/.test((await page.textContent("#incomeStmt")).replace(/\s+/g, "")), "net surplus");
  assert((await page.locator("#shareRows tr").count()) === 3, "share rows");
  await ctx.close();
});

console.log("Staff console");
const signedIn = async (role, opts = {}) => { const o = await open("/admin/", { role, ...opts }); await o.page.waitForSelector("#console:not([hidden])"); return o; };
const tabsFor = async (page) => page.$$eval(".ctabs [role=tab]", (bs) => bs.filter((b) => !b.hidden).map((b) => b.dataset.ctab));
await check("each role sees only the sections it may use", async () => {
  const want = { treasurer: ["record", "pledges", "money", "people", "closing", "news", "records", "team", "settings", "system"], recorder: ["record", "pledges", "money", "people", "closing", "records"],
    auditor: ["pledges", "money", "people", "closing", "records", "system"], developer: ["system"] };
  for (const role of Object.keys(want)) {
    const { page, ctx, problems } = await signedIn(role);
    const got = await tabsFor(page);
    assert(JSON.stringify(got) === JSON.stringify(want[role]), `${role}: ${got.join(",")}`);
    assert(problems.length === 0, problems.join("|"));
    if (role === "recorder") assert(await page.isHidden("#eForm"), "recorder sees expense form");
    await ctx.close();
  }
});
await check("totals come from the database calculation", async () => {
  const { page, ctx } = await signedIn("auditor");
  assert((await page.textContent("#tRec")) === "$600.00", "received " + (await page.textContent("#tRec")));
  assert((await page.evaluate(() => window.__rpc.map((r) => r.name))).includes("ledger_totals"), "ledger_totals rpc");
  await ctx.close();
});
await check("recorder records a pledge for a brand-new person", async () => {
  const { page, ctx } = await signedIn("recorder");
  await page.fill("#plName", "jo king jr"); await page.fill("#plArea", "Tuttle Avenue"); await page.fill("#plAmt", "250");
  await page.click("#plForm button[type=submit]");
  await page.waitForFunction(() => /saved/.test(document.getElementById("plMsg").textContent));
  const w = await page.evaluate(() => window.__writes);
  assert(w[0].table === "contributors" && w[0].row.public_label === "Jo J." && w[0].row.email === "", JSON.stringify(w[0]));
  assert(w[1].table === "pledges" && w[1].row.amount === 250 && w[1].row.source === "staff", JSON.stringify(w[1]));
  await ctx.close();
});
await check("search finds an existing person; deposit suggests what is owed and emails a receipt", async () => {
  const notified = [];
  const { page, ctx } = await signedIn("recorder", { onPage: (p) => p.route("**/api/notify", (r) => { notified.push(JSON.parse(r.request().postData())); r.fulfill({ json: { status: "sent" } }); }) });
  await page.fill("#rFind", "jo");
  await page.waitForSelector("#rResults li");
  await page.click("#rResults li >> nth=0");
  await page.waitForFunction(() => /Still owed: \$150\.00/.test(document.getElementById("rOwed").textContent));
  await page.waitForSelector("#rPlanBox:not([hidden])");
  assert(/payment 3 of 5/.test(await page.textContent("#rPlan")), "offers her giving plan");
  assert((await page.inputValue("#rAmt")) === "50.00", "suggests the plan payment");
  await page.selectOption("#rPlan", "");
  await page.fill("#rAmt", "150");
  assert(await page.isHidden("#rNew"), "new-person fields should hide");
  await page.fill("#rDep", "DEP-1");
  await page.click("#rForm button[type=submit]");
  await page.waitForFunction(() => /saved/.test(document.getElementById("rMsg").textContent));
  const r = (await page.evaluate(() => window.__writes)).find((x) => x.table === "receipts");
  assert(r.row.contributor_id === "C2" && r.row.amount === 150 && r.row.public_label === "Jo K." && r.row.deposit_ref === "DEP-1" && !r.row.plan_id, JSON.stringify(r));
  assert(notified.length === 1 && notified[0].kind === "receipt", "receipt email " + JSON.stringify(notified));
  assert(/receipt was emailed/.test(await page.textContent("#rMsg")), "message mentions email");
  await ctx.close();
});
await check("future-dated deposits are refused", async () => {
  const { page, ctx } = await signedIn("recorder");
  await page.fill("#rAmt", "10"); await page.fill("#rDate", "2099-01-01"); await page.click("#rForm button[type=submit]");
  assert(/future/.test(await page.textContent("#rMsg")), "future date message");
  await ctx.close();
});
await check("treasurer edits, withdraws and reinstates pledges", async () => {
  const { page, ctx } = await signedIn("treasurer");
  await page.click('[data-ctab="pledges"]');
  await page.waitForSelector("#pledgeRows tr td");
  await page.click("#pledgeRows tr >> nth=1 >> text=Edit");
  await page.fill('#pledgeRows input[aria-label="Pledge amount"]', "300");
  await page.click("#pledgeRows >> text=Save");
  await page.waitForTimeout(200);
  let w = (await page.evaluate(() => window.__writes)).filter((x) => x.table === "pledges");
  assert(w[0].op === "update" && w[0].row.amount === 300, JSON.stringify(w));
  await page.click("#pledgeRows tr >> nth=1 >> text=Withdraw"); await page.click("#pledgeRows >> text=Yes");
  await page.waitForTimeout(200);
  w = (await page.evaluate(() => window.__writes)).filter((x) => x.table === "pledges");
  assert(w[1].row.status === "withdrawn", "withdraw");
  await page.waitForSelector("#pledgeRows >> text=Reinstate");
  await ctx.close();
});
await check("recorders can't edit pledges; filters narrow the list", async () => {
  const { page, ctx } = await signedIn("recorder");
  await page.click('[data-ctab="pledges"]'); await page.waitForSelector("#pledgeRows tr td");
  assert((await page.locator("#pledgeRows button").count()) === 0, "recorder sees pledge buttons");
  await page.selectOption("#pgStatus", "paid"); await page.waitForTimeout(150);
  assert((await page.locator("#pledgeRows tr").count()) === 1, "status filter");
  await page.selectOption("#pgStatus", ""); await page.fill("#pgSearch", "peter"); await page.waitForTimeout(500);
  assert(/Peter Powell/.test(await page.textContent("#pledgeRows")) && !/Jo King/.test(await page.textContent("#pledgeRows")), "search filter");
  await ctx.close();
});
await check("manual refund of a check deposit is recorded and the person is emailed", async () => {
  const notified = [];
  const { page, ctx } = await signedIn("treasurer", { onPage: (p) => p.route("**/api/notify", (r) => { notified.push(JSON.parse(r.request().postData())); r.fulfill({ json: { status: "sent" } }); }) });
  await page.click('[data-ctab="money"]'); await page.waitForSelector("#depositRows tr td");
  await page.click("#depositRows tr:has-text('Jo K.') >> text=Refund");
  await page.waitForSelector("#rfForm:not([hidden])");
  assert((await page.inputValue("#rfAmt")) === "100.00", "defaults to what is left");
  await page.fill("#rfAmt", "40"); await page.selectOption("#rfMethod", "Zelle"); await page.fill("#rfReason", "Overpaid");
  await page.click("#rfForm button[type=submit]"); await page.waitForTimeout(250);
  const f = (await page.evaluate(() => window.__writes)).find((x) => x.table === "refunds");
  assert(f && f.row.amount === 40 && f.row.method === "Zelle" && f.row.kind === "refund" && f.row.receipt_id === "R2", JSON.stringify(f));
  assert(notified.some((n) => n.kind === "refund"), "refund email");
  await ctx.close();
});
await check("card refunds go through the server (Stripe), never straight to the database", async () => {
  const calls = [];
  const { page, ctx } = await signedIn("treasurer", { onPage: (p) => p.route("**/api/refund", (r) => { calls.push(JSON.parse(r.request().postData())); r.fulfill({ json: { ok: true } }); }) });
  await page.click('[data-ctab="money"]'); await page.waitForSelector("#depositRows tr td");
  await page.click("#depositRows tr:has-text('Peter P.') >> text=Refund");
  await page.fill("#rfAmt", "25"); await page.click("#rfForm button[type=submit]"); await page.waitForTimeout(250);
  assert(calls.length === 1 && calls[0].receiptId === "R1" && calls[0].amount === 25, JSON.stringify(calls));
  assert(!(await page.evaluate(() => window.__writes)).some((x) => x.table === "refunds"), "should not insert directly");
  await page.click("#depositRows tr:has-text('Peter P.') >> text=Refund");
  await page.fill("#rfAmt", "9999"); await page.click("#rfForm button[type=submit]");
  assert(/up to \$500\.00/.test(await page.textContent("#rfMsg")), "over-refund blocked");
  await ctx.close();
});
await check("people: edit details, combine duplicates and erase on request", async () => {
  const { page, ctx } = await signedIn("treasurer");
  await page.click('[data-ctab="people"]'); await page.waitForSelector("#peopleRows tr td");
  await page.click("#peopleRows tr:has-text('Jo King') >> text=Edit");
  await page.fill("#cAddr", "9 Tuttle Ave"); await page.click("#cForm button[type=submit]"); await page.waitForTimeout(200);
  const u = (await page.evaluate(() => window.__writes)).find((x) => x.table === "contributors");
  assert(u.op === "update" && u.row.address === "9 Tuttle Ave", JSON.stringify(u));
  await page.click("#peopleRows tr:has-text('Jo King') >> text=Combine");
  await page.fill("#mFind", "peter"); await page.waitForSelector("#mResults li"); await page.click("#mResults li >> nth=0");
  await page.click("#mForm button[type=submit]"); await page.waitForTimeout(200);
  let rpc = await page.evaluate(() => window.__rpc);
  assert(rpc.some((r) => r.name === "merge_contributors" && r.args.src === "C2" && r.args.dst === "C1"), JSON.stringify(rpc));
  await page.click("#peopleRows tr:has-text('Peter Powell') >> text=Erase"); await page.click("#peopleRows >> text=Yes"); await page.waitForTimeout(200);
  rpc = await page.evaluate(() => window.__rpc);
  assert(rpc.some((r) => r.name === "anonymize_contributor" && r.args.cid === "C1"), "erase rpc");
  await ctx.close();
});
await check("closing: stop pledges, see the exact plan, record a payout and email it", async () => {
  const notified = [];
  const { page, ctx } = await signedIn("treasurer", { onPage: (p) => p.route("**/api/notify", (r) => { notified.push(JSON.parse(r.request().postData())); r.fulfill({ json: { status: "sent" } }); }) });
  await page.click('[data-ctab="closing"]'); await page.waitForSelector("#planRows tr td");
  assert(/unpaid bills/.test(await page.textContent("#clMsg")), "warns about unpaid bills");
  assert(await page.locator("#planRows >> text=Record payout").count() === 0, "no payouts while open");
  await page.click("#clStart"); await page.click("text=Yes"); await page.waitForTimeout(300);
  const s = (await page.evaluate(() => window.__writes)).find((x) => x.table === "settings");
  assert(s.row.fund_status === "closing", JSON.stringify(s));
  await page.waitForSelector("#planRows >> text=Record payout");
  await page.click("#planRows tr:has-text('Jo King') >> text=Record payout"); await page.waitForTimeout(300);
  const p = (await page.evaluate(() => window.__writes)).find((x) => x.table === "refunds");
  assert(p.row.kind === "closing_payout" && p.row.amount === 73.21 && p.row.contributor_id === "C2", JSON.stringify(p));
  assert(notified.some((n) => n.kind === "payout"), "payout email");
  const dl = page.waitForEvent("download"); await page.click("#clCsv"); const file = await dl;
  assert(/payout-plan/.test(file.suggestedFilename()), "plan csv");
  await ctx.close();
});
await check("updates: treasurer writes and publishes a news post", async () => {
  const { page, ctx } = await signedIn("treasurer");
  await page.click('[data-ctab="news"]');
  await page.fill("#nHead", "County replies to residents!"); await page.fill("#nSummary", "Short summary"); await page.fill("#nBody", "Para one.\n\nPara two.");
  assert((await page.inputValue("#nSlug")) === "county-replies-to-residents", "slug " + (await page.inputValue("#nSlug")));
  await page.check("#nPub"); await page.click("#nForm button[type=submit]"); await page.waitForTimeout(200);
  const w = (await page.evaluate(() => window.__writes)).find((x) => x.table === "posts");
  assert(w.row.published === true && w.row.slug === "county-replies-to-residents", JSON.stringify(w));
  await page.waitForSelector("#newsRows >> text=Published");
  await ctx.close();
});
await check("audit log reads in plain words; every export downloads", async () => {
  const { page, ctx } = await signedIn("auditor");
  await page.click('[data-ctab="records"]'); await page.waitForSelector("#auditRows tr td");
  assert(/Tess/.test(await page.textContent("#auditRows")) && /Added/.test(await page.textContent("#auditRows")), "audit row");
  for (const k of ["journal", "receipts", "refunds", "expenses", "pledges", "contributors", "audit", "emails"]) {
    const dl = page.waitForEvent("download"); await page.click(`[data-export="${k}"]`); const f = await dl;
    assert(f.suggestedFilename().startsWith(k), k);
  }
  await ctx.close();
});
await check("hardening: integrity status, neighborhood renaming, registration format", async () => {
  const { page, ctx } = await signedIn("treasurer");
  await page.click('[data-ctab="records"]');
  await page.waitForFunction(() => /Integrity verified/.test(document.getElementById("auIntegrity").textContent));
  await page.click('[data-ctab="settings"]'); await page.waitForSelector("#areaRows tr td");
  const row = page.locator("#areaRows tr", { hasText: "Tuttle Avenue" });
  await row.locator("input").fill("Magnolia Point"); await row.locator("text=Apply").click();
  await page.waitForFunction(() => /Renamed/.test(document.getElementById("aMsg").textContent));
  const rpc = await page.evaluate(() => window.__rpc);
  assert(rpc.some((r) => r.name === "rename_area" && r.args.old_name === "Tuttle Avenue" && r.args.new_name === "Magnolia Point"), JSON.stringify(rpc));
  await page.fill("#sReg", "abc"); await page.click("#sForm button[type=submit]");
  assert(/look like CH12345/.test(await page.textContent("#sMsg")), "registration format");
  await ctx.close();
});
await check("non-staff accounts are signed out", async () => {
  const { page, ctx } = await open("/admin/", { role: "" });
  await page.waitForFunction(() => /not an active team member/.test(document.getElementById("authMsg").textContent));
  await ctx.close();
});
await check("staff console has no sideways scrolling on a phone, on any tab", async () => {
  const { page, ctx } = await signedIn("treasurer", { width: 390 });
  for (const t of await tabsFor(page)) {
    await page.click(`[data-ctab="${t}"]`); await page.waitForTimeout(150);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert(over <= 0, `${t} overflows by ${over}px`);
  }
  await ctx.close();
});

console.log("Giving plans, limits, goal prompts (v3.2)");
const capture = (pattern, reply) => { const got = []; return { got, hook: (p) => p.route(pattern, (r) => { got.push({ body: JSON.parse(r.request().postData() || "{}"), auth: r.request().headers().authorization || "" }); r.fulfill(typeof reply === "function" ? reply(got.at(-1)) : reply); }) }; };
const both = (...hooks) => async (p) => { for (const h of hooks) await h(p); };
await check("goal prompts say what it takes, worked out from the live figures", async () => {
  const { page, ctx } = await open("/");
  assert(!(await page.isHidden("#prompts")), "prompts panel shown");
  const t = await page.textContent("#promptList");
  assert(/\$7,000 to go to reach “Retain a land use attorney”/.test(t), t);
  assert(/\$1,150 is already pledged\. When every pledge is paid, we'll be 41% of the way there\./.test(t), t);
  assert(/24 more neighbors giving \$250 would close the gap/.test(t), t);
  assert(/Prospect Road leads with \$2,400 received\. Magnolia Point is \$1,900 behind\./.test(t), t);
  assert(/Help reach/.test(await page.textContent("#promptHead")), "headline");
  assert(/\$100\.00 is 1\.4% of what's still needed/.test(await page.textContent("#impact")), await page.textContent("#impact"));
  await ctx.close();
});
await check("prompts follow the treasurer's headline and target date, and can be switched off", async () => {
  const L = structuredClone(LEDGER); L.goal = { promptsEnabled: true, headline: "Hire the attorney by year end", deadline: new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10) };
  let o = await open("/", { ledger: L });
  assert((await o.page.textContent("#promptHead")) === "Hire the attorney by year end", "custom headline");
  assert(/a day for (10|11) days/.test(await o.page.textContent("#promptList")), await o.page.textContent("#promptList"));
  await o.ctx.close();
  L.goal.promptsEnabled = false;
  o = await open("/", { ledger: L });
  assert(await o.page.isHidden("#prompts"), "prompts hidden when switched off");
  await o.ctx.close();
});
await check("suggested amounts and limits follow the treasurer's settings", async () => {
  const L = structuredClone(LEDGER); L.limits = { ...L.limits, minGift: 10, maxPledge: 5000, suggestedAmounts: [10, 20, 40] };
  const { page, ctx } = await open("/", { ledger: L });
  assert(JSON.stringify(await page.$$eval("#amtChips button", (b) => b.map((x) => x.textContent))) === '["$10","$20","$40"]', "chips");
  await page.fill("#pName", "A B"); await page.fill("#pEmail", "a@b.org"); await page.fill("#pAddr", "1 St"); await page.fill("#pArea", "X");
  await page.fill("#pAmt", "6000"); await page.check("#pConsent"); await page.click("#pSubmit");
  assert(/between \$10\.00 and \$5,000\.00/.test(await page.textContent("#pMsg")), await page.textContent("#pMsg"));
  assert(await page.isHidden("#giveType"), "no plan option while plans are off");
  await ctx.close();
});
await check("a donor sets up smaller payments over time and goes to the secure page", async () => {
  const L = structuredClone(LEDGER); L.org.acceptOnline = true; L.limits.allowPlans = true;
  const pl = capture("**/api/pledge", { status: 201, json: { ok: true, pledgeId: "p9", planId: "g9", amount: 150, plan: { installment: 25, frequency: "monthly", payments: 6 }, shareUrl: null } });
  const co = capture("**/api/checkout", { json: { url: "/thanks/?session_id=cs_1&plan=1" } });
  const { page, ctx, problems } = await open("/", { ledger: L, onPage: both(pl.hook, co.hook) });
  await page.click("#gPlan");
  assert(!(await page.isHidden("#planBox")), "plan fields shown");
  assert((await page.textContent("#amtLabel")) === "Each payment", "label");
  await page.fill("#pAmt", "25"); await page.fill("#pCount", "6"); await page.dispatchEvent("#pCount", "input");
  assert(/6 payments of \$25\.00 = \$150\.00/.test(await page.textContent("#impact")), await page.textContent("#impact"));
  await page.fill("#pName", "Maria Gomez"); await page.fill("#pEmail", "m@example.org"); await page.fill("#pAddr", "12 Oak St"); await page.fill("#pArea", "Magnolia Point");
  await page.check("#pConsent"); await page.click("#pSubmit");
  await page.waitForURL(/thanks/);
  assert(pl.got[0].body.amount === 25 && pl.got[0].body.plan.frequency === "monthly" && pl.got[0].body.plan.payments === 6, JSON.stringify(pl.got[0].body));
  assert(co.got[0].body.planId === "g9" && !co.got[0].body.pledgeId, JSON.stringify(co.got[0].body));
  await page.waitForLoadState("networkidle");
  assert(/giving plan is set up/.test(await page.textContent("#thanksLede")), "thanks page explains the plan");
  assert(problems.length === 0, problems.join("|"));
  await ctx.close();
});
const SHARE = { label: "Jo K.", area: "Tuttle Avenue", pledged: 250, received: 100, owed: 150, fundReceived: 3000, fundExpenses: 61.25, availableToReturn: 2938.75, share: 0.0333, refund: 97.96,
  acceptOnline: true, fundStatus: "open", limits: { minGift: 5, maxGift: 1000, allowPlans: true, maxPlanPayments: 12, suggestedAmounts: [10, 25, 50] },
  plans: [{ id: "g1", installment: 25, frequency: "monthly", payments: 6, paidCount: 2, paidTotal: 50, status: "active", method: "card", nextDue: "2026-12-01", startOn: "2026-10-01" },
    { id: "g0", installment: 10, frequency: "weekly", payments: 4, paidCount: 4, paidTotal: 40, status: "completed", method: "card", nextDue: null, startOn: "2026-08-01" }] };
await check("a donor's private page lists their plans and can stop one", async () => {
  const pc = capture("**/api/plan", { json: { ok: true, status: "cancelled" } });
  const { page, ctx, problems } = await open("/share/?t=" + "a".repeat(36), { shareReply: SHARE, onPage: pc.hook });
  await page.waitForSelector(".plan-card");
  const t = await page.textContent(".plans-list");
  assert(/\$25\.00 every month/.test(t) && /2 of 6 payments made/.test(t) && /Active/.test(t) && /Completed/.test(t), t);
  assert((await page.locator(".plan-card >> text=Stop this plan").count()) === 1, "only the active plan can be stopped");
  await page.click("text=Stop this plan"); await page.click("text=Yes, stop it");
  await page.waitForFunction(() => /has stopped/.test(document.getElementById("shareMsg")?.textContent || ""));
  assert(pc.got[0].body.planId === "g1" && pc.got[0].body.t === "a".repeat(36), JSON.stringify(pc.got));
  assert(problems.length === 0, problems.join("|"));
  await ctx.close();
});
await check("a donor can pay what they still owe, or give again with a new plan, from their page", async () => {
  const gv = capture("**/api/give", { status: 201, json: { url: "/thanks/" } });
  const { page, ctx } = await open("/share/?t=" + "a".repeat(36), { shareReply: SHARE, onPage: gv.hook });
  await page.waitForSelector("#payOwed");
  assert(/\$150\.00/.test(await page.textContent("#payOwed")), "owed amount");
  await page.click("#payOwed"); await page.waitForURL(/thanks/);
  assert(gv.got[0].body.payOwed === true, JSON.stringify(gv.got[0]));
  await page.goto(BASE + "/share/"); await page.waitForSelector("#gaForm");
  await page.click("#gaPlan"); await page.click('#gaForm .amounts button[data-amt="10"]'); await page.fill("#gaCount", "4");
  await page.click("#gaGo"); await page.waitForURL(/thanks/);
  const b = gv.got[1].body;
  assert(b.amount === 10 && b.plan.payments === 4 && b.plan.frequency === "monthly" && b.t === "a".repeat(36), JSON.stringify(b));
  await ctx.close();
});

console.log("Developer access, activity log and handover (v3.2)");
const HEALTH = { version: "abc1234", context: "production", stripeMode: "live", env: { SUPABASE_URL: true, STRIPE_SECRET_KEY: true, LOG_SALT: false },
  security: { ok: true, checks: [{ name: "Row Level Security on every table", ok: true, detail: "" }, { name: "The public (anon) key can run no database function", ok: true, detail: "" }] }, activity: { issuesLast7Days: 1 } };
await check("a developer sees only system checks and the activity log, never people or money", async () => {
  const hc = capture("**/api/health", { json: HEALTH });
  const { page, ctx, problems } = await signedIn("developer", { onPage: hc.hook });
  assert(JSON.stringify(await tabsFor(page)) === '["system"]', (await tabsFor(page)).join(","));
  assert(await page.isHidden("#staffSum"), "fund totals hidden");
  assert(/Developer access/.test(await page.textContent("#fundBanner")), "developer banner");
  assert(await page.isHidden("#hoConfirm"), "developer can't confirm a handover");
  await page.waitForSelector("#activityRows tr td");
  await page.click("#hRun"); await page.waitForSelector("#secRows >> text=Passed");
  assert(/Not configured: LOG_SALT/.test(await page.textContent("#envLine")), await page.textContent("#envLine"));
  assert(hc.got.length === 1 && /^Bearer /.test(hc.got[0].auth), "health called with the session");
  const seen = await page.evaluate(() => window.__writes.length);
  assert(seen === 0, "developer wrote nothing");
  assert(problems.length === 0, problems.join("|"));
  await ctx.close();
});
await check("the treasurer invites a developer for a set time and can remove them at once", async () => {
  const staffGot = [];
  const team = { staff: [{ userId: "u-t", role: "treasurer", displayName: "Tess", active: true, email: "t@example.org", lastSignIn: null },
    { userId: "u-d", role: "developer", displayName: "Dev", active: true, email: "d@example.org", lastSignIn: null, accessExpiresAt: new Date(Date.now() + 3 * 86400000).toISOString(), purpose: "Fix receipt emails" }], seatsUsed: 1, seats: 5 };
  const { page, ctx } = await signedIn("treasurer", { onPage: (p) => p.route("**/api/staff", (r) => {
    const m = r.request().method(); if (m !== "GET") staffGot.push({ m, body: JSON.parse(r.request().postData() || "{}") });
    r.fulfill(m === "POST" ? { status: 201, json: { ok: true, userId: "u-n", accessExpiresAt: new Date(Date.now() + 7 * 86400000).toISOString() } } : { json: m === "GET" ? team : { ok: true } });
  }) });
  await page.click('[data-ctab="team"]'); await page.waitForSelector("#teamRows tr td");
  assert(/Access until/.test(await page.textContent("#teamRows")) && /Issue: Fix receipt emails/.test(await page.textContent("#teamRows")), "developer row");
  await page.selectOption("#tRole", "developer");
  assert(!(await page.isHidden("#tDevBox")), "developer fields");
  await page.fill("#tName", "New Dev"); await page.fill("#tEmail", "nd@example.org"); await page.fill("#tPurpose", "Stripe webhook errors");
  await page.click("#tAdd"); await page.waitForFunction(() => /Developer invited until/.test(document.getElementById("tMsg").textContent));
  assert(staffGot[0].body.role === "developer" && staffGot[0].body.days === 7 && staffGot[0].body.purpose === "Stripe webhook errors", JSON.stringify(staffGot[0]));
  await page.click("#teamRows >> text=Remove access now"); await page.click("#teamRows >> text=Yes");
  await page.waitForTimeout(200);
  assert(staffGot.some((x) => x.m === "PATCH" && x.body.userId === "u-d" && x.body.active === false), JSON.stringify(staffGot));
  await ctx.close();
});
await check("the treasurer raises and lowers limits and goals, and switches prompts", async () => {
  const { page, ctx } = await signedIn("treasurer");
  await page.click('[data-ctab="settings"]'); await page.waitForSelector("#goalRows tr");
  assert((await page.locator("#goalRows tr").count()) === 2, "two goals loaded");
  await page.fill("#sMin", "600"); await page.fill("#sMax", "500"); await page.click("#sForm button[type=submit]");
  assert(/smallest gift must be below the largest/.test(await page.textContent("#sMsg")), await page.textContent("#sMsg"));
  await page.fill("#sMin", "10"); await page.fill("#sMax", "500"); await page.fill("#sMaxDep", "5000"); await page.fill("#sPlanMax", "12");
  await page.fill('#goalRows input[aria-label="Goal 1 amount"]', "15000");
  await page.click("#goalRows tr >> nth=1 >> text=Remove");
  await page.click("#goalAdd"); await page.fill('#goalRows tr >> nth=1 >> input.g-amt', "3000000"); await page.fill('#goalRows tr >> nth=1 >> input.g-title', "Buy and restore the land");
  await page.fill("#sAmounts", "$40, 10, 20"); await page.uncheck("#sPrompts"); await page.fill("#sHeadline", "Hire the attorney");
  await page.click("#sForm button[type=submit]");
  await page.waitForFunction(() => /Settings saved/.test(document.getElementById("sMsg").textContent));
  const w = (await page.evaluate(() => window.__writes)).find((x) => x.table === "settings");
  const r = w.row;
  assert(r.min_gift === 10 && r.max_gift === 500 && r.max_deposit === 5000 && r.max_plan_payments === 12 && r.prompts_enabled === false && r.prompt_headline === "Hire the attorney", JSON.stringify(r));
  assert(JSON.stringify(r.suggested_amounts) === "[10,20,40]", JSON.stringify(r.suggested_amounts));
  assert(JSON.stringify(r.milestones.map((m) => m.amount)) === "[15000,3000000]", JSON.stringify(r.milestones));
  await ctx.close();
});
await check("a recorder records a giving plan collected by hand", async () => {
  const { page, ctx } = await signedIn("recorder");
  await page.fill("#plName", "Ann Arbor"); await page.fill("#plArea", "Whitfield");
  await page.check("#plPlan"); await page.fill("#plInst", "50"); await page.fill("#plCount", "4"); await page.dispatchEvent("#plCount", "input");
  assert((await page.inputValue("#plAmt")) === "200.00" && (await page.$eval("#plAmt", (e) => e.readOnly)), "total worked out");
  await page.click("#plForm button[type=submit]");
  await page.waitForFunction(() => /Giving plan saved/.test(document.getElementById("plMsg").textContent));
  const w = await page.evaluate(() => window.__writes);
  const p = w.find((x) => x.table === "pledges"), g = w.find((x) => x.table === "giving_plans");
  assert(p.row.amount === 200 && /50\.00 monthly x 4/.test(p.row.note), JSON.stringify(p));
  assert(g.row.method === "manual" && g.row.installment === 50 && g.row.payments === 4 && g.row.frequency === "monthly", JSON.stringify(g));
  await ctx.close();
});
await check("giving plans are listed; the treasurer stops one through the server", async () => {
  const pc = capture("**/api/plan", { json: { ok: true } });
  const { page, ctx } = await signedIn("treasurer", { onPage: pc.hook });
  await page.click('[data-ctab="pledges"]'); await page.waitForSelector("#gplanRows tr td");
  const row = page.locator("#gplanRows tr", { hasText: "Jo King" });
  const t = await row.textContent();
  assert(/2 of 5/.test(t) && /2026-12-11/.test(t) && /Active/.test(t) && /paid by hand/.test(t), t);
  await row.locator("text=Stop plan").click(); await page.click("#gplanRows >> text=Yes"); await page.waitForTimeout(200);
  assert(pc.got[0].body.planId === "G1" && /^Bearer /.test(pc.got[0].auth), JSON.stringify(pc.got));
  assert((await page.locator("#gplanRows tr", { hasText: "Peter Powell" }).locator("text=Stop plan").count()) === 0, "finished plans can't be stopped");
  await ctx.close();
});
await check("activity log: problems filter, integrity, download, and sign-ins are recorded", async () => {
  const { page, ctx } = await signedIn("treasurer");
  assert(/1 problem in the last 7 days/.test(await page.textContent("#issueBanner")), await page.textContent("#issueBanner"));
  await page.click("#issueBanner >> text=Review in the activity log"); await page.waitForSelector("#activityRows tr td");
  await page.waitForFunction(() => /Integrity verified/.test(document.getElementById("acIntegrity").textContent));
  const t = await page.textContent("#activityRows");
  assert(/Access refused/.test(t) && !/Signed in/.test(t), "problems only: " + t);
  await page.selectOption("#acLevel", ""); await page.waitForTimeout(200);
  assert(/Signed in/.test(await page.textContent("#activityRows")), "everything");
  const dl = page.waitForEvent("download"); await page.click('[data-export="activity"]'); const f = await dl;
  assert(f.suggestedFilename().startsWith("activity"), f.suggestedFilename());
  const rpc = await page.evaluate(() => window.__rpc.filter((r) => r.name === "log_activity").map((r) => r.args.act));
  assert(rpc.includes("client.sign_in") && rpc.includes("client.export"), JSON.stringify(rpc));
  await ctx.close();
});
await check("the handover can only be confirmed with every step ticked, and records the key change", async () => {
  const { page, ctx } = await signedIn("treasurer");
  await page.click('[data-ctab="system"]'); await page.waitForSelector("#hoStatus:has-text('No handover')");
  await page.click("#hoConfirm");
  assert(/Tick every step/.test(await page.textContent("#hoMsg")), "needs every step");
  for (const c of await page.$$(".ho")) await c.check();
  await page.click("#hoConfirm"); await page.click("text=Yes");
  await page.waitForFunction(() => /Handover confirmed/.test(document.getElementById("hoMsg").textContent));
  const w = (await page.evaluate(() => window.__writes)).find((x) => x.table === "settings");
  assert(w.row.handover_at && /^\d{4}-\d{2}-\d{2}$/.test(w.row.keys_rotated_on), JSON.stringify(w));
  await ctx.close();
});

console.log("Content pages and fund closing");
await check("updates page lists posts and opens one", async () => {
  const { page, ctx } = await open("/updates/");
  await page.waitForSelector("#postList .post");
  assert(/county replied/i.test(await page.textContent("#postList")), "post listed");
  await page.goto(page.url() + "?p=county-replies"); await page.waitForSelector("#postList .post .body p >> nth=1");
  assert(/county replied/i.test(await page.title()), "title updated");
  await ctx.close();
});
await check("when the fund is closed, the pledge form is switched off and says why", async () => {
  const closed = structuredClone(LEDGER); Object.assign(closed.org, { fundStatus: "closed", closedOn: "2027-03-01", closingNote: "Thank you, neighbors." });
  const { page, ctx } = await open("/", { ledger: closed });
  assert(await page.isDisabled("#pSubmit"), "submit should be disabled");
  assert(/closed on 2027-03-01/.test(await page.textContent("#closedNote")), "closed note");
  await ctx.close();
});
await check("pledge from an email already on file: link is emailed, not shown", async () => {
  const { page, ctx } = await open("/", { pledgeReply: { status: 201, json: { ok: true, pledgeId: "p1", amount: 100, shareUrl: null, emailed: true } } });
  await page.fill("#pName", "Maria Gomez"); await page.fill("#pEmail", "m@example.org"); await page.fill("#pAddr", "12 Oak St"); await page.fill("#pArea", "Magnolia Point");
  await page.check("#pConsent"); await page.click("#pSubmit");
  await page.waitForFunction(() => /emailed a confirmation/.test(document.getElementById("pMsg").textContent));
  assert((await page.locator("#pMsg a").count()) === 0, "no link on screen");
  await ctx.close();
});
await check("transparency shows refunds, net figures and the full-ledger download", async () => {
  const { page, ctx } = await open("/transparency/");
  assert(/Overpaid|Refund/.test(await page.textContent("#refundRows")), "refund row");
  const is = (await page.textContent("#incomeStmt")).replace(/\s+/g, "");
  assert(/Grosscontributions\$3,050\.00/.test(is) && /Lessrefundsandchargebacks-\$50\.00/.test(is) && /Netcontributions\$3,000\.00/.test(is), is);
  assert((await page.getAttribute("#csv", "href")) === "/api/ledger-csv", "csv link");
  await ctx.close();
});
await check("long lists say they are trimmed and point to the full download", async () => {
  const big = structuredClone(LEDGER); big.receiptsTotal = 5432;
  const { page, ctx } = await open("/transparency/", { ledger: big });
  assert(/latest 3 of 5,432/.test(await page.textContent("#incomeMore")), await page.textContent("#incomeMore"));
  await ctx.close();
});

console.log("Static files");
await check("robots, sitemap, manifest and security.txt are valid", async () => {
  const get = async (p) => (await fetch(BASE + p)).text();
  const robots = await get("/robots.txt"); assert(/Disallow: \/admin\//.test(robots) && /Sitemap:/.test(robots), "robots");
  const sm = await get("/sitemap.xml"); for (const u of ["/", "/transparency/", "/stats/", "/updates/", "/live-local-act/", "/park/", "/privacy/"]) assert(sm.includes(`example.org${u}<`), "sitemap " + u);
  JSON.parse(await get("/site.webmanifest"));
  assert(/Contact:/.test(await get("/.well-known/security.txt")), "security.txt");
});

await browser.close(); server.close();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log("Failed:\n - " + failures.join("\n - ")); process.exit(1); }
