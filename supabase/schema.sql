-- =====================================================================
-- Prospect Road Community Fund: database schema (Supabase / Postgres 15+)
-- Version 3.2. Safe to re-run (also upgrades version 2, 3 and 3.1 databases). Run in Supabase: SQL Editor > New query > Run.
--
-- Security model
--   * Row Level Security is ON for every table. The public (anon) role has
--     NO access to any table. Public pages read only through /api/ledger,
--     which returns de-identified figures.
--   * Staff (at most 5 active people) sign in with an emailed one-time code:
--       treasurer : everything (expenses, settings, team, corrections)
--       recorder  : record pledges and deposits received; read the books
--       auditor   : read everything, change nothing
--       developer : temporary (max 30 days), invited by the treasurer to fix an
--                   issue; sees settings, health checks and the activity log only,
--                   never personal data or the books; removable at any time
--   * Every sign-in, staff action, denied request and server error is written to an
--     append-only, hash-chained activity log.
--   * Every insert, update and delete is written to an append-only audit log,
--     stamped with the staff member who made it.
--   * Pledge status (open / partial / paid) is recalculated by the database
--     whenever money is recorded or refunded, so every page and report stays in step.
--   * All public figures are computed inside the database (public_ledger),
--     so totals stay exact at any size (no 1,000-row API limit).
--   * Refunds, chargebacks and closing payouts are first-class records.
--   * Personal data can be corrected, merged or erased (incl. audit history).
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- Staff ------------------------------------------------------
create table if not exists public.admins (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  role         text not null default 'recorder' check (role in ('treasurer','recorder','auditor','developer')),
  display_name text not null default '' check (char_length(display_name) <= 60),
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);
alter table public.admins add column if not exists display_name text not null default '';
alter table public.admins add column if not exists active boolean not null default true;
alter table public.admins drop constraint if exists admins_role_check;
alter table public.admins add constraint admins_role_check check (role in ('treasurer','recorder','auditor','developer'));
alter table public.admins add column if not exists access_expires_at timestamptz;
alter table public.admins add column if not exists invited_by uuid;
alter table public.admins add column if not exists purpose text not null default '';
alter table public.admins drop constraint if exists admins_purpose_len;
alter table public.admins add constraint admins_purpose_len check (char_length(purpose) <= 200);
alter table public.admins drop constraint if exists admins_dev_expiry;
alter table public.admins add constraint admins_dev_expiry check (role <> 'developer' or access_expires_at is not null);

-- At most 5 active staff, and always at least one active treasurer once set up.
-- A developer is temporary: one at a time, access for at most 30 days, not counted as a seat.
create or replace function public.enforce_staff_rules()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op in ('INSERT','UPDATE') and new.active and new.role <> 'developer' then
    if (select count(*) from public.admins where active and role <> 'developer' and user_id <> new.user_id) >= 5 then
      raise exception 'Staff limit reached: at most 5 active people (treasurer plus 4).' using errcode = 'check_violation';
    end if;
  end if;
  if tg_op in ('INSERT','UPDATE') and new.active and new.role = 'developer' then
    if (select count(*) from public.admins where active and role = 'developer' and user_id <> new.user_id
          and access_expires_at > now()) >= 1 then
      raise exception 'Only one developer can have access at a time.' using errcode = 'check_violation';
    end if;
    if tg_op = 'INSERT' or new.access_expires_at is distinct from old.access_expires_at or not old.active or old.role <> 'developer' then
      if new.access_expires_at is null or new.access_expires_at <= now() or new.access_expires_at > now() + interval '30 days 1 hour' then
        raise exception 'Developer access must end within 30 days.' using errcode = 'check_violation';
      end if;
    end if;
  end if;
  if tg_op = 'UPDATE' and new.role <> 'developer' then new.access_expires_at := null; end if;
  if tg_op in ('UPDATE','DELETE') and old.role = 'treasurer' and old.active
     and (tg_op = 'DELETE' or not new.active or new.role <> 'treasurer') then
    if not exists (select 1 from public.admins where active and role = 'treasurer' and user_id <> old.user_id) then
      raise exception 'Keep at least one active treasurer.' using errcode = 'check_violation';
    end if;
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists staff_rules on public.admins;
create trigger staff_rules before insert or update or delete on public.admins
  for each row execute function public.enforce_staff_rules();

-- Expired or deactivated access returns no role at all, so every rule below denies it at once.
create or replace function public.staff_role()
returns text language sql stable security definer set search_path = '' as $$
  select a.role from public.admins a where a.user_id = auth.uid() and a.active
     and (a.access_expires_at is null or a.access_expires_at > now());
$$;
create or replace function public.is_admin()     returns boolean language sql stable security definer set search_path = '' as $$ select coalesce(public.staff_role() = 'treasurer', false); $$;
create or replace function public.is_recorder()  returns boolean language sql stable security definer set search_path = '' as $$ select coalesce(public.staff_role() in ('treasurer','recorder'), false); $$;
-- "auditor or above": the people who may read the books and personal details (never a developer)
create or replace function public.is_auditor()   returns boolean language sql stable security definer set search_path = '' as $$ select coalesce(public.staff_role() in ('treasurer','recorder','auditor'), false); $$;
create or replace function public.is_staff()     returns boolean language sql stable security definer set search_path = '' as $$ select public.staff_role() is not null; $$;
create or replace function public.is_developer() returns boolean language sql stable security definer set search_path = '' as $$ select coalesce(public.staff_role() = 'developer', false); $$;
-- True only for requests made with the server's service-role key (never a browser).
create or replace function public.is_server()    returns boolean language sql stable set search_path = '' as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb)->>'role', '') = 'service_role';
$$;

-- ---------- Contributors (PRIVATE) ------------------------------------
create table if not exists public.contributors (
  id           uuid primary key default gen_random_uuid(),
  full_name    text not null check (char_length(full_name) between 1 and 80),
  email        text not null default '' check (char_length(email) <= 120),
  address      text not null default '' check (char_length(address) <= 160),
  area         text not null default '' check (char_length(area) <= 60),
  public_label text not null check (char_length(public_label) between 1 and 60),
  share_token  text not null unique default encode(gen_random_bytes(18), 'hex'),
  offline      boolean not null default false,
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now()
);
alter table public.contributors add column if not exists created_by uuid default auth.uid();
alter table public.contributors alter column email set default '';
drop index if exists public.contributors_email_uq;
create unique index if not exists contributors_email_uq2 on public.contributors (lower(email)) where email <> '';

-- ---------- Pledges ----------------------------------------------------
create table if not exists public.pledges (
  id             uuid primary key default gen_random_uuid(),
  contributor_id uuid not null references public.contributors(id) on delete cascade,
  amount         numeric(12,2) not null check (amount >= 1 and amount <= 2000000),
  pledged_on     date not null default current_date,
  source         text not null default 'website' check (source in ('website','staff')),
  status         text not null default 'open' check (status in ('open','partial','paid','cancelled','withdrawn')),
  note           text not null default '' check (char_length(note) <= 160),
  created_by     uuid default auth.uid(),
  created_at     timestamptz not null default now()
);
alter table public.pledges add column if not exists pledged_on date not null default current_date;
alter table public.pledges add column if not exists source text not null default 'website';
alter table public.pledges add column if not exists created_by uuid default auth.uid();
alter table public.pledges drop constraint if exists pledges_status_check;
alter table public.pledges add constraint pledges_status_check check (status in ('open','partial','paid','cancelled','withdrawn'));
alter table public.pledges add column if not exists note text not null default '';
create index if not exists pledges_contributor_idx on public.pledges(contributor_id);

-- ---------- Receipts (deposits / money actually received) -------------
create table if not exists public.receipts (
  id                uuid primary key default gen_random_uuid(),
  contributor_id    uuid references public.contributors(id) on delete set null,
  pledge_id         uuid references public.pledges(id) on delete set null,
  public_label      text not null default 'Anonymous neighbor',
  area              text not null default '',
  amount            numeric(12,2) not null check (amount > 0 and amount <= 2000000),
  received_on       date not null default current_date,
  method            text not null default 'Online (Stripe)'
                    check (method in ('Online (Stripe)','GoFundMe','Check','Zelle','Cash','Bank transfer','Other')),
  deposit_ref       text not null default '' check (char_length(deposit_ref) <= 80),   -- bank deposit slip / batch (private)
  reference         text not null default '' check (char_length(reference) <= 80),     -- check number etc. (private)
  stripe_session_id text unique,
  created_by        uuid default auth.uid(),
  created_at        timestamptz not null default now()
);
alter table public.receipts add column if not exists deposit_ref text not null default '';
alter table public.receipts add column if not exists disputed boolean not null default false;
alter table public.receipts add column if not exists stripe_charge_id text;
create unique index if not exists receipts_charge_uq on public.receipts(stripe_charge_id) where stripe_charge_id is not null;
create index if not exists receipts_received_on_idx on public.receipts(received_on);
alter table public.receipts drop constraint if exists receipts_method_check;
alter table public.receipts add constraint receipts_method_check
  check (method in ('Online (Stripe)','GoFundMe','Check','Zelle','Cash','Bank transfer','Other'));
