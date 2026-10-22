// GET /api/health : a system check for the treasurer or an invited developer.
// Shows which services are configured (yes/no only, never a key), the deployed version,
// and the database's security self-check. Viewing it is logged.
import { db, json, fail, requireStaff, logActivity } from "../lib/util.mjs";

const NEED = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET",
  "TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY", "RESEND_API_KEY", "EMAIL_FROM", "TREASURER_EMAIL", "LOG_SALT"];

export default async (req, context) => {
  if (req.method !== "GET") return fail(405, "Method not allowed");
  const me = await requireStaff(req, "developer", context);
  if (!me || !["treasurer", "developer"].includes(me.role)) return fail(403, "Only the treasurer or an invited developer can see system health.");
  const key = process.env.STRIPE_SECRET_KEY || "";
  const env = Object.fromEntries(NEED.map((k) => [k, !!process.env[k]]));
  let security = null, activity = null;
  try {
    const s = db();
    const [{ data: a }, { count }] = await Promise.all([
      s.rpc("security_audit"),
      s.from("activity_log").select("id", { count: "exact", head: true }).in("level", ["error", "security"]).gte("at", new Date(Date.now() - 7 * 86400000).toISOString()),
    ]);
    security = a; activity = { issuesLast7Days: count ?? null };
  } catch (e) { security = { ok: false, error: "The database check could not run." }; }
  await logActivity({ action: "health.view", req, context, actor: me.user.id, actorLabel: me.user.email, role: me.role });
  return json({
    at: new Date().toISOString(), version: process.env.COMMIT_REF?.slice(0, 7) || "local", context: process.env.CONTEXT || "unknown",
    node: process.version, stripeMode: key.startsWith("sk_live_") ? "live" : key.startsWith("sk_test_") ? "test" : "not set",
    env, security, activity,
  });
};

export const config = { path: "/api/health", rateLimit: { windowLimit: 20, windowSize: 60, aggregateBy: ["ip", "domain"] } };
