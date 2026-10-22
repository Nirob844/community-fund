// GET /api/config : public, non-secret settings the browser needs.
// The Supabase anon key is safe to publish: Row Level Security blocks it from every table.
import { json } from "../lib/util.mjs";

export default async () => json({
  supabaseUrl: process.env.SUPABASE_URL || "",
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || "",
  turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || "",
}, 200, { "cache-control": "public, max-age=300" });

export const config = { path: "/api/config" };
