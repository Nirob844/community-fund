// GET /api/updates          : published news posts (newest first, max 50)
// GET /api/updates?slug=... : one published post
import { db, json, fail } from "../lib/util.mjs";

export default async (req) => {
  if (req.method !== "GET") return fail(405, "Method not allowed");
  const slug = new URL(req.url).searchParams.get("slug");
  const s = db();
  const cache = { "cache-control": "public, max-age=60", "netlify-cdn-cache-control": "public, s-maxage=60, stale-while-revalidate=600" };
  if (slug) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) return fail(404, "Not found.");
    const { data } = await s.from("posts").select("slug, title, summary, body, published_on").eq("slug", slug).eq("published", true).maybeSingle();
    return data ? json(data, 200, cache) : fail(404, "Not found.");
  }
  const { data, error } = await s.from("posts").select("slug, title, summary, body, published_on").eq("published", true).order("published_on", { ascending: false }).limit(50);
  if (error) return fail(500, "Updates are temporarily unavailable.");
  return json({ posts: data }, 200, cache);
};

export const config = { path: "/api/updates", rateLimit: { windowLimit: 120, windowSize: 60, aggregateBy: ["ip", "domain"] } };
