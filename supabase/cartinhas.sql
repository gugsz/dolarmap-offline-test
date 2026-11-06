-- DolarMap — cartinhas secretas 💌 (mensagem que aparece na tela da outra pessoa).
-- Rode uma vez em: Supabase Dashboard > SQL Editor > New query > cole tudo > Run.
-- Não mexe na tabela de registros (transactions).

create table if not exists public.love_notes (
  id            uuid primary key default gen_random_uuid(),
  sender        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  sender_author text not null default '',
  recipient     text not null check (char_length(recipient) between 1 and 80), -- parte do e-mail antes do @
  message       text not null check (char_length(message) between 1 and 600),
  created_at    timestamptz not null default now(),
  opened_at     timestamptz
);

create index if not exists love_notes_inbox_idx on public.love_notes (recipient, opened_at);

-- Remetente definido pelo servidor a partir do login (ninguém manda carta "em nome" do outro).
create or replace function public.love_notes_set_sender()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.sender        := auth.uid();
  new.sender_author := lower(split_part(coalesce(auth.jwt() ->> 'email', ''), '@', 1));
  new.recipient     := lower(new.recipient);
  new.created_at    := now();
  new.opened_at     := null;
  return new;
end;
$$;

drop trigger if exists love_notes_set_sender on public.love_notes;
create trigger love_notes_set_sender
  before insert on public.love_notes
  for each row execute function public.love_notes_set_sender();

-- Num UPDATE só dá para marcar como aberta (o texto e o remetente não mudam).
create or replace function public.love_notes_only_open()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.sender        := old.sender;
  new.sender_author := old.sender_author;
  new.recipient     := old.recipient;
  new.message       := old.message;
  new.created_at    := old.created_at;
  new.opened_at     := coalesce(old.opened_at, now());
  return new;
end;
$$;

drop trigger if exists love_notes_only_open on public.love_notes;
create trigger love_notes_only_open
  before update on public.love_notes
  for each row execute function public.love_notes_only_open();

alter table public.love_notes enable row level security;

-- Quem enviou e quem recebeu podem ler.
drop policy if exists "ler minhas cartinhas" on public.love_notes;
create policy "ler minhas cartinhas" on public.love_notes
  for select to authenticated
  using (
    (select auth.uid()) = sender
    or recipient = lower(split_part(coalesce((select auth.jwt()) ->> 'email', ''), '@', 1))
  );

drop policy if exists "enviar cartinha" on public.love_notes;
create policy "enviar cartinha" on public.love_notes
  for insert to authenticated with check ((select auth.uid()) = sender);

-- Só quem recebeu marca como aberta.
drop policy if exists "abrir cartinha" on public.love_notes;
create policy "abrir cartinha" on public.love_notes
  for update to authenticated
  using (recipient = lower(split_part(coalesce((select auth.jwt()) ->> 'email', ''), '@', 1)))
  with check (recipient = lower(split_part(coalesce((select auth.jwt()) ->> 'email', ''), '@', 1)));

revoke all on public.love_notes from anon;
grant select, insert, update on public.love_notes to authenticated;
