// Tests the live Claude page (live-page/community_fund_ledger.html) with a simulated
// shared database and simulated viewers: treasurer, helper with edit access, and a neighbor.
// Run: node tests/live-page/run.mjs
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const PAGE = readFileSync(new URL("../../live-page/community_fund_ledger.html", import.meta.url), "utf8");
const MOCK = `
(() => {
  const store = window.__store = window.__store || {};
  const subs = [];
  const notify = () => setTimeout(() => subs.forEach((f) => f()), 0);
  const isDoc = (p) => p.split("/").length % 2 === 0;
  const children = (col) => Object.keys(store).filter((k) => k.startsWith(col + "/") && k.split("/").length === col.split("/").length + 1);
  let n = 0;
  const docRef = (path) => ({
    id: path.split("/").pop(),
    set: async (d) => { store[path] = JSON.parse(JSON.stringify(d)); notify(); },
    update: async (d) => { if (!store[path]) throw Object.assign(new Error("missing"), {code: "not_found"}); Object.assign(store[path], JSON.parse(JSON.stringify(d))); notify(); },
    delete: async () => { delete store[path]; notify(); },
    onSnapshot: (ok) => { const f = () => ok({exists: !!store[path], data: () => store[path]}); subs.push(f); f(); return () => {}; },
  });
  const db = {
    doc: (p) => docRef(p),
    collection: (col) => ({
      doc: (id) => docRef(col + "/" + (id || "auto" + (++n) + Math.random().toString(36).slice(2, 6))),
      add: async (d) => { const id = "auto" + (++n); store[col + "/" + id] = JSON.parse(JSON.stringify(d)); notify(); return docRef(col + "/" + id); },
      onSnapshot: (ok) => { const f = () => ok({docs: children(col).map((k) => ({id: k.split("/").pop(), data: () => store[k]}))}); subs.push(f); f(); return () => {}; },
    }),
  };
  const who = window.__viewer || {id: "u_treasurer", edit: true};
  const names = {u_treasurer: "Tess Treasurer", u_helper: "Hal Helper", u_neighbor: "Nina Neighbor"};
  const user = { id: async () => who.id, canEdit: async () => who.edit, isOwner: async () => who.id === "u_treasurer",
    profiles: async (ids) => Object.fromEntries([].concat(ids).map((i) => [i, {id: i, name: names[i] || "", isMe: i === who.id}])) };
  window.claude = { use: async (name) => name === "db" ? db : name === "user" ? user : null };
})();`;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let passed = 0, failed = 0; const fails = [];
const check = async (name, fn) => { try { await fn(); passed++; console.log("  ok  ", name); } catch (e) { failed++; fails.push(name); console.log("  FAIL", name, "\n       ", e.message.split("\n")[0]); } };
const assert = (c, m) => { if (!c) throw new Error(m); };

async function open(viewer, { width = 1280, store = {} } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.route(/fonts\./, (r) => r.abort());
  await page.addInitScript(([v, st]) => { window.__viewer = v; window.__store = st; }, [viewer, store]);
  await page.addInitScript(MOCK);
  const html = "<!doctype html><html><head><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'></head><body>" + PAGE + "</body></html>";
  await page.route("https://live-page.test/", (r) => r.fulfill({ contentType: "text/html", body: html }));
  await page.goto("https://live-page.test/");
  await page.waitForTimeout(400);
  return { page, ctx, errors };
}
const T = { id: "u_treasurer", edit: true }, H = { id: "u_helper", edit: true }, N = { id: "u_neighbor", edit: false };
const txt = (page, sel) => page.textContent(sel);

console.log("Live page: access");
await check("a neighbor without edit access never sees the Treasurer tab", async () => {
  const { page, ctx, errors } = await open(N);
  assert(await page.isHidden("#tab-admin"), "treasurer tab visible");
  assert(errors.length === 0, errors.join("|"));
  await ctx.close();
});
await check("a helper with edit access sees the Treasurer tab", async () => {
  const { page, ctx } = await open(H);
  assert(await page.isVisible("#tab-admin"), "tab hidden");
  await ctx.close();
});

