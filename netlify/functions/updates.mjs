// GET /api/updates          : published news posts (newest first, max 50)
// GET /api/updates?slug=... : one published post
import { db, json, fail } from "../lib/util.mjs";

function enrichPost(p) {
  if (!p) return null;
  let body = p.body || "";
  let cover_image_url = "";
  let author = "SMARTManatee Team";
  let topic = "Community Update";
  let caption = "";
  const fm = body.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (fm) {
    for (const line of fm[1].split(/\r?\n/)) {
      const idx = line.indexOf(":");
      if (idx > -1) {
        const k = line.slice(0, idx).trim().toLowerCase();
        const v = line.slice(idx + 1).trim();
        if (k === "cover" || k === "cover_image_url") cover_image_url = v;
        if (k === "author") author = v;
        if (k === "topic" || k === "tag") topic = v;
        if (k === "caption") caption = v;
      }
    }
    body = fm[2].trim();
  }
  const words = body.trim().split(/\s+/).filter(Boolean).length;
  const reading_time = Math.max(1, Math.ceil(words / 200)) + " min read";
  return {
    ...p,
    body,
    cover_image_url: cover_image_url || "/assets/img/og-image.png",
    author,
    topic,
    caption,
    reading_time,
  };
}

export default async (req) => {
  if (req.method !== "GET") return fail(405, "Method not allowed");
  const slug = new URL(req.url).searchParams.get("slug");
  const s = db();
  const cache = { "cache-control": "public, max-age=60", "netlify-cdn-cache-control": "public, s-maxage=60, stale-while-revalidate=600" };
  if (slug) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) return fail(404, "Not found.");
    const { data } = await s.from("posts").select("slug, title, summary, body, published_on").eq("slug", slug).eq("published", true).maybeSingle();
    return data ? json(enrichPost(data), 200, cache) : fail(404, "Not found.");
  }
  const { data, error } = await s.from("posts").select("slug, title, summary, body, published_on").eq("published", true).order("published_on", { ascending: false }).limit(50);
  if (error) return fail(500, "Updates are temporarily unavailable.");
  return json({ posts: (data || []).map(enrichPost) }, 200, cache);
};

export const config = { path: "/api/updates", rateLimit: { windowLimit: 120, windowSize: 60, aggregateBy: ["ip", "domain"] } };
