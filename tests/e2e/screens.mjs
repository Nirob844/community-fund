// Saves screenshots of key pages for visual review: node tests/e2e/screens.mjs <outdir>
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";
import { chromium } from "playwright";
import { LEDGER, POSTS, fakeSupabaseModule } from "./fixtures.mjs";
const out = process.argv[2] || "screens"; mkdirSync(out, { recursive: true });
const ROOT = new URL("../../public/", import.meta.url).pathname;
const T = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
const srv = createServer((q, r) => { let f = join(ROOT, decodeURIComponent(new URL(q.url, "http://x").pathname)); if (existsSync(f) && statSync(f).isDirectory()) f = join(f, "index.html"); if (!existsSync(f)) { r.statusCode = 404; return r.end(); } r.setHeader("content-type", T[extname(f)] || "application/octet-stream"); r.end(readFileSync(f)); }).listen(0);
const B = `http://localhost:${srv.address().port}`;
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
for (const [path, name, width, scheme, role, tab] of [["/", "home", 1280, "light"], ["/", "home-mobile", 390, "light"], ["/stats/", "stats", 1280, "light"], ["/live-local-act/", "lla", 1280, "light"], ["/park/", "park", 390, "light"], ["/updates/", "updates", 1280, "dark"], ["/transparency/", "transparency", 1280, "light"],
  ["/admin/", "admin-record", 1280, "light", "treasurer", "record"], ["/admin/", "admin-money", 1280, "light", "treasurer", "money"], ["/admin/", "admin-closing", 1280, "light", "treasurer", "closing"], ["/admin/", "admin-people", 390, "light", "treasurer", "people"]]) {
  const p = await (await b.newContext({ viewport: { width, height: 900 }, colorScheme: scheme })).newPage();
  await p.addInitScript((r) => { window.__role = r; }, role || "");
  await p.route(/fonts\.|challenges\./, (r) => r.abort());
  await p.route(/cdn\.jsdelivr\.net/, (r) => r.fulfill({ contentType: "text/javascript", body: fakeSupabaseModule }));
  await p.route("**/api/ledger", (r) => r.fulfill({ json: LEDGER }));
  await p.route("**/api/config", (r) => r.fulfill({ json: { supabaseUrl: "https://m", supabaseAnonKey: "a" } }));
  await p.route("**/api/staff", (r) => r.fulfill({ json: { staff: [{ userId: "u-t", role: "treasurer", displayName: "Tess", active: true, email: "t@example.org" }, { userId: "u-r", role: "recorder", displayName: "Rory", active: true, email: "r@example.org" }], seatsUsed: 2, seats: 5 } }));
  await p.route("**/api/updates*", (r) => r.fulfill({ json: POSTS }));
  await p.goto(B + path); await p.waitForTimeout(900);
  if (tab) { await p.click(`[data-ctab="${tab}"]`); await p.waitForTimeout(500); if (tab === "closing") { await p.click("#clStart"); await p.click("text=Yes"); await p.waitForTimeout(500); } }
  await p.screenshot({ path: `${out}/${name}.png`, fullPage: true });
}
await b.close(); srv.close();