create index if not exists receipts_contributor_idx on public.receipts(contributor_id);

-- ---------- Expenses ---------------------------------------------------
create table if not exists public.expenses (
  id          uuid primary key default gen_random_uuid(),
  spent_on    date not null default current_date,
  amount      numeric(12,2) not null check (amount > 0),
  payee       text not null check (char_length(payee) between 1 and 80),
  category    text not null default 'Other' check (category in (
                'Legal fees','Expert reports','Filing and court fees','Public records',
                'Printing and outreach','Platform and bank fees','Registration and filings',
                'Land acquisition','Other')),
  description text not null default '' check (char_length(description) <= 160),
  status      text not null default 'paid' check (status in ('paid','unpaid')),
  paid_on     date,
  stripe_ref  text unique,
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now()
);

-- ---------- Settings (single row) -------------------------------------
create table if not exists public.settings (
  id            int primary key default 1 check (id = 1),
  org_name      text not null default 'Prospect Road Community Fund',
  fdacs_reg     text not null default '',
  gofundme_url  text not null default '' check (gofundme_url = '' or gofundme_url like 'https://%'),
  accept_online boolean not null default false,
  milestones    jsonb not null default '[
    {"amount":10000,"title":"Retain a land use attorney","desc":"The minimum needed to challenge the eligibility decision."},
    {"amount":1700000,"title":"Match the land''s A-1 value","desc":"Enough to make a serious offer for the property."},
    {"amount":2000000,"title":"Buy the land and open a community park","desc":"Purchase, closing costs and first-year park setup."}
  ]'::jsonb,
  fund_status   text not null default 'open' check (fund_status in ('open','closing','closed')),
  closed_on     date,
  closing_note  text not null default '' check (char_length(closing_note) <= 500),
  updated_at    timestamptz not null default now()
);
insert into public.settings (id) values (1) on conflict do nothing;
alter table public.settings add column if not exists fund_status text not null default 'open';
alter table public.settings add column if not exists closed_on date;
alter table public.settings add column if not exists closing_note text not null default '';

-- ---------- Refunds, chargebacks and closing payouts ------------------
create table if not exists public.refunds (
  id             uuid primary key default gen_random_uuid(),
  receipt_id     uuid references public.receipts(id) on delete set null,
  contributor_id uuid references public.contributors(id) on delete set null,
  public_label   text not null default 'Anonymous neighbor',
  area           text not null default '',
  amount         numeric(12,2) not null check (amount > 0 and amount <= 2000000),
  kind           text not null check (kind in ('refund','dispute_lost','closing_payout')),
  method         text not null default 'Check' check (method in ('Stripe','Check','Zelle','Cash','Bank transfer','Other')),
  reason         text not null default '' check (char_length(reason) <= 160),
  refunded_on    date not null default current_date,
  stripe_ref     text unique,
  created_by     uuid default auth.uid(),
  created_at     timestamptz not null default now()
);
create index if not exists refunds_contributor_idx on public.refunds(contributor_id);

-- A refund can never exceed what is left of the original receipt.
create or replace function public.refunds_check()
returns trigger language plpgsql security definer set search_path = '' as $$
declare got numeric; back numeric;
begin
  if new.receipt_id is not null and new.kind <> 'closing_payout' then
    select amount into got from public.receipts where id = new.receipt_id;
    select coalesce(sum(amount),0) into back from public.refunds
     where receipt_id = new.receipt_id and kind <> 'closing_payout' and id <> new.id;
    if back + new.amount > got then
      raise exception 'Refund is more than what is left of that receipt (% of %).', got - back, got using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists refunds_check on public.refunds;
create trigger refunds_check before insert or update on public.refunds for each row execute function public.refunds_check();

-- ---------- Updates (news posts) ---------------------------------------
create table if not exists public.posts (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 80),
  title        text not null check (char_length(title) between 3 and 120),
  summary      text not null default '' check (char_length(summary) <= 280),
  body         text not null default '' check (char_length(body) <= 20000),
  published    boolean not null default false,
  published_on date not null default current_date,
  created_by   uuid default auth.uid(),
  updated_at   timestamptz not null default now()
);

-- ---------- Email log (private) ----------------------------------------
create table if not exists public.email_log (
  id             bigint generated always as identity primary key,
  at             timestamptz not null default now(),
  contributor_id uuid references public.contributors(id) on delete set null,
  kind           text not null,
  to_email       text not null default '',
  status         text not null default 'sent',
  provider_id    text,
  error          text
);

