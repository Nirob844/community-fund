// Usage: npm run set-domain -- https://yourfund.org
// Replaces the placeholder https://example.org in pages, sitemap, robots, llms.txt and netlify.toml.
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
const domain = (process.argv[2] || "").replace(/\/$/, "");
if (!/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) { console.error("Give a domain like https://yourfund.org"); process.exit(1); }
const host = new URL(domain).host;
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const files = [...walk("public").filter((f) => /\.(html|xml|txt|webmanifest)$/.test(f)), "netlify.toml"];
for (const f of files) {
  const s = readFileSync(f, "utf8");
  const t = s.replaceAll("https://www.example.org", `https://www.${host}`).replaceAll("http://example.org", `http://${host}`)
    .replaceAll("https://example.org", domain).replaceAll("security@example.org", `security@${host}`);
  if (t !== s) { writeFileSync(f, t); console.log("updated", f); }
}
