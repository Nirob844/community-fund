// v3.1 hardening: neighborhood grouping, registration rule, tamper-evident audit log.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { makeDb, ids } from "./_setup.mjs";

let db;
const T = (q, p) => db.as("authenticated", ids.t, q, p);
const one = async (q, p) => (await db.query(q, p)).rows[0];
before(async () => { db = await makeDb(); });

test("neighborhood names are tidied so the same place is counted once", async () => {
  for (const [name, area] of [["A A", "magnolia  pt"], ["B B", " MAGNOLIA POINT "], ["C C", "Magnolia Point."], ["D D", "tuttle ave"], ["E E", "St Armands Cir"]]) {
    const c = (await T("insert into public.contributors(full_name, public_label, area) values ($1,$1,$2) returning id, area", [name, area])).rows[0];
    await T("insert into public.receipts(contributor_id, public_label, area, amount, method) values ($1,$2,$3,10,'Cash')", [c.id, name, area]);
  }
  const areas = (await one("select public.public_ledger() j")).j.areas.map((a) => a.area).sort();
  assert.deepEqual(areas, ["Magnolia Point", "St Armands Circle", "Tuttle Avenue"], "got " + areas.join(" | "));
  const mp = (await one("select public.public_ledger() j")).j.areas.find((a) => a.area === "Magnolia Point");
  assert.equal(Number(mp.contributors), 3); assert.equal(Number(mp.received), 30);
});

test("treasurer can merge nicknames into one neighborhood, and new entries follow", async () => {
  await T("insert into public.contributors(full_name, public_label, area) values ('F F','F F','MP')");
  const n = (await T("select public.rename_area('MP', 'magnolia point') n")).rows[0].n;
  assert.ok(n >= 1);
  const c = (await T("insert into public.contributors(full_name, public_label, area) values ('G G','G G','mp') returning area")).rows[0];
  assert.equal(c.area, "Magnolia Point");
  const counts = (await T("select * from public.area_counts()")).rows;
  assert.equal(counts.filter((r) => /magnolia/i.test(r.area)).length, 1, JSON.stringify(counts));
  await assert.rejects(db.as("authenticated", ids.r, "select public.rename_area('x','y')"), /not allowed/);
});

test("online payments cannot be switched on without a valid registration number, even directly in the database", async () => {
  await assert.rejects(T("update public.settings set accept_online = true, fdacs_reg = ''"), /settings_online_needs_reg|check/);
  await assert.rejects(T("update public.settings set fdacs_reg = 'not a number'"), /settings_reg_format|check/);
  await T("update public.settings set fdacs_reg = 'CH12345', accept_online = true");
  assert.equal((await one("select public.public_ledger() j")).j.org.acceptOnline, true);
  await assert.rejects(db.query("update public.settings set fdacs_reg = ''"), /check/, "clearing the number while payments are on must fail");
});

test("nobody can edit, delete or empty the audit log — not staff, not the server, not the owner", async () => {
  await assert.rejects(T("update public.audit_log set op = 'X'"), /permission denied/);
  await assert.rejects(T("delete from public.audit_log"), /permission denied/);
  await assert.rejects(db.as("service_role", null, "delete from public.audit_log"), /permission denied/);
  await assert.rejects(db.query("update public.audit_log set op = 'X' where id = 1"), /cannot be changed/);
  await assert.rejects(db.query("delete from public.audit_log where id = 1"), /cannot be changed/);
  await assert.rejects(db.query("truncate public.audit_log"), /cannot be changed/);
});

test("the audit chain verifies, and still verifies after a lawful erasure", async () => {
  let v = (await T("select public.audit_verify() v")).rows[0].v;
  assert.equal(v.ok, true, JSON.stringify(v)); assert.ok(v.checked > 10);
  const c = (await one("select id from public.contributors where full_name='A A'")).id;
  await T("select public.anonymize_contributor($1)", [c]);
  v = (await T("select public.audit_verify() v")).rows[0].v;
  assert.equal(v.ok, true, JSON.stringify(v)); assert.ok(v.erased >= 1);
  assert.ok(!JSON.stringify((await db.query("select old_row, new_row from public.audit_log")).rows).includes("\"A A\""));
});

test("any tampering is detected and pinpointed", async () => {
  const target = (await one("select id from public.audit_log where op='INSERT' and not erased order by id limit 1 offset 3")).id;
  // simulate an attacker with superuser powers who bypasses the guard
  await db.exec(`alter table public.audit_log disable trigger audit_guard; update public.audit_log set new_row = jsonb_set(coalesce(new_row,'{}'), '{amount}', '"99999"') where id = ${target}; alter table public.audit_log enable trigger audit_guard;`);
  const v = (await T("select public.audit_verify() v")).rows[0].v;
  assert.equal(v.ok, false); assert.equal(v.firstBadId, target); assert.match(v.reason, /contents were changed/);
});

test("removing an entry is detected too", async () => {
  const fresh = await makeDb();
  await fresh.as("authenticated", ids.t, "insert into public.expenses(amount, payee) values (1,'a'), (2,'b'), (3,'c')");
  const mid = (await fresh.query("select id from public.audit_log where table_name='expenses' order by id limit 1 offset 1")).rows[0].id;
  await fresh.exec(`alter table public.audit_log disable trigger audit_guard; delete from public.audit_log where id = ${mid}; alter table public.audit_log enable trigger audit_guard;`);
  const v = (await fresh.as("authenticated", ids.a, "select public.audit_verify() v")).rows[0].v;
  assert.equal(v.ok, false); assert.match(v.reason, /changed or removed/);
});
