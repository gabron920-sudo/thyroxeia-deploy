-- Thyroxeia AI cloud persistence for decks + stats
-- Run in Supabase SQL Editor for project odyywykbaahgmnvashrs

-- 1) Store decks/cards in Supabase
create table if not exists public.decks (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  emoji text default '📚',
  cards jsonb not null default '[]'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.decks enable row level security;

do $$ begin
  create policy "Users can read own decks"
  on public.decks for select
  using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "Users can insert own decks"
  on public.decks for insert
  with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "Users can update own decks"
  on public.decks for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "Users can delete own decks"
  on public.decks for delete
  using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

-- 2) Store stats in profiles so XP/streak/cards studied survive device changes
alter table public.profiles
  add column if not exists xp integer default 0,
  add column if not exists streak integer default 0,
  add column if not exists cards_studied integer default 0,
  add column if not exists last_studied date;

-- Helpful updated_at trigger for decks
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_decks_updated_at on public.decks;
create trigger set_decks_updated_at
before update on public.decks
for each row execute function public.set_updated_at();
