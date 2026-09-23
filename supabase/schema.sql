-- =============================================================================
-- NIRA DEV — schéma Supabase (projets, brief, tâches, revues de code, assistant)
-- =============================================================================
-- À exécuter dans l'éditeur SQL de Supabase. Le script est idempotent : il peut
-- être rejoué sans risque.
--
-- Il est ADDITIF : s'il est exécuté sur le projet Supabase du CRM, il réutilise
-- la table `profiles` existante (en lui ajoutant deux colonnes) et ne touche à
-- aucune table du CRM (leads, events, activities).
--
-- Modèle de rôles :
--   * admin   — gère les comptes, voit tout, et est manager par défaut ;
--   * manager — crée les projets, rédige les briefs, assigne les tâches ;
--   * dev     — consulte le brief, avance ses tâches, soumet son code.
-- =============================================================================

-- Email promu admin automatiquement à la première inscription.
create or replace function public.dev_bootstrap_admin_email()
returns text language sql immutable as $$ select 'clarence@nira-ia.com'::text $$;

-- -----------------------------------------------------------------------------
-- 1. Profils
-- -----------------------------------------------------------------------------
create table if not exists public.profiles (
    id uuid primary key references auth.users(id) on delete cascade,
    email text not null,
    full_name text not null default '',
    role text not null default 'user' check (role in ('admin', 'user')),
    active boolean not null default true,
    theme text not null default 'light' check (theme in ('light', 'midnight', 'ocean', 'sunset')),
    created_at timestamptz not null default now()
);

-- Rôle propre à Nira Dev : il coexiste avec `role` (utilisé par le CRM).
alter table public.profiles add column if not exists dev_role text not null default 'dev';
alter table public.profiles add column if not exists dev_access boolean not null default true;
alter table public.profiles add column if not exists job_title text not null default '';
alter table public.profiles add column if not exists skills jsonb not null default '[]'::jsonb;

do $$ begin
  alter table public.profiles add constraint profiles_dev_role_check
    check (dev_role in ('admin', 'manager', 'dev'));
exception when duplicate_object then null; end $$;

-- Un admin du CRM est admin ici aussi ; les autres comptes existants sont devs.
update public.profiles set dev_role = 'admin' where role = 'admin' and dev_role = 'dev';

-- -----------------------------------------------------------------------------
-- 2. Fonctions d'autorisation (security definer : pas de récursion RLS)
-- -----------------------------------------------------------------------------
create or replace function public.dev_role()
returns text language sql stable security definer set search_path = public as $$
  select coalesce((select p.dev_role from public.profiles p
                    where p.id = auth.uid() and p.active and p.dev_access), 'none');
$$;

create or replace function public.is_dev_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select public.dev_role() = 'admin';
$$;

-- Un admin est manager par défaut.
create or replace function public.is_dev_manager()
returns boolean language sql stable security definer set search_path = public as $$
  select public.dev_role() in ('admin', 'manager');
$$;

create or replace function public.is_dev_member()
returns boolean language sql stable security definer set search_path = public as $$
  select public.dev_role() <> 'none';
$$;

-- Les fonctions d'accès aux projets interrogent des tables créées plus bas :
-- elles sont donc définies après elles (section 4), Postgres validant le corps
-- d'une fonction SQL dès sa création.

-- -----------------------------------------------------------------------------
-- 3. Création automatique du profil à l'inscription
-- -----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  assigned_role text;
begin
  select case
    when (select count(*) from public.profiles) = 0 then 'admin'
    when new.email = public.dev_bootstrap_admin_email() then 'admin'
    else 'user'
  end into assigned_role;

  insert into public.profiles (id, email, full_name, role, dev_role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    assigned_role,
    case when assigned_role = 'admin' then 'admin' else 'dev' end
  )
  on conflict (id) do nothing;

  -- Ce déclencheur porte le même nom que celui de Nira CRM et le remplace quand
  -- les deux outils partagent un projet Supabase : on conserve donc son effet de
  -- bord (le premier admin hérite des données importées avant les comptes).
  -- Le test to_regclass évite toute erreur sur un projet où le CRM n'existe pas.
  if assigned_role = 'admin' then
    if to_regclass('public.leads') is not null then
      execute 'update public.leads set owner_id = $1 where owner_id is null' using new.id;
    end if;
    if to_regclass('public.events') is not null then
      execute 'update public.events set owner_id = $1 where owner_id is null' using new.id;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- -----------------------------------------------------------------------------
