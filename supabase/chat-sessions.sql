-- Migration : conversations multiples pour l'assistant IA.
-- À exécuter une fois dans l'éditeur SQL Supabase (idempotent).

create table if not exists public.chat_sessions (
    id uuid primary key default gen_random_uuid(),
    project_id uuid references public.projects(id) on delete cascade,
    user_id uuid not null references auth.users(id) on delete cascade,
    title text not null default 'Nouvelle conversation',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists idx_chat_sessions_user on public.chat_sessions(user_id, updated_at desc);

alter table public.chat_messages add column if not exists session_id uuid references public.chat_sessions(id) on delete cascade;
alter table public.chat_messages add column if not exists meta jsonb not null default '{}'::jsonb;
create index if not exists idx_chat_session on public.chat_messages(session_id, created_at);

do $$
declare
    pair record;
    new_id uuid;
begin
    for pair in
        select distinct user_id, project_id from public.chat_messages where session_id is null
    loop
        insert into public.chat_sessions (user_id, project_id, title)
        values (pair.user_id, pair.project_id, 'Conversation précédente')
        returning id into new_id;
        update public.chat_messages
           set session_id = new_id
         where session_id is null
           and user_id = pair.user_id
           and project_id is not distinct from pair.project_id;
    end loop;
end $$;

alter table public.chat_sessions enable row level security;
drop policy if exists "chat_sessions_own" on public.chat_sessions;
create policy "chat_sessions_own" on public.chat_sessions
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
