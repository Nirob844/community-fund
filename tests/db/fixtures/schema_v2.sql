-- =====================================================================
-- Prospect Road Community Fund: database schema (Supabase / Postgres 15+)
-- Version 2. Safe to re-run. Run in Supabase: SQL Editor > New query > Run.
--
-- Security model
--   * Row Level Security is ON for every table. The public (anon) role has
--     NO access to any table. Public pages read only through /api/ledger,
--     which returns de-identified figures.
--   * Staff (at most 5 active people) sign in with an emailed one-time code:
--       treasurer : everything (expenses, settings, team, corrections)
--       recorder  : record pledges and deposits received; read the books
--       auditor   : read everything, change nothing
--   * Every insert, update and delete is written to an append-only audit log,
--     stamped with the staff member who made it.
--   * Pledge status (open / partial / paid) is recalculated by the database
--     whenever money is recorded, so every page and report stays in step.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- Staff ------------------------------------------------------
create table if not exists public.admins (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  role         text not null default 'recorder' check (role in ('treasurer','recorder','auditor')),
  display_name text not null default '' check (char_length(display_name) <= 60),
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);
alter table public.admins add column if not exists display_name text not null default '';
alter table public.admins add column if not exists active boolean not null default true;
alter table public.admins drop constraint if exists admins_role_check;
alter table public.admins add constraint admins_role_check check (role in ('treasurer','recorder','auditor'));

-- At most 5 active staff, and always at least one active treasurer once set up.
create or replace function public.enforce_staff_rules()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op in ('INSERT','UPDATE') and new.active then
    if (select count(*) from public.admins where active and user_id <> new.user_id) >= 5 then
      raise exception 'Staff limit reached: at most 5 active people (treasurer plus 4).' using errcode = 'check_violation';
    end if;
  end if;
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

create or replace function public.staff_role()
returns text language sql stable security definer set search_path = '' as $$
  select a.role from public.admins a where a.user_id = auth.uid() and a.active;
$$;
create or replace function public.is_admin()    returns boolean language sql stable security definer set search_path = '' as $$ select public.staff_role() = 'treasurer'; $$;
create or replace function public.is_recorder() returns boolean language sql stable security definer set search_path = '' as $$ select public.staff_role() in ('treasurer','recorder'); $$;
create or replace function public.is_auditor()  returns boolean language sql stable security definer set search_path = '' as $$ select public.staff_role() is not null; $$;

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
  status         text not null default 'open' check (status in ('open','partial','paid','cancelled')),
  created_by     uuid default auth.uid(),
  created_at     timestamptz not null default now()
);
alter table public.pledges add column if not exists pledged_on date not null default current_date;
alter table public.pledges add column if not exists source text not null default 'website';
alter table public.pledges add column if not exists created_by uuid default auth.uid();
alter table public.pledges drop constraint if exists pledges_status_check;
alter table public.pledges add constraint pledges_status_check check (status in ('open','partial','paid','cancelled'));
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
  updated_at    timestamptz not null default now()
);
insert into public.settings (id) values (1) on conflict do nothing;

-- ---------- Automatic pledge status -----------------------------------
-- Money received from a contributor is applied to their pledges oldest first.
create or replace function public.refresh_pledge_status(cid uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare paid numeric; running numeric := 0; p record;
begin
  if cid is null then return; end if;
  select coalesce(sum(amount),0) into paid from public.receipts where contributor_id = cid;
  for p in select id, amount from public.pledges
            where contributor_id = cid and status <> 'cancelled' order by pledged_on, created_at loop
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
  perform public.refresh_pledge_status(new.contributor_id);
  return null;
end $$;
drop trigger if exists pledges_status on public.pledges;
create trigger pledges_status after insert on public.pledges
  for each row execute function public.pledges_after_insert();

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
  foreach t in array array['contributors','pledges','receipts','expenses','settings','admins'] loop
    execute format('drop trigger if exists audit_%1$s on public.%1$s', t);
    execute format('create trigger audit_%1$s after insert or update or delete on public.%1$s
                    for each row execute function public.audit_trigger()', t);
  end loop;
end $$;

-- ---------- Privileges and Row Level Security -------------------------
alter table public.admins       enable row level security;
alter table public.contributors enable row level security;
alter table public.pledges      enable row level security;
alter table public.receipts     enable row level security;
alter table public.expenses     enable row level security;
alter table public.settings     enable row level security;
alter table public.audit_log    enable row level security;

revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;
revoke execute on all functions in schema public from anon;
grant select, insert, update, delete on public.contributors, public.pledges, public.receipts, public.expenses to authenticated;
grant select, update on public.settings to authenticated;
grant select on public.admins, public.audit_log to authenticated;
grant execute on function public.staff_role(), public.is_admin(), public.is_recorder(), public.is_auditor() to authenticated;

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
  execute 'create policy receipts_insert on public.receipts for insert to authenticated with check ((select public.is_recorder()) and stripe_session_id is null)';
  execute 'create policy expenses_insert on public.expenses for insert to authenticated with check ((select public.is_admin()))';

  execute 'create policy settings_read on public.settings for select to authenticated using ((select public.is_auditor()))';
  execute 'create policy settings_update on public.settings for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()))';
  execute 'create policy admins_read on public.admins for select to authenticated using ((select public.is_auditor()) or user_id = (select auth.uid()))';
  execute 'create policy audit_read on public.audit_log for select to authenticated using ((select public.is_auditor()))';
end $$;
-- No write policies on admins or audit_log: staff are managed by /api/staff
-- (server, treasurer-only) and the audit log is written only by triggers.

-- ---------- First treasurer -------------------------------------------
-- 1) Supabase Dashboard > Authentication > Users > "Add user" (your email, auto-confirm).
-- 2) Run (replace the email and name):
-- insert into public.admins(user_id, role, display_name)
--   select id, 'treasurer', 'Treasurer name' from auth.users where email = 'treasurer@example.org';
-- After that, add the other 4 people from the Team section of /admin/.
