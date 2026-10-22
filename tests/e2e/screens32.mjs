// Screenshots of the v3.2 screens for the blueprint: node tests/e2e/screens32.mjs <outdir>
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";
import { chromium } from "playwright";
import { LEDGER, fakeSupabaseModule } from "./fixtures.mjs";
const out = process.argv[2] || "screens32"; mkdirSync(out, { recursive: true });
const ROOT = new URL("../../public/", import.meta.url).pathname;
const T = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
const srv = createServer((q, r) => { let f = join(ROOT, decodeURIComponent(new URL(q.url, "http://x").pathname)); if (existsSync(f) && statSync(f).isDirectory()) f = join(f, "index.html"); if (!existsSync(f)) { r.statusCode = 404; return r.end(); } r.setHeader("content-type", T[extname(f)] || "application/octet-stream"); r.end(readFileSync(f)); }).listen(0);
const B = `http://localhost:${srv.address().port}`;
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const L = structuredClone(LEDGER); L.org.acceptOnline = true; L.org.fdacsReg = "CH12345"; L.limits.allowPlans = true; L.plans = { active: 4, monthly: 180, stillToCome: 1450 };
L.goal = { promptsEnabled: true, headline: "Help us hire the land use attorney", deadline: "2026-12-15" };
const SHARE = { label: "Jo K.", area: "Tuttle Avenue", pledged: 250, received: 100, owed: 150, fundReceived: 3000, fundExpenses: 61.25, availableToReturn: 2938.75, share: 0.0333, refund: 97.96,
  acceptOnline: true, fundStatus: "open", limits: { minGift: 5, maxGift: 1000, allowPlans: true, maxPlanPayments: 12, suggestedAmounts: [10, 25, 50, 100] },
  plans: [{ id: "g1", installment: 25, frequency: "monthly", payments: 6, paidCount: 2, paidTotal: 50, status: "active", method: "card", nextDue: "2026-12-01" }] };
const HEALTH = { version: "a1b2c3d", context: "production", stripeMode: "live", env: { SUPABASE_URL: true, STRIPE_SECRET_KEY: true, LOG_SALT: true },
  security: { ok: true, checks: ["Row Level Security on every table", "The public (anon) key can read or change no table", "The public (anon) key can run no database function", "Every privileged function has a fixed search path", "At least one active treasurer", "No more than 5 active team members", "Audit log intact", "Activity log intact", "Card payments only with a state registration"].map((name) => ({ name, ok: true, detail: "" })).concat([{ name: "Developer access", ok: true, detail: "1 developer with access until 2026-10-24 17:00" }]) }, activity: { issuesLast7Days: 1 } };
const TEAM = { staff: [{ userId: "u-t", role: "treasurer", displayName: "Tess", active: true, email: "t@example.org", lastSignIn: "2026-10-17T12:00:00Z" },
  { userId: "u-r", role: "recorder", displayName: "Rory", active: true, email: "r@example.org", lastSignIn: "2026-10-16T12:00:00Z" },
  { userId: "u-d", role: "developer", displayName: "Dana (developer)", active: true, email: "dana@devshop.example", lastSignIn: null, accessExpiresAt: "2026-10-24T17:00:00Z", purpose: "Receipt emails are not arriving" }], seatsUsed: 2, seats: 5 };
async function shot(path, name, { width = 1280, role = "", sel, act } = {}) {
  const p = await (await b.newContext({ viewport: { width, height: 900 } })).newPage();
  await p.addInitScript((r) => { window.__role = r; }, role);
  await p.route(/fonts\.|challenges\./, (r) => r.abort());
  await p.route(/cdn\.jsdelivr\.net/, (r) => r.fulfill({ contentType: "text/javascript", body: fakeSupabaseModule }));
  await p.route("**/api/ledger", (r) => r.fulfill({ json: L }));
  await p.route("**/api/config", (r) => r.fulfill({ json: { supabaseUrl: "https://m", supabaseAnonKey: "a" } }));
  await p.route("**/api/my-share*", (r) => r.fulfill({ json: SHARE }));
  await p.route("**/api/health", (r) => r.fulfill({ json: HEALTH }));
  await p.route("**/api/staff", (r) => r.fulfill({ json: TEAM }));
  await p.goto(B + path); await p.waitForTimeout(900);
  if (act) await act(p);
  await p.waitForTimeout(400);
  if (sel) await p.locator(sel).first().screenshot({ path: `${out}/${name}.png` }); else await p.screenshot({ path: `${out}/${name}.png`, fullPage: true });
}
await shot("/", "v32-prompts", { sel: "section[aria-labelledby=msTitle]" });
await shot("/", "v32-plan", { sel: "#pledge", act: async (p) => { await p.click("#gPlan"); await p.fill("#pAmt", "25"); await p.fill("#pCount", "6"); await p.dispatchEvent("#pCount", "input"); } });
await shot("/share/?t=" + "a".repeat(36), "v32-share", { width: 900, sel: "main .card" });
await shot("/admin/", "v32-settings", { role: "treasurer", sel: "#sForm", act: async (p) => { await p.click('[data-ctab="settings"]'); } });
await shot("/admin/", "v32-team", { role: "treasurer", sel: "[data-cpanel=team] .card", act: async (p) => { await p.click('[data-ctab="team"]'); await p.selectOption("#tRole", "developer"); } });
await shot("/admin/", "v32-system", { role: "treasurer", sel: "[data-cpanel=system]", act: async (p) => { await p.click('[data-ctab="system"]'); await p.click("#hRun"); } });
await shot("/admin/", "v32-plans", { role: "treasurer", sel: "#gplanRows", act: async (p) => { await p.click('[data-ctab="pledges"]'); } });
await shot("/admin/", "v32-developer", { role: "developer", width: 1100 });
await b.close(); srv.close();