-- ---------- Automatic pledge status -----------------------------------
-- Money received from a contributor is applied to their pledges oldest first.
create or replace function public.refresh_pledge_status(cid uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare paid numeric; running numeric := 0; p record;
begin
  if cid is null then return; end if;
  select coalesce(sum(amount),0)
         - coalesce((select sum(amount) from public.refunds where contributor_id = cid and kind in ('refund','dispute_lost')),0)
    into paid from public.receipts where contributor_id = cid;
  for p in select id, amount from public.pledges
            where contributor_id = cid and status not in ('cancelled','withdrawn') order by pledged_on, created_at loop
    running := running + p.amount;
    update public.pledges set status = case
        when paid >= running then 'paid'
        when paid > running - p.amount then 'partial'
        else 'open' end
     where id = p.id and status is distinct from case
        when paid >= running then 'paid'
        when paid > running - p.amount then 'partial'
        else 'open' end;
  end loop;
end $$;

create or replace function public.receipts_after_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op in ('INSERT','UPDATE') then perform public.refresh_pledge_status(new.contributor_id); end if;
  if tg_op in ('UPDATE','DELETE') then perform public.refresh_pledge_status(old.contributor_id); end if;
  return null;
end $$;
drop trigger if exists receipts_status on public.receipts;
create trigger receipts_status after insert or update or delete on public.receipts
  for each row execute function public.receipts_after_change();

create or replace function public.pledges_after_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if pg_trigger_depth() > 1 then return null; end if;   -- ignore our own status updates
  if tg_op = 'UPDATE' and old.contributor_id is distinct from new.contributor_id then
    perform public.refresh_pledge_status(old.contributor_id);
  end if;
  perform public.refresh_pledge_status(coalesce(new.contributor_id, old.contributor_id));
  return null;
end $$;
drop trigger if exists pledges_status on public.pledges;
create trigger pledges_status after insert or update or delete on public.pledges
  for each row execute function public.pledges_after_insert();

create or replace function public.refunds_after_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op in ('INSERT','UPDATE') then perform public.refresh_pledge_status(new.contributor_id); end if;
  if tg_op in ('UPDATE','DELETE') then perform public.refresh_pledge_status(old.contributor_id); end if;
  return null;
end $$;
drop trigger if exists refunds_status on public.refunds;
create trigger refunds_status after insert or update or delete on public.refunds
  for each row execute function public.refunds_after_change();

-- New website pledges are refused once the fund is closing or closed.
create or replace function public.pledges_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (select fund_status from public.settings where id = 1) <> 'open' then
    raise exception 'The fund is no longer accepting pledges.' using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists pledges_guard on public.pledges;
create trigger pledges_guard before insert on public.pledges for each row execute function public.pledges_guard();

-- ---------- Audit log --------------------------------------------------
create table if not exists public.audit_log (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  actor      uuid default auth.uid(),
  table_name text not null,
  op         text not null,
  row_id     text,
  old_row    jsonb,
  new_row    jsonb
);

create or replace function public.audit_trigger()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.audit_log(table_name, op, row_id, old_row, new_row)
  values (tg_table_name, tg_op,
          coalesce((to_jsonb(new)->>'id'), (to_jsonb(new)->>'user_id'), (to_jsonb(old)->>'id'), (to_jsonb(old)->>'user_id')),
          case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
          case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end);
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array['contributors','pledges','receipts','expenses','settings','admins','refunds','posts'] loop
    execute format('drop trigger if exists audit_%1$s on public.%1$s', t);
    execute format('create trigger audit_%1$s after insert or update or delete on public.%1$s
                    for each row execute function public.audit_trigger()', t);
  end loop;
end $$;

-- ---------- Keep public labels in step when a contributor is corrected ----
create or replace function public.contributors_propagate()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.public_label is distinct from old.public_label or new.area is distinct from old.area then
    update public.receipts set public_label = new.public_label, area = new.area where contributor_id = new.id;
    update public.refunds  set public_label = new.public_label, area = new.area where contributor_id = new.id;
  end if;
  return null;
end $$;
drop trigger if exists contributors_propagate on public.contributors;
create trigger contributors_propagate after update on public.contributors
  for each row execute function public.contributors_propagate();

-- ---------- Public figures, computed in the database ------------------
-- One row per giver: a contributor, or an anonymous receipt on its own.
drop view if exists public.giver_balances cascade;
create view public.giver_balances with (security_invoker = true) as
with u as (
  select p.contributor_id as cid, null::uuid as rid, p.amount as pledged, 0::numeric as received
    from public.pledges p where p.status not in ('cancelled','withdrawn')
  union all
  select r.contributor_id, case when r.contributor_id is null then r.id end, 0, r.amount from public.receipts r
  union all
  select f.contributor_id, case when f.contributor_id is null then f.receipt_id end, 0, -f.amount
    from public.refunds f where f.kind in ('refund','dispute_lost')
), g as (select cid, rid, sum(pledged) as pledged, sum(received) as received from u group by cid, rid)
select coalesce(g.cid::text, 'r:' || g.rid::text) as k,
       coalesce(c.public_label, r.public_label, 'Neighbor') as label,
       coalesce(c.area, r.area, '') as area,
       g.cid as contributor_id,
       g.pledged, greatest(g.received, 0) as received,
       greatest(g.pledged - greatest(g.received, 0), 0) as outstanding
  from g
  left join public.contributors c on c.id = g.cid
  left join public.receipts r on r.id = g.rid;

create or replace function public.ledger_totals()
returns jsonb language sql stable security definer set search_path = '' as $$
  with t as (
    select
      (select coalesce(sum(amount),0) from public.receipts) gross,
      (select coalesce(sum(amount),0) from public.refunds where kind in ('refund','dispute_lost')) refunded,
      (select coalesce(sum(amount),0) from public.refunds where kind = 'closing_payout') payouts,
      (select coalesce(sum(amount),0) from public.expenses where status = 'paid') exp_paid,
      (select coalesce(sum(amount),0) from public.expenses where status = 'unpaid') exp_unpaid,
      (select coalesce(sum(amount),0) from public.receipts where disputed) disputed,
      (select coalesce(sum(outstanding),0) from public.giver_balances) outstanding,
      (select count(*) from public.giver_balances where received > 0 or outstanding > 0) givers
  )
  select jsonb_build_object(
    'receivedGross', gross, 'refunded', refunded, 'received', gross - refunded, 'payouts', payouts,
    'expensesPaid', exp_paid, 'expensesUnpaid', exp_unpaid, 'expenses', exp_paid + exp_unpaid,
    'cash', gross - refunded - exp_paid - payouts, 'disputed', disputed,
    'outstandingPledges', outstanding, 'contributors', givers,
    'availableToReturn', greatest(gross - refunded - exp_paid - exp_unpaid - payouts, 0),
    'closingPool', greatest(gross - refunded - exp_paid - exp_unpaid, 0))
  from t;
$$;

create or replace function public.public_ledger()
returns jsonb language sql stable security definer set search_path = '' as $$
with b as materialized (select * from public.giver_balances where received > 0 or outstanding > 0),
t0 as (
  select
    (select coalesce(sum(amount),0) from public.receipts) as gross,
    (select coalesce(sum(amount),0) from public.refunds where kind in ('refund','dispute_lost')) as refunded,
    (select coalesce(sum(amount),0) from public.refunds where kind = 'closing_payout') as payouts,
    (select coalesce(sum(amount),0) from public.expenses where status = 'paid') as exp_paid,
    (select coalesce(sum(amount),0) from public.expenses where status = 'unpaid') as exp_unpaid,
    (select coalesce(sum(amount),0) from public.receipts where disputed) as disputed,
    (select coalesce(sum(outstanding),0) from b) as outstanding,
    (select count(*) from b) as givers
), t as (
  select t0.*, gross - refunded as net, greatest(gross - refunded - exp_paid - exp_unpaid - payouts, 0) as avail from t0
), s as (select * from public.settings where id = 1)
select jsonb_build_object(
  'generatedAt', now(),
  'org', (select jsonb_build_object('name', org_name, 'fdacsReg', fdacs_reg, 'gofundmeUrl', gofundme_url,
           'acceptOnline', accept_online and fund_status = 'open', 'fundStatus', fund_status,
           'closedOn', closed_on, 'closingNote', closing_note) from s),
  'milestones', (select milestones from s),
  'totals', (select jsonb_build_object(
    'receivedGross', gross, 'refunded', refunded, 'received', net, 'payouts', payouts,
    'expensesPaid', exp_paid, 'expensesUnpaid', exp_unpaid, 'expenses', exp_paid + exp_unpaid,
    'cash', net - exp_paid - payouts, 'disputed', disputed, 'outstandingPledges', outstanding,
    'contributors', givers, 'availableToReturn', avail, 'closingPool', greatest(net - exp_paid - exp_unpaid, 0)) from t),
  'areas', coalesce((select jsonb_agg(x order by x.received + x.outstanding desc) from (
      select coalesce(nullif(area,''),'Not given') as area, sum(received) as received, sum(outstanding) as outstanding, count(*) as contributors
        from b group by 1) x), '[]'),
  'people', coalesce((select jsonb_agg(x) from (
      select b.label, b.area, b.pledged, b.received, b.outstanding,
             case when t.net > 0 then b.received / t.net else 0 end as share,
             case when t.net > 0 then round(t.avail * b.received / t.net, 2) else 0 end as refund
        from b cross join t order by b.received desc, b.outstanding desc limit 1000) x), '[]'),
  'peopleTotal', (select givers from t),
  'receipts', coalesce((select jsonb_agg(x) from (
      select to_char(received_on,'YYYY-MM-DD') as date, public_label as label, area, method, amount, disputed
        from public.receipts order by received_on desc, created_at desc limit 100) x), '[]'),
  'receiptsTotal', (select count(*) from public.receipts),
  'refunds', coalesce((select jsonb_agg(x) from (
      select to_char(refunded_on,'YYYY-MM-DD') as date, public_label as label, area, amount, kind, reason
        from public.refunds order by refunded_on desc, created_at desc limit 100) x), '[]'),
  'expenses', coalesce((select jsonb_agg(x) from (
      select to_char(spent_on,'YYYY-MM-DD') as date, payee, category, description, status, amount
        from public.expenses order by spent_on desc, created_at desc limit 500) x), '[]'),
  'expensesTotal', (select count(*) from public.expenses),
  'methods', coalesce((select jsonb_agg(x order by x.amount desc) from (
      select method, sum(amount) as amount, count(*) as n from public.receipts group by method) x), '[]'),
  'categories', coalesce((select jsonb_agg(x order by x.amount desc) from (
      select category, sum(amount) as amount from public.expenses group by category) x), '[]'),
  'months', coalesce((select jsonb_agg(x order by x.month desc) from (
      select month, sum(n)::int as n, sum(rec) as received, sum(back) as refunded, sum(spent) as spent from (
        select to_char(received_on,'YYYY-MM') as month, 1 as n, amount as rec, 0 as back, 0 as spent from public.receipts
        union all select to_char(refunded_on,'YYYY-MM'), 0, 0, amount, 0 from public.refunds where kind in ('refund','dispute_lost')
        union all select to_char(spent_on,'YYYY-MM'), 0, 0, 0, amount from public.expenses) u group by month) x), '[]'),
  'daily', coalesce((select jsonb_agg(x order by x.date) from (
      select to_char(d,'YYYY-MM-DD') as date, sum(a) as amount from (
        select received_on as d, amount as a from public.receipts
        union all select refunded_on, -amount from public.refunds where kind in ('refund','dispute_lost')) u group by d) x), '[]'),
  'sizes', (select jsonb_build_array(
      count(*) filter (where received > 0 and received < 50), count(*) filter (where received >= 50 and received < 100),
      count(*) filter (where received >= 100 and received < 250), count(*) filter (where received >= 250 and received < 500),
      count(*) filter (where received >= 500 and received < 1000), count(*) filter (where received >= 1000)) from b)
);
$$;

-- A contributor's own figures, looked up by their private link token.
create or replace function public.my_share(token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c public.contributors; b public.giver_balances; t jsonb; net numeric;
begin
  select * into c from public.contributors where share_token = token;
  if c.id is null then return null; end if;
  select * into b from public.giver_balances where contributor_id = c.id;
  t := public.ledger_totals(); net := (t->>'received')::numeric;
  return jsonb_build_object('label', c.public_label, 'area', c.area,
    'pledged', coalesce(b.pledged,0), 'received', coalesce(b.received,0),
    'fundReceived', net, 'fundExpenses', (t->>'expenses')::numeric, 'availableToReturn', (t->>'availableToReturn')::numeric,
    'share', case when net > 0 then coalesce(b.received,0) / net else 0 end,
    'refund', case when net > 0 then round((t->>'availableToReturn')::numeric * coalesce(b.received,0) / net, 2) else 0 end,
    'paidOut', (select coalesce(sum(amount),0) from public.refunds where contributor_id = c.id and kind = 'closing_payout'),
    'fundStatus', (select fund_status from public.settings where id = 1));
end $$;

-- ---------- Closing the fund: exact payout plan -----------------------
-- Pool = net contributions − all expenses. Each contributor gets their share,
-- rounded to the cent with the largest-remainder method so the plan adds up exactly.
create or replace function public.closing_plan()
returns table (contributor_id uuid, full_name text, email text, label text, area text,
               contributed numeric, share numeric, due numeric, paid_out numeric, remaining numeric)
language plpgsql stable security definer set search_path = '' as $$
declare pool_cents bigint; net numeric;
begin
  if not public.is_auditor() then raise exception 'not allowed' using errcode = '42501'; end if;
  pool_cents := round(((public.ledger_totals())->>'closingPool')::numeric * 100);
  select coalesce(sum(received),0) into net from public.giver_balances;
  return query
  with g as (
    select b.contributor_id cid, b.k, b.label, b.area, b.received,
           case when net > 0 then b.received / net else 0 end sh
      from public.giver_balances b where b.received > 0
  ), f as (
    select g.*, floor(pool_cents * g.sh)::bigint fl, (pool_cents * g.sh) - floor(pool_cents * g.sh) rem from g
  ), r as (
    select f.*, row_number() over (order by rem desc, k) rn, pool_cents - sum(fl) over () leftover from f
  )
  select r.cid, c.full_name, c.email, r.label, r.area, r.received, round(r.sh, 6),
         ((r.fl + case when r.rn <= r.leftover then 1 else 0 end) / 100.0)::numeric(12,2),
         coalesce((select sum(x.amount) from public.refunds x where x.contributor_id = r.cid and x.kind = 'closing_payout'), 0),
         greatest(((r.fl + case when r.rn <= r.leftover then 1 else 0 end) / 100.0)
           - coalesce((select sum(x.amount) from public.refunds x where x.contributor_id = r.cid and x.kind = 'closing_payout'), 0), 0)::numeric(12,2)
    from r left join public.contributors c on c.id = r.cid
   order by r.received desc;
end $$;

-- ---------- Personal data tools (treasurer only) ----------------------
-- Erase a person's details on request. Money records stay (required for the books)
-- but no longer identify them, including in the audit history.
create or replace function public.anonymize_contributor(cid uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare scrub jsonb := jsonb_build_object('full_name','[erased]','email','','address','','public_label','Anonymous neighbor');
begin
  if not public.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.contributors set full_name = '[erased]', email = '', address = '', public_label = 'Anonymous neighbor',
         share_token = substr(replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-',''), 1, 36) where id = cid;
  update public.email_log set to_email = '' where contributor_id = cid;
  perform set_config('app.audit_erasure', 'on', true);
  update public.audit_log set
      old_row = case when old_row is null then null when table_name = 'contributors' then old_row || scrub else old_row || jsonb_build_object('public_label','Anonymous neighbor') end,
      new_row = case when new_row is null then null when table_name = 'contributors' then new_row || scrub else new_row || jsonb_build_object('public_label','Anonymous neighbor') end
    where (table_name = 'contributors' and row_id = cid::text)
       or (table_name in ('receipts','refunds','pledges') and (old_row->>'contributor_id' = cid::text or new_row->>'contributor_id' = cid::text));
  perform set_config('app.audit_erasure', 'off', true);
  insert into public.audit_log(table_name, op, row_id) values ('contributors', 'ERASE', cid::text);
end $$;

-- Combine two records for the same person (e.g. a paper pledge and a website pledge).
create or replace function public.merge_contributors(src uuid, dst uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare d public.contributors;
begin
  if not public.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  if src = dst then raise exception 'Choose two different people.' using errcode = 'check_violation'; end if;
  select * into d from public.contributors where id = dst;
  if d.id is null then raise exception 'Unknown contributor.' using errcode = 'check_violation'; end if;
  update public.pledges   set contributor_id = dst where contributor_id = src;
  update public.receipts  set contributor_id = dst, public_label = d.public_label, area = d.area where contributor_id = src;
  update public.refunds   set contributor_id = dst, public_label = d.public_label, area = d.area where contributor_id = src;
  update public.email_log set contributor_id = dst where contributor_id = src;
  delete from public.contributors where id = src;
  perform public.refresh_pledge_status(dst);
end $$;

-- ---------- Books export: double-entry general journal -----------------
create or replace function public.export_journal()
returns table (entry_date date, entry text, account text, debit numeric, credit numeric, memo text, ref text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_auditor() then raise exception 'not allowed' using errcode = '42501'; end if;
  return query
  select * from (
    select r.received_on, 'Contribution', 'Cash', r.amount, 0::numeric, r.public_label || ' · ' || r.method, r.id::text from public.receipts r
    union all select r.received_on, 'Contribution', 'Contribution revenue', 0, r.amount, r.public_label || ' · ' || r.method, r.id::text from public.receipts r
    union all select f.refunded_on, initcap(replace(f.kind,'_',' ')),
                     case when f.kind = 'closing_payout' then 'Distributions to contributors' else 'Refunds and chargebacks (contra revenue)' end,
                     f.amount, 0, f.public_label || coalesce(' · ' || nullif(f.reason,''), ''), f.id::text from public.refunds f
    union all select f.refunded_on, initcap(replace(f.kind,'_',' ')), 'Cash', 0, f.amount, f.public_label, f.id::text from public.refunds f
    union all select e.spent_on, 'Expense', 'Expense: ' || e.category, e.amount, 0, e.payee || coalesce(' · ' || nullif(e.description,''), ''), e.id::text from public.expenses e
    union all select e.spent_on, 'Expense', 'Accounts payable', 0, e.amount, e.payee, e.id::text from public.expenses e
    union all select coalesce(e.paid_on, e.spent_on), 'Bill payment', 'Accounts payable', e.amount, 0, e.payee, e.id::text from public.expenses e where e.status = 'paid'
    union all select coalesce(e.paid_on, e.spent_on), 'Bill payment', 'Cash', 0, e.amount, e.payee, e.id::text from public.expenses e where e.status = 'paid'
  ) j order by 1, 7, 2, 4 desc;
end $$;

-- =====================================================================
-- Hardening (v3.1)
-- =====================================================================

-- ---------- 1. Neighborhood names are grouped consistently -----------
-- "magnolia  pt", "MAGNOLIA POINT" and "Magnolia Point" all become "Magnolia Point".
-- The treasurer can also map nicknames (e.g. "MP") with rename_area().
create table if not exists public.area_aliases (
  alias     text primary key check (alias = lower(alias) and char_length(alias) between 1 and 60),
  canonical text not null check (char_length(canonical) between 1 and 60),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

create or replace function public.normalize_area(a text)
returns text language plpgsql stable set search_path = '' as $$
declare s text; c text;
begin
  s := regexp_replace(btrim(coalesce(a, '')), '\s+', ' ', 'g');
  s := regexp_replace(s, '[ .,;:]+$', '');            -- trailing punctuation
  if s = '' then return ''; end if;
  select canonical into c from public.area_aliases where alias = lower(s);
  if c is not null then return c; end if;
  s := initcap(lower(s));
  -- expand common street-name abbreviations (never the first word, so "St Armands" stays)
  s := regexp_replace(s, '( )(Pt|Pnt)\.?(?= |$)', '\1Point', 'g');
  s := regexp_replace(s, '( )Rd\.?(?= |$)', '\1Road', 'g');
  s := regexp_replace(s, '( )(Ave|Av)\.?(?= |$)', '\1Avenue', 'g');
  s := regexp_replace(s, '( )St\.?(?= |$)', '\1Street', 'g');
  s := regexp_replace(s, '( )Blvd\.?(?= |$)', '\1Boulevard', 'g');
  s := regexp_replace(s, '( )Dr\.?(?= |$)', '\1Drive', 'g');
  s := regexp_replace(s, '( )Ln\.?(?= |$)', '\1Lane', 'g');
  s := regexp_replace(s, '( )Ct\.?(?= |$)', '\1Court', 'g');
  s := regexp_replace(s, '( )Cir\.?(?= |$)', '\1Circle', 'g');
  s := regexp_replace(s, '( )(Est|Ests)\.?(?= |$)', '\1Estates', 'g');
  s := regexp_replace(s, '( )Hts\.?(?= |$)', '\1Heights', 'g');
  select canonical into c from public.area_aliases where alias = lower(s);
  return left(coalesce(c, s), 60);
end $$;

create or replace function public.area_normalize_trigger()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.area := public.normalize_area(new.area);
  return new;
end $$;
do $$
declare t text;
begin
  foreach t in array array['contributors','receipts','refunds'] loop
    execute format('drop trigger if exists area_normalize on public.%1$s', t);
    execute format('create trigger area_normalize before insert or update of area on public.%1$s
                    for each row execute function public.area_normalize_trigger()', t);
  end loop;
end $$;
-- tidy existing data (only rows that would change)
update public.contributors set area = area where area is distinct from public.normalize_area(area);
update public.receipts     set area = area where area is distinct from public.normalize_area(area);
update public.refunds      set area = area where area is distinct from public.normalize_area(area);

-- Neighborhood names in use, with counts (staff screen).
create or replace function public.area_counts()
returns table (area text, contributors bigint, receipts bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_auditor() then raise exception 'not allowed' using errcode = '42501'; end if;
  return query
  select x.area, sum(x.c)::bigint, sum(x.r)::bigint from (
    select c.area, 1 as c, 0 as r from public.contributors c
    union all select r.area, 0, 1 from public.receipts r where r.contributor_id is null) x
  where x.area <> '' group by x.area order by 2 desc, 1;
end $$;

-- Rename or merge a neighborhood everywhere, and remember the old spelling.
create or replace function public.rename_area(old_name text, new_name text)
returns integer language plpgsql security definer set search_path = '' as $$
declare target text; n integer := 0; k integer;
begin
  if not public.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  target := public.normalize_area(new_name);
  if target = '' or btrim(coalesce(old_name, '')) = '' then raise exception 'Enter both names.' using errcode = 'check_violation'; end if;
  if lower(btrim(old_name)) <> lower(target) then
    insert into public.area_aliases(alias, canonical) values (lower(regexp_replace(btrim(old_name), '\s+', ' ', 'g')), target)
      on conflict (alias) do update set canonical = excluded.canonical;
  end if;
  update public.contributors set area = target where lower(area) = lower(btrim(old_name)); get diagnostics k = row_count; n := n + k;
  update public.receipts set area = target where lower(area) = lower(btrim(old_name)); get diagnostics k = row_count; n := n + k;
  update public.refunds  set area = target where lower(area) = lower(btrim(old_name)); get diagnostics k = row_count; n := n + k;
  return n;
end $$;

-- ---------- 2. Online payments need a registration number (enforced here) --
update public.settings set accept_online = false
 where accept_online and not coalesce(fdacs_reg, '') ~ '^[A-Z]{1,3}[0-9]{2,8}$';
alter table public.settings drop constraint if exists settings_reg_format;
alter table public.settings add constraint settings_reg_format check (fdacs_reg = '' or fdacs_reg ~ '^[A-Z]{1,3}[0-9]{2,8}$');
alter table public.settings drop constraint if exists settings_online_needs_reg;
alter table public.settings add constraint settings_online_needs_reg check (not accept_online or fdacs_reg <> '');

-- ---------- 3. Tamper-evident, write-protected audit log ---------------
-- Each entry stores a hash of its contents and a hash chained to the entry before it,
-- so any later change or removal is detectable with audit_verify(). Nobody can update,
-- delete or truncate the log; the only exception is a personal-data erasure, which
-- scrubs the contents, marks the entry "erased" and keeps the chain intact.
alter table public.audit_log add column if not exists content_hash text;
alter table public.audit_log add column if not exists chain_hash text;
alter table public.audit_log add column if not exists erased boolean not null default false;

create or replace function public.audit_hash(prev text, a public.audit_log)
returns text language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(concat_ws('|', coalesce(prev, 'genesis'), a.at::text, coalesce(a.actor::text, ''),
         a.table_name, a.op, coalesce(a.row_id, ''), a.content_hash), 'UTF8')), 'hex');
$$;
create or replace function public.audit_content_hash(o jsonb, n jsonb)
returns text language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(coalesce(o::text, '') || '|' || coalesce(n::text, ''), 'UTF8')), 'hex');
$$;

create or replace function public.audit_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare prev text;
begin
  perform pg_advisory_xact_lock(7340021);            -- one writer at a time keeps the chain linear
  select chain_hash into prev from public.audit_log order by id desc limit 1;
  new.erased := false;
  new.content_hash := public.audit_content_hash(new.old_row, new.new_row);
  new.chain_hash := public.audit_hash(prev, new);
  return new;
end $$;
drop trigger if exists audit_hash on public.audit_log;
create trigger audit_hash before insert on public.audit_log for each row execute function public.audit_before_insert();

create or replace function public.audit_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and current_setting('app.audit_erasure', true) = 'on'
     and new.id = old.id and new.at = old.at and new.actor is not distinct from old.actor
     and new.table_name = old.table_name and new.op = old.op and new.row_id is not distinct from old.row_id
     and new.content_hash = old.content_hash and new.chain_hash = old.chain_hash then
    new.erased := true;
    return new;
  end if;
  raise exception 'The audit log cannot be changed or deleted.' using errcode = '42501';
end $$;
create or replace function public.audit_guard_truncate()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'The audit log cannot be changed or deleted.' using errcode = '42501';
end $$;

-- Backfill hashes for entries written before v3.1 (runs once; guard not yet active).
drop trigger if exists audit_guard on public.audit_log;
drop trigger if exists audit_guard_truncate on public.audit_log;
do $$
declare r public.audit_log; prev text := null; ch text;
begin
  if exists (select 1 from public.audit_log where chain_hash is null) then
    for r in select * from public.audit_log order by id loop
      ch := coalesce(r.content_hash, public.audit_content_hash(r.old_row, r.new_row));
      r.content_hash := ch;
      prev := public.audit_hash(prev, r);
      update public.audit_log set content_hash = ch, chain_hash = prev where id = r.id;
    end loop;
  end if;
end $$;
create trigger audit_guard before update or delete on public.audit_log for each row execute function public.audit_guard();
create trigger audit_guard_truncate before truncate on public.audit_log for each statement execute function public.audit_guard_truncate();

-- Check the whole chain. Returns {ok, checked, erased, firstBadId, reason}.
create or replace function public.audit_verify()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare r public.audit_log; prev text := null; n int := 0; er int := 0;
begin
  if not public.is_staff() and not public.is_server() then raise exception 'not allowed' using errcode = '42501'; end if;
  for r in select * from public.audit_log order by id loop
    n := n + 1;
    if r.erased then er := er + 1;
    elsif r.content_hash is distinct from public.audit_content_hash(r.old_row, r.new_row) then
      return jsonb_build_object('ok', false, 'checked', n, 'erased', er, 'firstBadId', r.id, 'reason', 'Entry contents were changed');
    end if;
    if r.chain_hash is distinct from public.audit_hash(prev, r) then
      return jsonb_build_object('ok', false, 'checked', n, 'erased', er, 'firstBadId', r.id, 'reason', 'An entry before this one was changed or removed');
    end if;
    prev := r.chain_hash;
  end loop;
  return jsonb_build_object('ok', true, 'checked', n, 'erased', er, 'firstBadId', null, 'reason', null);
end $$;

-- =====================================================================
-- Version 3.2: giving plans, treasurer limits and goals, goal prompts,
-- developer access and handover, activity log, function lockdown
-- =====================================================================

-- ---------- Treasurer-controlled limits, goals and prompts -------------
alter table public.settings add column if not exists min_gift numeric(12,2) not null default 5;
alter table public.settings add column if not exists max_gift numeric(12,2) not null default 10000;
alter table public.settings add column if not exists max_pledge numeric(12,2) not null default 2000000;
alter table public.settings add column if not exists max_deposit numeric(12,2) not null default 250000;
alter table public.settings add column if not exists allow_plans boolean not null default true;
alter table public.settings add column if not exists max_plan_payments int not null default 24;
alter table public.settings add column if not exists suggested_amounts jsonb not null default '[25,50,100,250,500,1000]'::jsonb;
alter table public.settings add column if not exists prompts_enabled boolean not null default true;
alter table public.settings add column if not exists prompt_headline text not null default '';
alter table public.settings add column if not exists goal_deadline date;
alter table public.settings add column if not exists handover_at timestamptz;
alter table public.settings add column if not exists handover_by uuid;
alter table public.settings add column if not exists keys_rotated_on date;

create or replace function public.valid_amounts(a jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select jsonb_typeof(a) = 'array' and jsonb_array_length(a) between 1 and 8
     and not exists (select 1 from jsonb_array_elements(a) e
                      where jsonb_typeof(e) <> 'number' or (e::text)::numeric < 1 or (e::text)::numeric > 2000000);
$$;
create or replace function public.valid_milestones(m jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select jsonb_typeof(m) = 'array' and jsonb_array_length(m) between 1 and 10
     and not exists (select 1 from jsonb_array_elements(m) e
                      where jsonb_typeof(e) <> 'object' or jsonb_typeof(e->'amount') <> 'number'
                         or (e->>'amount')::numeric <= 0 or (e->>'amount')::numeric > 100000000
                         or char_length(coalesce(e->>'title','')) not between 1 and 80
                         or char_length(coalesce(e->>'desc','')) > 200);
$$;
alter table public.settings drop constraint if exists settings_limits;
alter table public.settings add constraint settings_limits check (
  min_gift >= 1 and min_gift <= max_gift and max_gift <= 2000000
  and max_pledge >= min_gift and max_pledge <= 2000000
  and max_deposit >= 1 and max_deposit <= 2000000
  and max_plan_payments between 2 and 120);
alter table public.settings drop constraint if exists settings_amounts;
alter table public.settings add constraint settings_amounts check (public.valid_amounts(suggested_amounts));
alter table public.settings drop constraint if exists settings_milestones;
alter table public.settings add constraint settings_milestones check (public.valid_milestones(milestones));
alter table public.settings drop constraint if exists settings_headline;
alter table public.settings add constraint settings_headline check (char_length(prompt_headline) <= 160);

-- Website pledges must respect the limits (staff entries are checked by max_deposit on money received).
create or replace function public.pledges_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare s public.settings;
begin
  select * into s from public.settings where id = 1;
  if s.fund_status <> 'open' then
    raise exception 'The fund is no longer accepting pledges.' using errcode = 'check_violation';
  end if;
  if new.source = 'website' and (new.amount < s.min_gift or new.amount > s.max_pledge) then
    raise exception 'Pledge must be between % and %.', s.min_gift, s.max_pledge using errcode = 'check_violation';
  end if;
  return new;
end $$;

-- ---------- Giving plans: small gifts over time -----------------------
create table if not exists public.giving_plans (
  id                     uuid primary key default gen_random_uuid(),
  contributor_id         uuid not null references public.contributors(id) on delete cascade,
  pledge_id              uuid references public.pledges(id) on delete set null,
  installment            numeric(12,2) not null check (installment >= 1 and installment <= 2000000),
  frequency              text not null check (frequency in ('weekly','monthly','quarterly')),
  payments               int not null check (payments between 2 and 120),
  method                 text not null default 'card' check (method in ('card','manual')),
  status                 text not null default 'pending' check (status in ('pending','active','past_due','completed','cancelled')),
  start_on               date not null default current_date,
  stripe_subscription_id text unique,
  stripe_customer_id     text,
  paid_count             int not null default 0,
  paid_total             numeric(12,2) not null default 0,
  last_paid_on           date,
  cancelled_on           date,
  cancel_reason          text not null default '' check (char_length(cancel_reason) <= 160),
  created_by             uuid default auth.uid(),
  created_at             timestamptz not null default now()
);
create index if not exists giving_plans_contributor_idx on public.giving_plans(contributor_id);
alter table public.receipts add column if not exists plan_id uuid references public.giving_plans(id) on delete set null;
alter table public.receipts add column if not exists stripe_invoice_id text;
create unique index if not exists receipts_invoice_uq on public.receipts(stripe_invoice_id) where stripe_invoice_id is not null;

create or replace function public.plan_next_due(p public.giving_plans)
returns date language sql immutable set search_path = '' as $$
  select case when p.status in ('completed','cancelled') then null
    else (p.start_on + (case p.frequency when 'weekly' then interval '7 days' when 'monthly' then interval '1 month' else interval '3 months' end) * p.paid_count)::date end;
$$;

-- New plans must respect the treasurer's limits.
create or replace function public.plans_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare s public.settings;
begin
  select * into s from public.settings where id = 1;
  if tg_op = 'INSERT' then
    if s.fund_status <> 'open' then raise exception 'The fund is no longer accepting pledges.' using errcode = 'check_violation'; end if;
    if new.method = 'card' and not s.allow_plans then raise exception 'Giving plans are switched off.' using errcode = 'check_violation'; end if;
    if new.payments > s.max_plan_payments then raise exception 'A plan can have at most % payments.', s.max_plan_payments using errcode = 'check_violation'; end if;
    if new.method = 'card' and (new.installment < s.min_gift or new.installment > s.max_gift) then
      raise exception 'Each payment must be between % and %.', s.min_gift, s.max_gift using errcode = 'check_violation';
    end if;
    if new.method = 'manual' and new.installment > s.max_deposit then
      raise exception 'Each payment must be at most %.', s.max_deposit using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists plans_guard on public.giving_plans;
create trigger plans_guard before insert or update on public.giving_plans for each row execute function public.plans_guard();

-- Count payments made on a plan; a plan completes itself after its last payment.
create or replace function public.refresh_plan(pid uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare n int; tot numeric; last date;
begin
  if pid is null then return; end if;
  select count(*), coalesce(sum(amount),0), max(received_on) into n, tot, last from public.receipts where plan_id = pid;
  update public.giving_plans set paid_count = n, paid_total = tot, last_paid_on = last,
         status = case when status in ('pending','active','past_due') and n >= payments then 'completed'
                       when status = 'completed' and n < payments then 'active'
                       when status = 'pending' and n > 0 then 'active'
                       else status end
   where id = pid;
end $$;
create or replace function public.receipts_plan_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op in ('INSERT','UPDATE') then perform public.refresh_plan(new.plan_id); end if;
  if tg_op in ('UPDATE','DELETE') and old.plan_id is distinct from coalesce(new.plan_id, null) then perform public.refresh_plan(old.plan_id); end if;
  return null;
end $$;
drop trigger if exists receipts_plan on public.receipts;
create trigger receipts_plan after insert or update or delete on public.receipts for each row execute function public.receipts_plan_change();

-- Stop a plan. The pledge shrinks to what was actually given, so "still to come" stays honest.
create or replace function public.cancel_plan(pid uuid, why text default '')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare p public.giving_plans;
begin
  if not (public.is_admin() or public.is_server()) then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into p from public.giving_plans where id = pid for update;
  if p.id is null then raise exception 'Unknown plan.' using errcode = 'check_violation'; end if;
  if p.status in ('completed','cancelled') then return jsonb_build_object('status', p.status, 'changed', false); end if;
  update public.giving_plans set status = 'cancelled', cancelled_on = current_date, cancel_reason = left(coalesce(why,''),160) where id = pid;
  if p.pledge_id is not null then
    if p.paid_total >= 1 then update public.pledges set amount = p.paid_total, note = left('Giving plan stopped after ' || p.paid_count || ' payment(s)', 160) where id = p.pledge_id;
    else update public.pledges set status = 'withdrawn', note = 'Giving plan stopped before the first payment' where id = p.pledge_id; end if;
  end if;
  return jsonb_build_object('status', 'cancelled', 'changed', true);
end $$;

-- Money received by hand must respect the deposit limit (card payments already happened, so they are always recorded).
create or replace function public.receipts_limit()
returns trigger language plpgsql security definer set search_path = '' as $$
declare lim numeric;
begin
  if new.stripe_session_id is null and new.stripe_invoice_id is null and (tg_op = 'INSERT' or new.amount is distinct from old.amount) then
    select max_deposit into lim from public.settings where id = 1;
    if new.amount > lim then
      raise exception 'This deposit is above the % limit set by the treasurer.', lim using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists receipts_limit on public.receipts;
create trigger receipts_limit before insert or update on public.receipts for each row execute function public.receipts_limit();

-- ---------- Activity log: who did what, failed attempts, errors ------
create table if not exists public.activity_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  actor       uuid,
  actor_label text not null default '' check (char_length(actor_label) <= 120),
  role        text not null default '' check (char_length(role) <= 20),
  action      text not null check (action ~ '^[a-z_]+(\.[a-z_]+)*$' and char_length(action) <= 60),
  level       text not null default 'info' check (level in ('info','warn','error','security')),
  ip_hash     text not null default '' check (char_length(ip_hash) <= 32),
  path        text not null default '' check (char_length(path) <= 120),
  detail      jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object' and pg_column_size(detail) <= 4000),
  chain_hash  text
);
create index if not exists activity_at_idx on public.activity_log(at desc);
create index if not exists activity_level_idx on public.activity_log(level, at desc);

create or replace function public.activity_hash(prev text, a public.activity_log)
returns text language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(concat_ws('|', coalesce(prev,'genesis'), a.at::text, coalesce(a.actor::text,''), a.actor_label,
         a.role, a.action, a.level, a.ip_hash, a.path, a.detail::text), 'UTF8')), 'hex');
$$;
create or replace function public.activity_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare prev text;
begin
  perform pg_advisory_xact_lock(7340022);
  select chain_hash into prev from public.activity_log order by id desc limit 1;
  new.at := clock_timestamp();
  new.chain_hash := public.activity_hash(prev, new);
  return new;
end $$;
drop trigger if exists activity_hash on public.activity_log;
create trigger activity_hash before insert on public.activity_log for each row execute function public.activity_before_insert();
create or replace function public.activity_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'The activity log cannot be changed or deleted.' using errcode = '42501';
end $$;
drop trigger if exists activity_guard on public.activity_log;
drop trigger if exists activity_guard_truncate on public.activity_log;
create trigger activity_guard before update or delete on public.activity_log for each row execute function public.activity_guard();
create trigger activity_guard_truncate before truncate on public.activity_log for each statement execute function public.activity_guard();

create or replace function public.activity_verify()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare r public.activity_log; prev text := null; n int := 0;
begin
  if not public.is_staff() and not public.is_server() then raise exception 'not allowed' using errcode = '42501'; end if;
  for r in select * from public.activity_log order by id loop
    n := n + 1;
    if r.chain_hash is distinct from public.activity_hash(prev, r) then
      return jsonb_build_object('ok', false, 'checked', n, 'firstBadId', r.id);
    end if;
    prev := r.chain_hash;
  end loop;
  return jsonb_build_object('ok', true, 'checked', n, 'firstBadId', null);
end $$;

-- Staff browsers may add a few kinds of entries (sign-in, sign-out, downloads, page errors).
-- The actor and role are taken from the session, never from the browser.
create or replace function public.log_activity(act text, info jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare r text := public.staff_role(); em text;
begin
  if r is null then raise exception 'not allowed' using errcode = '42501'; end if;
  if act not in ('client.sign_in','client.sign_out','client.export','client.error','client.view_security') then
    raise exception 'Unknown activity.' using errcode = 'check_violation';
  end if;
  select email into em from auth.users where id = auth.uid();
  insert into public.activity_log(actor, actor_label, role, action, level, detail)
  values (auth.uid(), coalesce(em,''), r, act, case when act = 'client.error' then 'error' else 'info' end,
          coalesce((select jsonb_object_agg(k, left(v, 200)) from jsonb_each_text(case when jsonb_typeof(info) = 'object' then info else '{}'::jsonb end) x(k, v)
                     where k in ('file','rows','message','page')), '{}'::jsonb));
end $$;

-- Changes to the team, settings and handover are also written to the activity log by the database itself.
create or replace function public.activity_from_db()
returns trigger language plpgsql security definer set search_path = '' as $$
declare em text; d jsonb := '{}'::jsonb; act text; lvl text := 'info';
begin
  select email into em from auth.users where id = auth.uid();
  if tg_table_name = 'admins' then
    act := case when tg_op = 'INSERT' then 'team.add' when tg_op = 'DELETE' then 'team.delete'
                when old.active and not new.active then 'team.deactivate' when not old.active and new.active then 'team.reactivate' else 'team.change' end;
    d := jsonb_build_object('user', coalesce(new.user_id, old.user_id), 'role', coalesce(new.role, old.role),
                            'expires', coalesce(new.access_expires_at, old.access_expires_at));
    lvl := 'security';
  elsif tg_table_name = 'settings' then
    if new.handover_at is distinct from old.handover_at and new.handover_at is not null then act := 'handover.complete'; lvl := 'security';
    elsif (new.min_gift, new.max_gift, new.max_pledge, new.max_deposit, new.allow_plans, new.max_plan_payments)
          is distinct from (old.min_gift, old.max_gift, old.max_pledge, old.max_deposit, old.allow_plans, old.max_plan_payments) then act := 'settings.limits';
    elsif new.milestones is distinct from old.milestones then act := 'settings.goals';
    elsif new.accept_online is distinct from old.accept_online then act := 'settings.payments'; lvl := 'security';
    else act := 'settings.change'; end if;
  else
    return null;
  end if;
  insert into public.activity_log(actor, actor_label, role, action, level, detail)
  values (auth.uid(), coalesce(em, case when auth.uid() is null then 'server' else '' end), coalesce(public.staff_role(), ''), act, lvl, d);
  return null;
end $$;
drop trigger if exists activity_admins on public.admins;
create trigger activity_admins after insert or update or delete on public.admins for each row execute function public.activity_from_db();
drop trigger if exists activity_settings on public.settings;
create trigger activity_settings after update on public.settings for each row execute function public.activity_from_db();

-- ---------- Handover: confirming it removes every developer at once ----
create or replace function public.settings_handover()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.handover_at is not null and new.handover_at is distinct from old.handover_at then
    new.handover_by := auth.uid();
    update public.admins set active = false where role = 'developer' and active;
  end if;
  return new;
end $$;
drop trigger if exists settings_handover on public.settings;
create trigger settings_handover before update on public.settings for each row execute function public.settings_handover();

-- ---------- Security self-check (treasurer and developer) --------------
create or replace function public.security_audit()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare checks jsonb := '[]'::jsonb; n int; names text;
begin
  if not (public.is_admin() or public.is_developer() or public.is_server()) then raise exception 'not allowed' using errcode = '42501'; end if;
  select count(*), string_agg(c.relname, ', ') into n, names from pg_class c join pg_namespace s on s.oid = c.relnamespace
   where s.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  checks := checks || jsonb_build_object('name', 'Row Level Security on every table', 'ok', n = 0, 'detail', coalesce(names, ''));
  select count(*), string_agg(distinct c.relname, ', ') into n, names from pg_class c join pg_namespace s on s.oid = c.relnamespace
   where s.nspname = 'public' and c.relkind in ('r','v') and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('anon', c.oid, 'insert')
         or has_table_privilege('anon', c.oid, 'update') or has_table_privilege('anon', c.oid, 'delete'));
  checks := checks || jsonb_build_object('name', 'The public (anon) key can read or change no table', 'ok', n = 0, 'detail', coalesce(names, ''));
  select count(*), string_agg(p.proname, ', ') into n, names from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'public' and p.prokind = 'f' and has_function_privilege('anon', p.oid, 'execute')
     and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e');
  checks := checks || jsonb_build_object('name', 'The public (anon) key can run no database function', 'ok', n = 0, 'detail', coalesce(names, ''));
  select count(*), string_agg(p.proname, ', ') into n, names from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'public' and p.prosecdef and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%');
  checks := checks || jsonb_build_object('name', 'Every privileged function has a fixed search path', 'ok', n = 0, 'detail', coalesce(names, ''));
  select count(*) into n from public.admins where active and role = 'treasurer';
  checks := checks || jsonb_build_object('name', 'At least one active treasurer', 'ok', n >= 1, 'detail', n || ' active');
  select count(*) into n from public.admins where active and role <> 'developer';
  checks := checks || jsonb_build_object('name', 'No more than 5 active team members', 'ok', n <= 5, 'detail', n || ' active');
  select count(*) into n from public.admins where active and role = 'developer' and access_expires_at > now();
  checks := checks || jsonb_build_object('name', 'Developer access', 'ok', true,
    'detail', case when n = 0 then 'No developer has access' else n || ' developer with access until ' ||
      (select to_char(max(access_expires_at), 'YYYY-MM-DD HH24:MI') from public.admins where active and role = 'developer') end);
  checks := checks || jsonb_build_object('name', 'Audit log intact', 'ok', ((public.audit_verify())->>'ok')::boolean, 'detail', '');
  checks := checks || jsonb_build_object('name', 'Activity log intact', 'ok', ((public.activity_verify())->>'ok')::boolean, 'detail', '');
  checks := checks || jsonb_build_object('name', 'Card payments only with a state registration', 'ok',
    (select not accept_online or fdacs_reg ~ '^[A-Z]{1,3}[0-9]{2,8}$' from public.settings where id = 1), 'detail', '');
  return jsonb_build_object('ok', not exists (select 1 from jsonb_array_elements(checks) e where not (e->>'ok')::boolean),
    'checks', checks, 'handoverAt', (select handover_at from public.settings where id = 1),
    'keysRotatedOn', (select keys_rotated_on from public.settings where id = 1), 'at', now());
end $$;

-- ---------- Public figures: limits, goal and plan totals --------------
create or replace function public.public_ledger_v2()
returns jsonb language sql stable security definer set search_path = '' as $$
  select public.public_ledger() || jsonb_build_object(
    'limits', (select jsonb_build_object('minGift', min_gift, 'maxGift', max_gift, 'maxPledge', max_pledge,
                'allowPlans', allow_plans and accept_online and fund_status = 'open', 'maxPlanPayments', max_plan_payments,
                'suggestedAmounts', suggested_amounts) from public.settings where id = 1),
    'goal', (select jsonb_build_object('promptsEnabled', prompts_enabled, 'headline', prompt_headline, 'deadline', goal_deadline)
               from public.settings where id = 1),
    'plans', (select jsonb_build_object('active', count(*),
                'monthly', coalesce(round(sum(case frequency when 'weekly' then installment * 52 / 12 when 'monthly' then installment else installment / 3 end), 2), 0),
                'stillToCome', coalesce(sum(installment * greatest(payments - paid_count, 0)), 0))
               from public.giving_plans where status in ('active','past_due')));
$$;

-- A contributor's own figures and plans (private link).
create or replace function public.my_share_v2(token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare base jsonb; cid uuid; s public.settings;
begin
  base := public.my_share(token);
  if base is null then return null; end if;
  select id into cid from public.contributors where share_token = token;
  select * into s from public.settings where id = 1;
  return base || jsonb_build_object(
    'owed', greatest((base->>'pledged')::numeric - (base->>'received')::numeric, 0),
    'acceptOnline', s.accept_online and s.fund_status = 'open',
    'limits', jsonb_build_object('minGift', s.min_gift, 'maxGift', s.max_gift, 'allowPlans', s.allow_plans and s.accept_online and s.fund_status = 'open',
                                 'maxPlanPayments', s.max_plan_payments, 'suggestedAmounts', s.suggested_amounts),
    'plans', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'installment', p.installment, 'frequency', p.frequency,
                'payments', p.payments, 'paidCount', p.paid_count, 'paidTotal', p.paid_total, 'status', p.status, 'method', p.method,
                'nextDue', public.plan_next_due(p), 'startOn', p.start_on) order by p.created_at desc)
               from public.giving_plans p where p.contributor_id = cid), '[]'::jsonb));
end $$;

-- ---------- Privileges and Row Level Security -------------------------
alter table public.admins       enable row level security;
alter table public.contributors enable row level security;
alter table public.pledges      enable row level security;
alter table public.receipts     enable row level security;
alter table public.expenses     enable row level security;
alter table public.settings     enable row level security;
alter table public.audit_log    enable row level security;
alter table public.refunds      enable row level security;
alter table public.posts        enable row level security;
alter table public.email_log    enable row level security;
alter table public.area_aliases enable row level security;
alter table public.giving_plans enable row level security;
alter table public.activity_log enable row level security;

revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;
-- Lockdown: no database function can be run by anyone unless granted below. Postgres lets
-- everyone (PUBLIC) run new functions by default; that default is switched off here.
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace s on s.oid = p.pronamespace
            where s.nspname = 'public' and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e') loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
alter default privileges in schema public revoke execute on functions from public;
-- The server (service role) works with every table, but can never rewrite the logs.
grant select, insert, update, delete on all tables in schema public to service_role;
grant select, insert, update, delete on public.contributors, public.pledges, public.receipts, public.expenses to authenticated;
grant select, update on public.settings to authenticated;
grant select on public.admins, public.audit_log to authenticated;
grant select, insert, update, delete on public.refunds, public.posts to authenticated;
grant select on public.email_log, public.giver_balances to authenticated;
grant select on public.area_aliases to authenticated;
grant select, insert, update, delete on public.giving_plans to authenticated;
grant select on public.activity_log to authenticated;
-- The audit and activity logs are append-only for everyone, including the server's service role.
revoke update, delete, truncate on public.audit_log, public.activity_log from anon, authenticated, service_role;
-- Functions staff browsers may call (each checks the caller's role itself).
grant execute on function public.staff_role(), public.is_admin(), public.is_recorder(), public.is_auditor(), public.is_staff(),
  public.is_developer(), public.is_server(), public.valid_amounts(jsonb), public.valid_milestones(jsonb), public.normalize_area(text),
  public.ledger_totals(), public.closing_plan(), public.anonymize_contributor(uuid), public.merge_contributors(uuid, uuid),
  public.export_journal(), public.area_counts(), public.rename_area(text, text), public.audit_verify(), public.activity_verify(),
  public.log_activity(text, jsonb), public.security_audit(), public.cancel_plan(uuid, text) to authenticated;

do $$
declare t text; p text;
begin
  -- drop every existing policy on our tables, then recreate
  for t, p in select tablename, policyname from pg_policies where schemaname = 'public' loop
    execute format('drop policy if exists %I on public.%I', p, t);
  end loop;

  foreach t in array array['contributors','pledges','receipts','expenses'] loop
    execute format('create policy %1$s_read on public.%1$s for select to authenticated using ((select public.is_auditor()))', t);
    execute format('create policy %1$s_update on public.%1$s for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()))', t);
    execute format('create policy %1$s_delete on public.%1$s for delete to authenticated using ((select public.is_admin()))', t);
  end loop;
  -- recorders can add contributors, pledges and deposits; only the treasurer adds expenses
  execute 'create policy contributors_insert on public.contributors for insert to authenticated with check ((select public.is_recorder()))';
  execute 'create policy pledges_insert on public.pledges for insert to authenticated with check ((select public.is_recorder()))';
  execute 'create policy receipts_insert on public.receipts for insert to authenticated with check ((select public.is_recorder()) and stripe_session_id is null and stripe_invoice_id is null)';
  -- giving plans: recorders add hand-collected (manual) plans; card plans are created by the server only
  execute 'create policy plans_read on public.giving_plans for select to authenticated using ((select public.is_auditor()))';
  execute 'create policy plans_insert on public.giving_plans for insert to authenticated with check ((select public.is_recorder()) and method = ''manual'' and stripe_subscription_id is null)';
  execute 'create policy plans_update on public.giving_plans for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()))';
  execute 'create policy plans_delete on public.giving_plans for delete to authenticated using ((select public.is_admin()))';
  execute 'create policy activity_read on public.activity_log for select to authenticated using ((select public.is_staff()))';
  execute 'create policy expenses_insert on public.expenses for insert to authenticated with check ((select public.is_admin()))';
  -- refunds, payouts and news posts: treasurer only; everyone on the team can read
  foreach t in array array['refunds','posts'] loop
    execute format('create policy %1$s_read on public.%1$s for select to authenticated using ((select public.is_auditor()))', t);
    execute format('create policy %1$s_write on public.%1$s for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()))', t);
  end loop;
  execute 'create policy email_read on public.email_log for select to authenticated using ((select public.is_auditor()))';
  execute 'create policy aliases_read on public.area_aliases for select to authenticated using ((select public.is_auditor()))';

  execute 'create policy settings_read on public.settings for select to authenticated using ((select public.is_staff()))';
  execute 'create policy settings_update on public.settings for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()))';
  execute 'create policy admins_read on public.admins for select to authenticated using ((select public.is_auditor()) or user_id = (select auth.uid()))';
  execute 'create policy audit_read on public.audit_log for select to authenticated using ((select public.is_auditor()))';
end $$;
-- No write policies on admins, audit_log or activity_log: staff are managed by /api/staff
-- (server, treasurer-only) and the logs are written only by triggers, the server and log_activity().

-- ---------- First treasurer -------------------------------------------
-- 1) Supabase Dashboard > Authentication > Users > "Add user" (your email, auto-confirm).
-- 2) Run (replace the email and name):
-- insert into public.admins(user_id, role, display_name)
--   select id, 'treasurer', 'Treasurer name' from auth.users where email = 'treasurer@example.org';
-- After that, add the other 4 people from the Team section of /admin/.
