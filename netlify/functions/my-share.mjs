// GET /api/my-share?t=<private token> : a contributor's own totals, refund share and giving plans.
import { db, json, fail, logActivity } from "../lib/util.mjs";

export default async (req, context) => {
  if (req.method !== "GET") return fail(405, "Method not allowed");
  const t = new URL(req.url).searchParams.get("t") || "";
  if (!/^[0-9a-f]{36}$/.test(t)) return fail(404, "Link not recognized.");
  const { data, error } = await db().rpc("my_share_v2", { token: t });
  if (error) { console.error("my-share", error.message); await logActivity({ action: "server.error", level: "error", req, context, detail: { endpoint: "my-share", error: error.message } }); return fail(500, "Please try again later."); }
  if (!data) { await logActivity({ action: "donor.bad_link", level: "warn", req, context, detail: { endpoint: "my-share" } }); return fail(404, "Link not recognized."); }
  return json(data, 200, { "x-robots-tag": "noindex", "referrer-policy": "no-referrer" });
};

export const config = { path: "/api/my-share", rateLimit: { windowLimit: 20, windowSize: 60, aggregateBy: ["ip", "domain"] } };
