-- DolarMap — fotos de perfil 📸
-- Rode uma vez em: Supabase Dashboard > SQL Editor > New query > cole tudo > Run.
-- Não mexe nos registros nem nas cartinhas.

create table if not exists public.profiles (
  user_id    uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  username   text not null default '',
  avatar     text check (avatar is null or (char_length(avatar) <= 400000 and avatar like 'data:image/%')),
  updated_at timestamptz not null default now()
);

-- Dono e nome definidos pelo servidor a partir do login (ninguém troca a foto do outro).
create or replace function public.profiles_set_owner()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.user_id := auth.uid();
  else
    new.user_id := old.user_id;
  end if;
  new.username   := lower(split_part(coalesce(auth.jwt() ->> 'email', ''), '@', 1));
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists profiles_set_owner on public.profiles;
create trigger profiles_set_owner
  before insert or update on public.profiles
  for each row execute function public.profiles_set_owner();

alter table public.profiles enable row level security;

-- Os dois veem as fotos dos dois.
drop policy if exists "ver perfis" on public.profiles;
create policy "ver perfis" on public.profiles
  for select to authenticated using (true);

-- Cada um só cria/altera a própria foto.
drop policy if exists "criar meu perfil" on public.profiles;
create policy "criar meu perfil" on public.profiles
  for insert to authenticated with check ((select auth.uid()) = user_id);

drop policy if exists "alterar meu perfil" on public.profiles;
create policy "alterar meu perfil" on public.profiles
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on public.profiles from anon;
grant select, insert, update on public.profiles to authenticated;
