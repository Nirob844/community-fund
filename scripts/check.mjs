// Pre-deploy checks: no secrets in public files, every page has the SEO basics.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
let bad = 0;
for (const f of walk("public")) {
  if (!/\.(html|js|css|txt|json|xml|webmanifest)$/.test(f)) continue;
  const s = readFileSync(f, "utf8");
  if (/sk_(live|test)_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9]{10,}|service_role/.test(s)) { console.error("SECRET FOUND in", f); bad++; }
  if (f.endsWith(".html")) {
    for (const need of ["<title>", 'name="description"', 'rel="canonical"', 'lang="en-US"', 'name="viewport"']) {
      if (!s.includes(need)) { console.error(`${f} is missing ${need}`); bad++; }
    }
    if (/\sstyle="/.test(s.replace(/<svg[\s\S]*?<\/svg>/g, ""))) { console.error(`${f} has an inline style attribute (blocked by CSP)`); bad++; }
    if (/<script(?![^>]*\b(src|type="application\/ld\+json"))[^>]*>/.test(s)) { console.error(`${f} has an inline script (blocked by CSP)`); bad++; }
  }
}

// ---------- Backdoor sweep ----------
// Every server endpoint must be either staff-only (requireStaff) or one of the known public
// endpoints with its own guard. No debug switches, shortcuts, eval or hard-coded identities.
const PUBLIC = {
  "ledger.mjs": null, "ledger-csv.mjs": null, "config.mjs": null, "updates.mjs": null,
  "pledge.mjs": /verifyTurnstile\(/, "checkout.mjs": /UUID\.test\(/, "stripe-webhook.mjs": /constructEventAsync\(/,
  "give.mjs": /share_token/, "my-share.mjs": /\[0-9a-f\]\{36\}/, "plan.mjs": /share_token/,
};
const NO_RATE_LIMIT = new Set(["stripe-webhook.mjs", "config.mjs"]);   // Stripe retries; config is static
for (const f of readdirSync("netlify/functions")) {
  if (!f.endsWith(".mjs")) continue;
  const s = readFileSync(join("netlify/functions", f), "utf8");
  if (!/export const config = \{ path: "\/api\//.test(s)) { console.error(`${f}: missing an /api/ path`); bad++; }
  if (!NO_RATE_LIMIT.has(f) && !/rateLimit:/.test(s)) { console.error(`${f}: no rate limit`); bad++; }
  if (f in PUBLIC) { if (PUBLIC[f] && !PUBLIC[f].test(s)) { console.error(`${f}: public endpoint lost its guard`); bad++; } }
  else if (!/requireStaff\(req, /.test(s)) { console.error(`${f}: endpoint is not protected by requireStaff`); bad++; }
  if (/req\.method !== "GET"|req\.method !== "POST"/.test(s) && /"POST"|PATCH/.test(s) && f !== "stripe-webhook.mjs" && !/sameOrigin\(req\)/.test(s)) { console.error(`${f}: accepts writes without the same-origin check`); bad++; }
}
const scan = [...walk("netlify"), ...walk("public"), "netlify.toml"].filter((f) => /\.(mjs|js|html|toml)$/.test(f));
const FORBIDDEN = [
  [/\beval\s*\(|new Function\s*\(/, "eval / new Function"],
  [/BYPASS|SKIP_AUTH|BACKDOOR|MASTER_KEY|GOD_MODE|DEBUG_AUTH|x-debug|x-admin-override/i, "debug or bypass switch"],
  [/process\.env\.CONTEXT === "dev"(?![^\n]*NETLIFY_DEV)/, "CONTEXT=dev shortcut outside isLocalDev()"],
  [/eyJhbGciOi[A-Za-z0-9_-]{20,}/, "hard-coded JWT"],
  [/(email|user\.email)\s*===?\s*["'][^"']+@/, "hard-coded email identity check"],
  [/role\s*=\s*["']treasurer["']\s*;|__role\s*=/, "client-side role override"],
];
for (const f of scan) {
  const s = readFileSync(f, "utf8");
  for (const [re, what] of FORBIDDEN) if (re.test(s)) { console.error(`${f}: ${what}`); bad++; }
}
for (const [i, line] of readFileSync("supabase/schema.sql", "utf8").split("\n").entries()) {
  if (/insert into public\.admins/i.test(line) && !/^\s*--/.test(line)) { console.error(`schema.sql:${i + 1}: adds a team member (bootstrap must stay a comment)`); bad++; }
  if (/grant\s+[^;]*\bto\s+(anon|public)\b/i.test(line) && !/^\s*--/.test(line)) { console.error(`schema.sql:${i + 1}: grants something to anon/public`); bad++; }
}

if (bad) process.exit(1);
console.log("checks passed (pages, secrets, backdoor sweep)");
