-- First Light — public.stands
-- Wind & Stand Planner persistent storage.
-- Each row is one of the user's saved high seats (stand) with the
-- bearing deer typically come from. Scoped per-user via RLS.
--
-- Run order (matches the project convention from
-- scripts/syndicate-messages.sql referenced at diary.js:8366):
--   1. Run this file in the Supabase SQL editor against staging.
--   2. Verify with the audit query below.
--   3. Run again against prod.
--
-- Verification:
--   select * from pg_policies where tablename = 'stands';
--   -- should return four rows: select_own, insert_own, update_own, delete_own.

create table if not exists public.stands (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  preferred_approach_deg integer check (preferred_approach_deg between 0 and 359),
  species_pref text[] default '{}',
  notes text check (notes is null or char_length(notes) <= 500),
  ground text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists stands_user_id_idx on public.stands (user_id);

-- Enable Row-Level Security and add per-user policies. Mirrors the
-- pattern already used on cull_entries and grounds (see
-- scripts/supabase-audit-rls-snapshot.json referenced at
-- modules/supabase.mjs:34).
alter table public.stands enable row level security;

drop policy if exists stands_select_own on public.stands;
create policy stands_select_own on public.stands
  for select using (auth.uid() = user_id);

drop policy if exists stands_insert_own on public.stands;
create policy stands_insert_own on public.stands
  for insert with check (auth.uid() = user_id);

drop policy if exists stands_update_own on public.stands;
create policy stands_update_own on public.stands
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists stands_delete_own on public.stands;
create policy stands_delete_own on public.stands
  for delete using (auth.uid() = user_id);

-- Auto-touch updated_at on UPDATE so the planner can show
-- "edited <relative>" without the client having to set it.
create or replace function public.stands_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists stands_touch_updated_at on public.stands;
create trigger stands_touch_updated_at
  before update on public.stands
  for each row execute function public.stands_touch_updated_at();

-- Grants — the anon key role is `authenticated` once a user signs in.
grant select, insert, update, delete on public.stands to authenticated;