-- 4. Projets
-- -----------------------------------------------------------------------------
create table if not exists public.projects (
    id uuid primary key default gen_random_uuid(),
    name text not null default 'Nouveau projet',
    code text not null default 'PRJ',
    client text not null default '',
    summary text not null default '',
    status text not null default 'active' check (status in ('draft', 'active', 'paused', 'shipped', 'archived')),
    color text not null default 'violet',
    repo_url text not null default '',
    stack jsonb not null default '[]'::jsonb,
    start_date date,
    due_date date,
    manager_id uuid references auth.users(id) on delete set null,
    created_by uuid references auth.users(id) on delete set null,
    brief_pdf_url text,
    brief_pdf_name text,
    brief_pdf_size bigint,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter table public.projects add column if not exists brief_pdf_url text;
alter table public.projects add column if not exists brief_pdf_name text;
alter table public.projects add column if not exists brief_pdf_size bigint;

create table if not exists public.project_members (
    project_id uuid not null references public.projects(id) on delete cascade,
    user_id uuid not null references auth.users(id) on delete cascade,
    role_in_project text not null default 'dev' check (role_in_project in ('lead', 'dev', 'qa', 'design')),
    added_at timestamptz not null default now(),
    primary key (project_id, user_id)
);

-- Accès à un projet : manager du projet, membre de l'équipe, ou admin.
create or replace function public.can_see_project(pid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_dev_admin()
      or exists (select 1 from public.projects p
                  where p.id = pid and (p.manager_id = auth.uid() or p.created_by = auth.uid()))
      or exists (select 1 from public.project_members m
                  where m.project_id = pid and m.user_id = auth.uid());
$$;

-- Droit d'écriture "manager" sur un projet précis.
create or replace function public.can_manage_project(pid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_dev_admin()
      or exists (select 1 from public.projects p
                  where p.id = pid and public.is_dev_manager()
                    and (p.manager_id = auth.uid() or p.created_by = auth.uid()));
$$;

-- -----------------------------------------------------------------------------
-- 5. Briefs (versionnés : un brief publié ne se réécrit pas, il se re-publie)
-- -----------------------------------------------------------------------------
create table if not exists public.briefs (
    id uuid primary key default gen_random_uuid(),
    project_id uuid not null references public.projects(id) on delete cascade,
    version integer not null default 1,
    title text not null default '',
    context text not null default '',
    objectives text not null default '',
    scope text not null default '',
    out_of_scope text not null default '',
    constraints text not null default '',
    tech_notes text not null default '',
    deliverables text not null default '',
    acceptance jsonb not null default '[]'::jsonb,
    published boolean not null default false,
    author_id uuid references auth.users(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists idx_briefs_project on public.briefs(project_id);

-- -----------------------------------------------------------------------------
-- 6. Tâches
-- -----------------------------------------------------------------------------
create table if not exists public.tasks (
    id uuid primary key default gen_random_uuid(),
    project_id uuid not null references public.projects(id) on delete cascade,
    seq integer not null default 0,
    title text not null default 'Nouvelle tâche',
    description text not null default '',
    status text not null default 'backlog'
      check (status in ('backlog', 'todo', 'in_progress', 'review', 'blocked', 'done')),
    priority text not null default 'medium' check (priority in ('low', 'medium', 'high', 'urgent')),
    kind text not null default 'feature' check (kind in ('feature', 'bug', 'chore', 'spike', 'doc')),
    assignee_id uuid references auth.users(id) on delete set null,
    reporter_id uuid references auth.users(id) on delete set null,
    estimate numeric not null default 0,
    spent numeric not null default 0,
    due_date date,
    labels jsonb not null default '[]'::jsonb,
    acceptance jsonb not null default '[]'::jsonb,
    order_index numeric not null default 0,
    blocked_reason text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    done_at timestamptz
);
create index if not exists idx_tasks_project on public.tasks(project_id);
create index if not exists idx_tasks_assignee on public.tasks(assignee_id);

-- Numérotation lisible par projet : PRJ-1, PRJ-2…
create or replace function public.tasks_assign_seq()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.seq is null or new.seq = 0 then
    select coalesce(max(t.seq), 0) + 1 into new.seq from public.tasks t where t.project_id = new.project_id;
  end if;
  return new;
end;
$$;

drop trigger if exists tasks_seq on public.tasks;
create trigger tasks_seq before insert on public.tasks
  for each row execute function public.tasks_assign_seq();

create table if not exists public.task_comments (
    id uuid primary key default gen_random_uuid(),
    task_id uuid not null references public.tasks(id) on delete cascade,
    author_id uuid references auth.users(id) on delete set null,
    body text not null default '',
    created_at timestamptz not null default now()
);
create index if not exists idx_task_comments_task on public.task_comments(task_id);

-- -----------------------------------------------------------------------------
-- 7. Soumissions de code et revues IA
-- -----------------------------------------------------------------------------
create table if not exists public.submissions (
    id uuid primary key default gen_random_uuid(),
    project_id uuid not null references public.projects(id) on delete cascade,
    task_id uuid references public.tasks(id) on delete set null,
    author_id uuid references auth.users(id) on delete set null,
    title text not null default '',
    language text not null default 'typescript',
    code text not null default '',
    notes text not null default '',
    repo_url text not null default '',
    branch text not null default '',
    status text not null default 'pending'
      check (status in ('pending', 'reviewing', 'approved', 'changes_requested', 'rejected')),
    score integer,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists idx_submissions_project on public.submissions(project_id);
create index if not exists idx_submissions_task on public.submissions(task_id);

create table if not exists public.reviews (
    id uuid primary key default gen_random_uuid(),
    submission_id uuid not null references public.submissions(id) on delete cascade,
    reviewer text not null default 'ai' check (reviewer in ('ai', 'human')),
    reviewer_id uuid references auth.users(id) on delete set null,
    verdict text not null default 'changes_requested'
      check (verdict in ('approved', 'changes_requested', 'rejected')),
    score integer not null default 0,
    summary text not null default '',
    criteria jsonb not null default '[]'::jsonb,
    issues jsonb not null default '[]'::jsonb,
    suggestions jsonb not null default '[]'::jsonb,
    model text not null default '',
    created_at timestamptz not null default now()
);
create index if not exists idx_reviews_submission on public.reviews(submission_id);

-- -----------------------------------------------------------------------------
-- 8. Journal d'activité et fil de l'assistant
-- -----------------------------------------------------------------------------
create table if not exists public.activity (
    id uuid primary key default gen_random_uuid(),
    project_id uuid references public.projects(id) on delete cascade,
    task_id uuid references public.tasks(id) on delete set null,
    actor_id uuid references auth.users(id) on delete set null,
    kind text not null default 'note',
    text text not null default '',
    created_at timestamptz not null default now()
);
create index if not exists idx_activity_project on public.activity(project_id, created_at desc);

create table if not exists public.chat_messages (
    id uuid primary key default gen_random_uuid(),
    project_id uuid references public.projects(id) on delete cascade,
    user_id uuid not null references auth.users(id) on delete cascade,
    role text not null check (role in ('user', 'assistant')),
    content text not null default '',
    created_at timestamptz not null default now()
);
create index if not exists idx_chat_user on public.chat_messages(user_id, created_at);

-- Conversations de l'assistant : chaque compte peut ouvrir plusieurs fils par
-- projet, comme dans un chat classique. Les messages y sont rattachés.
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

-- Reprise de l'historique antérieur : un fil unique par compte et par projet.
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

-- -----------------------------------------------------------------------------
-- 9. RLS
-- -----------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.project_members enable row level security;
alter table public.briefs enable row level security;
alter table public.tasks enable row level security;
alter table public.task_comments enable row level security;
alter table public.submissions enable row level security;
alter table public.reviews enable row level security;
alter table public.activity enable row level security;
alter table public.chat_messages enable row level security;
alter table public.chat_sessions enable row level security;

-- Profils : chacun lit l'annuaire de l'équipe (nécessaire pour les assignations),
-- mais ne modifie que sa propre ligne. Le rôle est protégé par un trigger.
drop policy if exists "profiles_read_all" on public.profiles;
create policy "profiles_read_all" on public.profiles
  for select to authenticated using (true);

drop policy if exists "profiles_update_self" on public.profiles;
create policy "profiles_update_self" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create or replace function public.protect_profile_privileges()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- auth.uid() est nul pour la clé service_role : l'administration passe par là.
  if auth.uid() is not null and not public.is_dev_admin() then
    new.role := old.role;
    new.dev_role := old.dev_role;
    new.dev_access := old.dev_access;
    new.active := old.active;
    new.email := old.email;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_protect_privileges on public.profiles;
create trigger profiles_protect_privileges before update on public.profiles
  for each row execute function public.protect_profile_privileges();

drop policy if exists "profiles_admin_all" on public.profiles;
create policy "profiles_admin_all" on public.profiles
  for all to authenticated using (public.is_dev_admin()) with check (public.is_dev_admin());

-- Projets : lecture pour les membres, écriture pour les managers du projet.
drop policy if exists "projects_read" on public.projects;
create policy "projects_read" on public.projects
  for select to authenticated using (public.is_dev_member() and public.can_see_project(id));

drop policy if exists "projects_insert" on public.projects;
create policy "projects_insert" on public.projects
  for insert to authenticated with check (public.is_dev_manager());

drop policy if exists "projects_update" on public.projects;
create policy "projects_update" on public.projects
  for update to authenticated using (public.can_manage_project(id)) with check (public.can_manage_project(id));

drop policy if exists "projects_delete" on public.projects;
create policy "projects_delete" on public.projects
  for delete to authenticated using (public.can_manage_project(id));

drop policy if exists "members_read" on public.project_members;
create policy "members_read" on public.project_members
  for select to authenticated using (public.is_dev_member() and public.can_see_project(project_id));

drop policy if exists "members_write" on public.project_members;
create policy "members_write" on public.project_members
  for all to authenticated using (public.can_manage_project(project_id)) with check (public.can_manage_project(project_id));

-- Briefs : toute l'équipe lit les versions publiées ; le manager écrit.
drop policy if exists "briefs_read" on public.briefs;
create policy "briefs_read" on public.briefs
  for select to authenticated
  using (public.can_see_project(project_id) and (published or public.can_manage_project(project_id)));

drop policy if exists "briefs_write" on public.briefs;
create policy "briefs_write" on public.briefs
  for all to authenticated using (public.can_manage_project(project_id)) with check (public.can_manage_project(project_id));

-- Tâches : lecture pour l'équipe du projet. Un dev peut faire avancer une tâche
-- (le contrôle fin — ne pas se réassigner les tâches d'autrui — est fait côté
-- application ; la RLS garantit le cloisonnement par projet).
drop policy if exists "tasks_read" on public.tasks;
create policy "tasks_read" on public.tasks
  for select to authenticated using (public.can_see_project(project_id));

drop policy if exists "tasks_update" on public.tasks;
create policy "tasks_update" on public.tasks
  for update to authenticated using (public.can_see_project(project_id)) with check (public.can_see_project(project_id));

drop policy if exists "tasks_insert" on public.tasks;
create policy "tasks_insert" on public.tasks
  for insert to authenticated with check (public.can_manage_project(project_id));

drop policy if exists "tasks_delete" on public.tasks;
create policy "tasks_delete" on public.tasks
  for delete to authenticated using (public.can_manage_project(project_id));

drop policy if exists "task_comments_read" on public.task_comments;
create policy "task_comments_read" on public.task_comments
  for select to authenticated
  using (exists (select 1 from public.tasks t where t.id = task_id and public.can_see_project(t.project_id)));

drop policy if exists "task_comments_write" on public.task_comments;
create policy "task_comments_write" on public.task_comments
  for insert to authenticated
  with check (author_id = auth.uid()
    and exists (select 1 from public.tasks t where t.id = task_id and public.can_see_project(t.project_id)));

drop policy if exists "task_comments_delete" on public.task_comments;
create policy "task_comments_delete" on public.task_comments
  for delete to authenticated
  using (author_id = auth.uid()
    or exists (select 1 from public.tasks t where t.id = task_id and public.can_manage_project(t.project_id)));

-- Soumissions : visibles par toute l'équipe du projet, créées par leur auteur.
drop policy if exists "submissions_read" on public.submissions;
create policy "submissions_read" on public.submissions
  for select to authenticated using (public.can_see_project(project_id));

drop policy if exists "submissions_insert" on public.submissions;
create policy "submissions_insert" on public.submissions
  for insert to authenticated with check (author_id = auth.uid() and public.can_see_project(project_id));

drop policy if exists "submissions_update" on public.submissions;
create policy "submissions_update" on public.submissions
  for update to authenticated
  using (author_id = auth.uid() or public.can_manage_project(project_id))
  with check (author_id = auth.uid() or public.can_manage_project(project_id));

drop policy if exists "submissions_delete" on public.submissions;
create policy "submissions_delete" on public.submissions
  for delete to authenticated using (author_id = auth.uid() or public.can_manage_project(project_id));

drop policy if exists "reviews_read" on public.reviews;
create policy "reviews_read" on public.reviews
  for select to authenticated
  using (exists (select 1 from public.submissions s where s.id = submission_id and public.can_see_project(s.project_id)));

-- Les revues IA sont écrites par la fonction serverless (clé service_role) ;
-- une revue humaine peut être ajoutée par un manager du projet.
drop policy if exists "reviews_write" on public.reviews;
create policy "reviews_write" on public.reviews
  for insert to authenticated
  with check (exists (select 1 from public.submissions s where s.id = submission_id and public.can_manage_project(s.project_id)));

drop policy if exists "activity_read" on public.activity;
create policy "activity_read" on public.activity
  for select to authenticated using (project_id is null or public.can_see_project(project_id));

drop policy if exists "activity_write" on public.activity;
create policy "activity_write" on public.activity
  for insert to authenticated with check (public.is_dev_member());

-- Fil de discussion de l'assistant : strictement privé à chaque compte.
drop policy if exists "chat_own" on public.chat_messages;
create policy "chat_own" on public.chat_messages
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "chat_sessions_own" on public.chat_sessions;
create policy "chat_sessions_own" on public.chat_sessions
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- -----------------------------------------------------------------------------
-- 10. Vue d'avancement (utilisée par les tableaux de bord)
-- -----------------------------------------------------------------------------
-- security_invoker : la vue applique la RLS de l'appelant, pas celle de son
-- propriétaire — sans quoi elle exposerait l'avancement de tous les projets.
create or replace view public.project_progress
  with (security_invoker = true) as
  select
    t.project_id,
    count(*)::int as tasks,
    count(*) filter (where t.status = 'done')::int as done,
    count(*) filter (where t.status = 'in_progress')::int as in_progress,
    count(*) filter (where t.status = 'blocked')::int as blocked,
    coalesce(sum(t.estimate), 0)::numeric as estimate,
    max(t.updated_at) as last_update
  from public.tasks t
  group by t.project_id;

grant select on public.project_progress to authenticated;
