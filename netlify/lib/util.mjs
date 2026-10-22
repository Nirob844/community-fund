// Shared helpers for Netlify Functions (Node 20+, ESM).
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import { createHash } from "node:crypto";

export const env = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing environment variable ${k}`);
  return v;
};

let _db;
/** Server-only Supabase client using the service-role key. Never expose this key to a browser. */
export function db() {
  if (!_db) {
    _db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _db;
}

const BASE_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, "cache-control": "no-store", ...headers } });

export const fail = (status, message) => json({ error: message }, status);

/** True only on a developer's own machine running `netlify dev` (never on the live site). */
export const isLocalDev = () => process.env.CONTEXT === "dev" && process.env.NETLIFY_DEV === "true" && process.env.NETLIFY !== "true";

/** Reject cross-site POSTs: the Origin header must match the site. */
export function sameOrigin(req) {
  const origin = req.headers.get("origin");
  const site = process.env.URL || "";            // Netlify sets URL to the primary site URL
  const allowed = [site, process.env.DEPLOY_PRIME_URL, process.env.DEPLOY_URL].filter(Boolean);
  return !!origin && (allowed.includes(origin) || isLocalDev());
}

export async function readJson(req, maxBytes = 4096) {
  const text = await req.text();
  if (text.length > maxBytes) throw Object.assign(new Error("Request too large"), { status: 413 });
  try { return JSON.parse(text || "{}"); } catch { throw Object.assign(new Error("Invalid JSON"), { status: 400 }); }
}

export const money = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
};

export const clean = (s, max) =>
  String(s ?? "").replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

export function publicLabel(full, mode) {
  if (mode === "anon") return "Anonymous neighbor";
  const parts = clean(full, 80).split(" ").filter(Boolean);
  if (!parts.length) return "Neighbor";
  const first = parts[0].charAt(0).toUpperCase() + parts[0].slice(1, 30);
  return parts.length > 1 ? `${first} ${parts[parts.length - 1][0].toUpperCase()}.` : first;
}

/** Cloudflare Turnstile server-side verification. Skipped only when no secret is configured (local dev). */
export async function verifyTurnstile(token, ip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return isLocalDev();
  if (!token) return false;
  const body = new URLSearchParams({ secret, response: token });
  if (ip) body.set("remoteip", ip);
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
  const data = await r.json().catch(() => ({}));
  return data.success === true;
}

export const DEFAULT_MILESTONES = [
  { amount: 10000, title: "Retain a land use attorney", desc: "The minimum needed to challenge the eligibility decision." },
  { amount: 1700000, title: "Match the land's A-1 value", desc: "Enough to make a serious offer for the property." },
  { amount: 2000000, title: "Buy the land and open a community park", desc: "Purchase, closing costs and first-year park setup." },
];

/** Stripe client using fetch (works on Netlify and in tests), with sane timeouts. */
export function stripeClient() {
  return new Stripe(env("STRIPE_SECRET_KEY"), { httpClient: Stripe.createFetchHttpClient(), maxNetworkRetries: 2, timeout: 15000 });
}

/** The visitor's IP address, stored only as a short one-way fingerprint in the activity log. */
export function ipHash(req, context) {
  const ip = context?.ip || req?.headers?.get("x-nf-client-connection-ip") || req?.headers?.get("x-forwarded-for")?.split(",")[0]?.trim() || "";
  if (!ip) return "";
  return createHash("sha256").update((process.env.LOG_SALT || process.env.SUPABASE_URL || "") + "|" + ip).digest("hex").slice(0, 16);
}

/** Append an entry to the activity log. Never throws and never blocks the request on failure. */
export async function logActivity({ action, level = "info", req, context, actor = null, actorLabel = "", role = "", detail = {} }) {
  try {
    const path = req ? new URL(req.url).pathname.slice(0, 120) : "";
    const safe = Object.fromEntries(Object.entries(detail || {}).filter(([, v]) => v !== undefined).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 200) : v]));
    await db().from("activity_log").insert({ action, level, actor, actor_label: String(actorLabel || "").slice(0, 120), role, path, ip_hash: ipHash(req, context), detail: safe });
  } catch (e) { console.error("activity log", e?.message); }
}

// developer < auditor < recorder < treasurer. A developer passes only checks that ask for "developer".
const RANK = { developer: 0, auditor: 1, recorder: 2, treasurer: 3 };
/** Verify the caller's Supabase session and staff role. Returns {user, role, name} or null.
 *  Every refusal of a presented token is written to the activity log. */
export async function requireStaff(req, minRole = "auditor", context) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const s = db();
  const deny = async (reason, user) => { await logActivity({ action: "access.denied", level: "security", req, context, actor: user?.id || null, actorLabel: user?.email || "", detail: { reason, need: minRole } }); return null; };
  const { data, error } = await s.auth.getUser(token);
  if (error || !data?.user) return deny("invalid or expired session");
  const { data: me } = await s.from("admins").select("role, active, display_name, access_expires_at").eq("user_id", data.user.id).maybeSingle();
  if (!me?.active) return deny("not an active team member", data.user);
  if (me.access_expires_at && new Date(me.access_expires_at) <= new Date()) return deny("access has expired", data.user);
  if ((RANK[me.role] ?? -1) < RANK[minRole] || (minRole !== "developer" && me.role === "developer")) return deny(`role ${me.role} is not enough`, data.user);
  return { user: data.user, role: me.role, name: me.display_name };
}

/** Fund settings with safe defaults (limits are also enforced by the database). */
export async function getSettings(s = db()) {
  const { data } = await s.from("settings").select("*").eq("id", 1).maybeSingle();
  const d = data || {};
  const n = (v, def) => (v === undefined || v === null || v === "" || !Number.isFinite(Number(v)) ? def : Number(v));
  return {
    ...d,
    org_name: d.org_name || "Community Fund", fund_status: d.fund_status || "open", accept_online: !!d.accept_online, fdacs_reg: d.fdacs_reg || "",
    min_gift: n(d.min_gift, 5), max_gift: n(d.max_gift, 10000), max_pledge: n(d.max_pledge, 2000000), max_deposit: n(d.max_deposit, 250000),
    allow_plans: d.allow_plans !== false, max_plan_payments: n(d.max_plan_payments, 24),
  };
}
export const onlineOpen = (st) => st.fund_status === "open" && st.accept_online && /^[A-Z]{1,3}[0-9]{2,8}$/.test(st.fdacs_reg || "");
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const FREQ = { weekly: { interval: "week", interval_count: 1, word: "weekly" }, monthly: { interval: "month", interval_count: 1, word: "monthly" }, quarterly: { interval: "month", interval_count: 3, word: "every 3 months" } };

export const fmtUSD = (n) => "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
