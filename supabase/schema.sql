-- DolarMap — esquema do banco (Supabase / Postgres).
-- Rode uma vez em: Supabase Dashboard > SQL Editor > New query > cole tudo > Run.

create table if not exists public.transactions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  author       text not null default '',
  kind         text not null check (kind in ('expense', 'buy', 'income')),
  amount_cents bigint not null check (amount_cents > 0 and amount_cents <= 100000000),
  currency     text not null check (currency in ('USD', 'BRL')),
  brl_cents    bigint check (brl_cents is null or (brl_cents > 0 and brl_cents <= 100000000)),
  category     text not null check (char_length(category) between 1 and 40),
  note         text not null default '' check (char_length(note) <= 120),
  occurred_on  date not null default current_date,
  created_at   timestamptz not null default now(),
  -- Regras de consistência
  constraint buy_has_brl check (kind <> 'buy' or (brl_cents is not null and currency = 'USD')),
  constraint income_is_usd check (kind <> 'income' or currency = 'USD')
);

create index if not exists transactions_occurred_idx
  on public.transactions (occurred_on desc, created_at desc);

-- Dono e autor são definidos pelo servidor a partir do token de login (o app não consegue forjar).
create or replace function public.transactions_set_owner()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.user_id := auth.uid();
  new.author  := lower(split_part(coalesce(auth.jwt() ->> 'email', ''), '@', 1));
  return new;
end;
$$;

drop trigger if exists transactions_set_owner on public.transactions;
create trigger transactions_set_owner
  before insert on public.transactions
  for each row execute function public.transactions_set_owner();

-- Impede trocar o dono num UPDATE.
create or replace function public.transactions_keep_owner()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.user_id    := old.user_id;
  new.author     := old.author;
  new.created_at := old.created_at;
  return new;
end;
$$;

drop trigger if exists transactions_keep_owner on public.transactions;
create trigger transactions_keep_owner
  before update on public.transactions
  for each row execute function public.transactions_keep_owner();

-- Row Level Security
alter table public.transactions enable row level security;

-- Os dois usuários (únicos cadastrados; cadastro público desativado) veem tudo — visão "Casal".
drop policy if exists "ler registros" on public.transactions;
create policy "ler registros" on public.transactions
  for select to authenticated using (true);

-- Cada um só cria/edita/apaga os próprios registros.
drop policy if exists "criar os seus" on public.transactions;
create policy "criar os seus" on public.transactions
  for insert to authenticated with check ((select auth.uid()) = user_id);

drop policy if exists "editar os seus" on public.transactions;
create policy "editar os seus" on public.transactions
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "apagar os seus" on public.transactions;
create policy "apagar os seus" on public.transactions
  for delete to authenticated using ((select auth.uid()) = user_id);

-- Nenhum acesso para visitantes não autenticados.
revoke all on public.transactions from anon;
grant select, insert, update, delete on public.transactions to authenticated;
