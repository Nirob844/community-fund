// Shared setup: an in-memory Postgres (PGlite) with a stand-in for Supabase's auth schema,
// then the real supabase/schema.sql applied twice (it must be safe to re-run).
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

export const ids = { t: "11111111-1111-4111-8111-111111111111", r: "22222222-2222-4222-8222-222222222222", a: "33333333-3333-4333-8333-333333333333", x: "44444444-4444-4444-8444-444444444444" };

export async function makeDb() {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated, service_role; grant execute on function auth.uid() to anon, authenticated, service_role;
    grant usage on schema public to anon, authenticated, service_role;
  `);
  const sql = readFileSync(new URL("../../supabase/schema.sql", import.meta.url), "utf8");
  await db.exec(sql);
  await db.exec(sql);
  for (const [k, id] of Object.entries(ids)) await db.query("insert into auth.users values ($1, $2)", [id, `${k}@example.org`]);
  await db.query("insert into public.admins(user_id, role, display_name) values ($1,'treasurer','Tess'), ($2,'recorder','Rory'), ($3,'auditor','Ada')", [ids.t, ids.r, ids.a]);
  /** Run SQL as a Supabase role with a signed-in user id (or none). */
  db.as = async (role, uid, q, params) => {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid || ""}', false); select set_config('request.jwt.claim.role', '${role}', false); set role ${role};`);
    try { return await db.query(q, params); } finally { await db.exec("reset role; select set_config('request.jwt.claim.role', '', false); select set_config('request.jwt.claim.sub', '', false);"); }
  };
  return db;
}
