// /api/staff : treasurer-only team management (up to 5 active people, plus one temporary developer).
//   GET    list staff with emails
//   POST   {email, displayName, role, days?, purpose?}  add or re-activate a person
//          role "developer" needs days (1-30) and the issue to fix; access ends on its own
//   PATCH  {userId, role?, active?, extendDays?}       change role, deactivate, or extend a developer
// The caller proves who they are with their Supabase session token; the database enforces the
// 5-person limit, the "one treasurer" rule and the 30-day developer limit. Every change is logged.
import { db, json, fail, sameOrigin, readJson, clean, requireStaff, logActivity, UUID } from "../lib/util.mjs";

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,63}\.[^\s@]{2,24}$/;
const ROLES = ["treasurer", "recorder", "auditor", "developer"];
const BAN = "876000h";   // ~100 years: a removed developer can't even request a sign-in code

async function findUserByEmail(s, email) {
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await s.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = data.users.find((u) => (u.email || "").toLowerCase() === email);
    if (hit) return hit;
    if (data.users.length < 200) return null;
  }
  return null;
}

const friendly = (e) => {
  const m = String(e?.message || "");
  if (/at most 5/.test(m)) return [409, "The team is full: at most 5 active people. Deactivate someone first."];
  if (/active treasurer/.test(m)) return [409, "Keep at least one active treasurer."];
  if (/one developer/.test(m)) return [409, "Only one developer can have access at a time. Remove the current one first."];
  if (/within 30 days/.test(m)) return [400, "Developer access must end within 30 days."];
  return [500, "Could not update the team. Please try again."];
};
const inDays = (d) => new Date(Date.now() + d * 86400000).toISOString();

export default async (req, context) => {
  if (req.method !== "GET" && !sameOrigin(req)) return fail(403, "Forbidden");
  const me = await requireStaff(req, "treasurer", context);
  if (!me) return fail(403, "Only the treasurer can manage the team.");
  const s = db();
  const log = (action, detail, level = "security") => logActivity({ action, level, req, context, actor: me.user.id, actorLabel: me.user.email, role: me.role, detail });
  try {
    if (req.method === "GET") {
      const { data, error } = await s.from("admins").select("user_id, role, display_name, active, created_at, access_expires_at, purpose, invited_by").order("created_at");
      if (error) throw error;
      const withEmail = await Promise.all(data.map(async (a) => {
        const { data: u } = await s.auth.admin.getUserById(a.user_id);
        const expired = !!a.access_expires_at && new Date(a.access_expires_at) <= new Date();
        return { userId: a.user_id, role: a.role, displayName: a.display_name, active: a.active && !expired, expired, email: u?.user?.email || "",
          lastSignIn: u?.user?.last_sign_in_at || null, accessExpiresAt: a.access_expires_at || null, purpose: a.purpose || "" };
      }));
      return json({ staff: withEmail, seatsUsed: withEmail.filter((x) => x.active && x.role !== "developer").length, seats: 5 });
    }

    const b = await readJson(req, 1024);
    if (req.method === "POST") {
      const email = clean(b.email, 120).toLowerCase(), name = clean(b.displayName, 60), role = String(b.role || "");
      if (!EMAIL.test(email)) return fail(400, "Enter a valid email address.");
      if (!name) return fail(400, "Enter the person's name.");
      if (!ROLES.includes(role)) return fail(400, "Choose a role.");
      const row = { role, display_name: name, active: true, invited_by: me.user.id, purpose: "", access_expires_at: null };
      if (role === "developer") {
        const days = Number(b.days), purpose = clean(b.purpose, 200);
        if (!Number.isInteger(days) || days < 1 || days > 30) return fail(400, "Give the developer access for 1 to 30 days.");
        if (purpose.length < 5) return fail(400, "Describe the issue the developer is asked to fix.");
        Object.assign(row, { access_expires_at: inDays(days), purpose });
      }
      let user = await findUserByEmail(s, email);
      if (!user) {
        const { data, error } = await s.auth.admin.createUser({ email, email_confirm: true });
        if (error) throw error;
        user = data.user;
      } else if (user.id === me.user.id) {
        return fail(400, "You are already on the team.");
      }
      if (role === "developer" || user.banned_until) await s.auth.admin.updateUserById(user.id, { ban_duration: "none" });
      const { error } = await s.from("admins").upsert({ user_id: user.id, ...row }, { onConflict: "user_id" });
      if (error) throw error;
      await log(role === "developer" ? "developer.invite" : "team.invite", { user: user.id, role, expires: row.access_expires_at, purpose: row.purpose || undefined });
      return json({ ok: true, userId: user.id, accessExpiresAt: row.access_expires_at }, 201);
    }

    if (req.method === "PATCH") {
      if (!UUID.test(String(b.userId || ""))) return fail(400, "Unknown person.");
      const { data: cur } = await s.from("admins").select("role, active, access_expires_at").eq("user_id", b.userId).maybeSingle();
      if (!cur) return fail(404, "Unknown person.");
      const patch = {};
      if (b.role !== undefined) {
        if (!ROLES.includes(b.role)) return fail(400, "Choose a role.");
        if (b.role !== cur.role && (b.role === "developer" || cur.role === "developer")) return fail(400, "Developer access can't be converted. Remove it and invite the person again.");
        patch.role = b.role;
      }
      if (b.active !== undefined) patch.active = !!b.active;
      if (b.extendDays !== undefined) {
        const d = Number(b.extendDays);
        if (cur.role !== "developer") return fail(400, "Only developer access has an end date.");
        if (!Number.isInteger(d) || d < 1 || d > 30) return fail(400, "Extend by 1 to 30 days from today.");
        patch.access_expires_at = inDays(d); patch.active = true;
      }
      if (cur.role === "developer" && patch.active === true && b.extendDays === undefined && (!cur.access_expires_at || new Date(cur.access_expires_at) <= new Date())) {
        return fail(400, "This developer's access has ended. Give them a new end date (1 to 30 days).");
      }
      if (b.userId === me.user.id && (patch.active === false || (patch.role && patch.role !== "treasurer"))) return fail(400, "You can't remove your own treasurer access. Ask another treasurer.");
      const { error } = await s.from("admins").update(patch).eq("user_id", b.userId);
      if (error) throw error;
      if (cur.role === "developer") {
        // A removed developer is also blocked from signing in at all; a re-enabled one is unblocked.
        if (patch.active === false) await s.auth.admin.updateUserById(b.userId, { ban_duration: BAN });
        else if (patch.active === true) await s.auth.admin.updateUserById(b.userId, { ban_duration: "none" });
      }
      const action = cur.role === "developer" ? (patch.active === false ? "developer.remove" : patch.access_expires_at ? "developer.extend" : "developer.change")
        : patch.active === false ? "team.deactivate" : patch.active === true ? "team.reactivate" : "team.change";
      await log(action, { user: b.userId, role: patch.role || cur.role, expires: patch.access_expires_at });
      return json({ ok: true });
    }
    return fail(405, "Method not allowed");
  } catch (e) {
    if (e?.status) return fail(e.status, e.message);
    console.error("staff", e?.message);
    const [st, msg] = friendly(e);
    if (st === 500) await logActivity({ action: "server.error", level: "error", req, context, detail: { endpoint: "staff", error: String(e?.message || "").slice(0, 160) } });
    return fail(st, msg);
  }
};

export const config = { path: "/api/staff", rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ["ip", "domain"] } };
