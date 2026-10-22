// A database created with the version-2 schema (already holding money) upgrades cleanly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

test("upgrade from v2 keeps every row, tidies neighborhoods and hashes the existing audit log", async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated, service_role; grant execute on function auth.uid() to anon, authenticated, service_role;
    grant usage on schema public to anon, authenticated, service_role;`);
  await db.exec(readFileSync(new URL("./fixtures/schema_v2.sql", import.meta.url), "utf8"));
  await db.exec(`insert into auth.users values ('11111111-1111-4111-8111-111111111111','t@example.org');
    insert into public.admins(user_id, role, display_name) values ('11111111-1111-4111-8111-111111111111','treasurer','Tess');
    insert into public.contributors(id, full_name, public_label, area) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Ann A','Ann A.','magnolia pt');
    insert into public.pledges(contributor_id, amount) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 100);
    insert into public.receipts(contributor_id, public_label, area, amount, method) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Ann A.','magnolia pt',60,'Check');
    insert into public.expenses(amount, payee) values (10,'Printer');`);
  const before = (await db.query("select count(*)::int n from public.audit_log")).rows[0].n;
  await db.exec(readFileSync(new URL("../../supabase/schema.sql", import.meta.url), "utf8"));
  const r = (await db.query("select area, amount from public.receipts")).rows[0];
  assert.equal(r.area, "Magnolia Point"); assert.equal(Number(r.amount), 60);
  assert.equal((await db.query("select status from public.pledges")).rows[0].status, "partial");
  assert.ok((await db.query("select count(*)::int n from public.audit_log")).rows[0].n >= before);
  await db.exec("select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false); set role authenticated;");
  const v = (await db.query("select public.audit_verify() v")).rows[0].v;
  assert.equal(v.ok, true, JSON.stringify(v));
  await assert.rejects(db.query("select public.public_ledger() j"), /permission denied/, "staff browsers can't call the server-only ledger function");
  await db.exec("reset role;");
  const L = (await db.query("select public.public_ledger() j")).rows[0].j;
  assert.equal(Number(L.totals.received), 60); assert.equal(L.areas[0].area, "Magnolia Point");
});