console.log("Live page: manual entries flow to every report");
let store;
await check("helper records a manual pledge for a new person", async () => {
  const { page, ctx, errors } = await open(H);
  await page.click("#tab-admin");
  await page.selectOption("#plWho", "__new");
  await page.fill("#plName", "maria gomez"); await page.fill("#plArea", "Magnolia Point"); await page.fill("#plAddr", "12 Oak St"); await page.fill("#plAmt", "100");
  await page.click("#plForm button[type=submit]");
  await page.waitForFunction(() => /saved/.test(document.getElementById("plMsg").textContent)); await page.waitForTimeout(150); // let live updates arrive
  assert((await txt(page, "#tOut")) === "$100.00", "pledged tile " + (await txt(page, "#tOut")));
  assert(/Maria G\./.test(await txt(page, "#pledgeRows")), "ledger pledge row");
  assert(/Magnolia Point/.test(await txt(page, "#nbChart")), "neighborhood chart");
  assert(/12 Oak St/.test(await txt(page, "#contactRows")), "private contact for staff");
  assert(/Hal Helper/.test(await txt(page, "#teamRows")), "team activity names the helper: " + (await txt(page, "#teamRows")));
  assert(errors.length === 0, errors.join("|"));
  store = await page.evaluate(() => window.__store);
  assert(!JSON.stringify(Object.entries(store).filter(([k]) => k.startsWith("pledges/"))).includes("12 Oak St"), "address leaked into public pledge doc");
  await ctx.close();
});
await check("treasurer records the deposit; the owed amount is suggested and status updates everywhere", async () => {
  const { page, ctx } = await open(T, { store });
  await page.click("#tab-admin");
  const id = await page.$eval("#rWho", (s) => [...s.options].find((o) => /Maria/.test(o.textContent)).value);
  await page.selectOption("#rWho", id);
  assert(/Still owed: \$100\.00/.test(await txt(page, "#rOwed")), "owed hint");
  assert((await page.inputValue("#rAmt")) === "100.00", "suggested amount");
  await page.selectOption("#rMethod", "Check"); await page.fill("#rDep", "DEP-1");
  await page.click("#rForm button[type=submit]");
  await page.waitForFunction(() => /saved/.test(document.getElementById("rMsg").textContent)); await page.waitForTimeout(150); // let live updates arrive
  assert((await txt(page, "#tRec")) === "$100.00", "received tile " + (await txt(page, "#tRec")));
  assert((await txt(page, "#tOut")) === "$0.00", "outstanding cleared");
  assert(/Contributions:Check\$100\.00/.test((await txt(page, "#incomeStmt")).replace(/\s+/g, "")), "income statement " + (await txt(page, "#incomeStmt")));
  assert(/slip DEP-1/.test(await txt(page, "#manageRows")), "deposit slip in entries");
  assert(/Tess Treasurer/.test(await txt(page, "#manageRows")), "entered-by name");
  store = await page.evaluate(() => window.__store);
  await ctx.close();
});
await check("refund rule: second $100 contributor and a $100 expense → $50 each", async () => {
  const { page, ctx } = await open(T, { store });
  await page.click("#tab-admin");
  await page.selectOption("#rWho", "__new"); await page.fill("#rFull", "Bob Brown"); await page.fill("#rLabel", "Bob B."); await page.fill("#rArea", "Tuttle Avenue");
  await page.fill("#rAmt", "100"); await page.selectOption("#rMethod", "Cash");
  await page.click("#rForm button[type=submit]");
  await page.waitForFunction(() => /saved/.test(document.getElementById("rMsg").textContent)); await page.waitForTimeout(150); // let live updates arrive
  await page.fill("#eAmt", "100"); await page.fill("#ePayee", "Law firm");
  await page.click("#eForm button[type=submit]");
  await page.waitForFunction(() => /Recorded/.test(document.getElementById("eMsg").textContent)); await page.waitForTimeout(150); // let live updates arrive
  await page.click("#tab-shares");
  const rows = await page.$$eval("#shareRows tr", (trs) => trs.map((t) => t.lastElementChild.textContent));
  assert(rows.length === 2 && rows.every((r) => r === "$50.00"), "refunds " + rows.join(","));
  assert((await txt(page, "#sPool")) === "$100.00", "pool");
  store = await page.evaluate(() => window.__store);
  await ctx.close();
});
await check("statistics tab reflects the entries", async () => {
  const { page, ctx, errors } = await open(N, { store });
  await page.click("#tab-stats");
  assert((await txt(page, "#kPeople")) === "2", "people " + (await txt(page, "#kPeople")));
  assert((await txt(page, "#kAreas")) === "2", "areas");
  assert((await txt(page, "#kMedian")) === "$100.00", "median");
  assert(await page.locator("#timeChart svg").count() === 1, "time chart");
  assert(await page.locator("#sizeChart svg").count() === 1, "size chart");
  assert((await page.locator("#methodChart .hb").count()) === 2, "methods");
  assert(/100% of spending has gone directly to the legal case/.test(await txt(page, "#spendNote")), "spend note");
  assert(errors.length === 0, errors.join("|"));
  await ctx.close();
});
await check("neighbors see labels and areas only, never contact details", async () => {
  const { page, ctx } = await open(N, { store });
  const body = await page.evaluate(() => document.body.innerText);
  assert(!/12 Oak St|maria gomez|Bob Brown/i.test(body), "private details visible to neighbor");
  await ctx.close();
});
await check("future-dated deposits and out-of-range pledges are refused", async () => {
  const { page, ctx } = await open(T, { store });
  await page.click("#tab-admin");
  await page.selectOption("#rWho", "__new"); await page.fill("#rAmt", "5"); await page.fill("#rDate", "2099-01-01");
  await page.click("#rForm button[type=submit]");
  assert(/future/.test(await txt(page, "#rMsg")), "future date");
  await page.fill("#plAmt", "2000001"); await page.click("#plForm button[type=submit]");
  assert(/between/.test(await txt(page, "#plMsg")), "range");
  await ctx.close();
});
await check("phone width has no sideways scrolling on any tab", async () => {
  const { page, ctx } = await open(T, { store, width: 390 });
  for (const t of ["pledge", "ledger", "statements", "stats", "shares", "admin"]) {
    await page.click(`#tab-${t}`);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert(over <= 0, `${t} overflows by ${over}px`);
  }
  await ctx.close();
});

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log("Failed:\n - " + fails.join("\n - ")); process.exit(1); }
