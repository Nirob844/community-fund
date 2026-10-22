import { $, h, fill, renderFooterLegal } from "./common.js";

const fmtDate = (d) => new Date(d + "T12:00:00").toLocaleDateString("en-US", { dateStyle: "long" });
const paras = (text) => String(text || "").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => h("p", {}, p));

async function load() {
  const list = $("postList");
  const slug = new URLSearchParams(location.search).get("p");
  try {
    if (slug) {
      const r = await fetch("/api/updates?slug=" + encodeURIComponent(slug));
      if (!r.ok) throw new Error("missing");
      const p = await r.json();
      document.title = `${p.title} | Prospect Road Community Fund`;
      fill(list, h("article", { class: "post" }, h("time", { datetime: p.published_on }, fmtDate(p.published_on)), h("h2", {}, p.title), h("div", { class: "body" }, paras(p.body))),
        h("p", {}, h("a", { href: "/updates/" }, "← All updates")));
      return;
    }
    const { posts } = await (await fetch("/api/updates")).json();
    fill(list, posts.length ? posts.map((p) => h("article", { class: "post" },
      h("time", { datetime: p.published_on }, fmtDate(p.published_on)),
      h("h2", {}, h("a", { href: "/updates/?p=" + encodeURIComponent(p.slug) }, p.title)),
      h("p", {}, p.summary || String(p.body || "").slice(0, 240)))) : h("p", { class: "empty" }, "No updates yet. Check back soon."));
  } catch {
    fill(list, h("p", { class: "note warn" }, slug ? "That update could not be found." : "Updates are temporarily unavailable."));
  }
}
load();
fetch("/api/ledger").then((r) => r.json()).then((d) => renderFooterLegal(d.org)).catch(() => {});
