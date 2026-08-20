-- =============================================================================
-- NIRA DEV — bucket de stockage des briefs PDF
-- =============================================================================
-- À exécuter une fois dans l'éditeur SQL de Supabase. Idempotent.
--
-- Sans ce bucket, l'application bascule sur un repli : le PDF est encodé en
-- base64 et rangé dans la colonne `projects.brief_pdf_url`. Un brief de 3 Mo
-- devient alors une chaîne de 4 Mo stockée en base, relue à chaque affichage —
-- c'est la principale cause de lenteur sur la vue Brief.
--
-- Avec le bucket, la colonne ne contient plus qu'une URL de quelques dizaines
-- d'octets, et le PDF est servi par le CDN de Supabase, avec cache navigateur.
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('briefs', 'briefs', true, 52428800, array['application/pdf'])
on conflict (id) do update
  set public = true,
      file_size_limit = 52428800,
      allowed_mime_types = array['application/pdf'];

-- Lecture publique : l'URL du PDF est déjà réservée aux membres du projet, qui
-- seuls peuvent lire la ligne `projects` qui la contient.
drop policy if exists "briefs_public_read" on storage.objects;
create policy "briefs_public_read" on storage.objects
  for select using (bucket_id = 'briefs');

-- Dépôt réservé aux comptes connectés ayant accès à Nira Dev.
drop policy if exists "briefs_authenticated_write" on storage.objects;
create policy "briefs_authenticated_write" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'briefs' and public.is_dev_member());

drop policy if exists "briefs_authenticated_update" on storage.objects;
create policy "briefs_authenticated_update" on storage.objects
  for update to authenticated
  using (bucket_id = 'briefs' and public.is_dev_member())
  with check (bucket_id = 'briefs' and public.is_dev_member());

drop policy if exists "briefs_manager_delete" on storage.objects;
create policy "briefs_manager_delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'briefs' and public.is_dev_manager());
