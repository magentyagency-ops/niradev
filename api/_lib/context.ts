import type { SupabaseClient } from '@supabase/supabase-js'
import type { Caller } from './supabase.js'

/**
 * Reconstitution serveur du contexte projet transmis au modèle.
 *
 * Le navigateur n'envoie qu'un identifiant de projet : c'est le serveur qui relit
 * le brief et les tâches, après avoir vérifié les droits de l'appelant. Un compte
 * ne peut donc pas se faire résumer un projet auquel il n'a pas accès.
 */

export interface ProjectContext {
  project: Record<string, unknown> | null
  brief: Record<string, unknown> | null
  tasks: Record<string, unknown>[]
  team: Record<string, unknown>[]
  text: string
}

const clip = (value: unknown, max = 1500): string => {
  const text = String(value ?? '').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export function briefToText(brief: Record<string, unknown> | null): string {
  if (!brief) return 'Aucun brief publié pour ce projet.'
  const criteria = Array.isArray(brief.acceptance)
    ? (brief.acceptance as { text: string }[]).map((item, index) => `  ${index + 1}. ${item.text}`).join('\n')
    : ''
  return [
    `BRIEF v${brief.version} — ${brief.title}`,
    `Contexte : ${clip(brief.context)}`,
    `Objectifs : ${clip(brief.objectives)}`,
    `Périmètre : ${clip(brief.scope)}`,
    `Hors périmètre : ${clip(brief.out_of_scope)}`,
    `Contraintes : ${clip(brief.constraints)}`,
    `Notes techniques : ${clip(brief.tech_notes)}`,
    `Livrables attendus : ${clip(brief.deliverables)}`,
    criteria ? `Critères d'acceptation du projet :\n${criteria}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

export async function loadProjectContext(
  client: SupabaseClient,
  projectId: string,
  caller: Caller,
): Promise<ProjectContext> {
  const [{ data: project }, { data: briefs }, { data: tasks }, { data: members }] = await Promise.all([
    client.from('projects').select('*').eq('id', projectId).maybeSingle(),
    client
      .from('briefs')
      .select('*')
      .eq('project_id', projectId)
      .eq('published', true)
      .order('version', { ascending: false })
      .limit(1),
    client.from('tasks').select('*').eq('project_id', projectId).order('order_index'),
    client.from('project_members').select('user_id, role_in_project').eq('project_id', projectId),
  ])

  const brief = briefs?.[0] ?? null
  const memberIds = (members ?? []).map((member) => member.user_id as string)
  const { data: people } = memberIds.length
    ? await client.from('profiles').select('id, full_name, email, job_title').in('id', memberIds)
    : { data: [] as Record<string, unknown>[] }

  const nameOf = (id: string | null): string => {
    const person = (people ?? []).find((entry) => entry.id === id)
    return (person?.full_name as string) || (person?.email as string) || 'non assigné'
  }

  const taskLines = (tasks ?? [])
    .map(
      (task) =>
        `- [${project?.code ?? 'PRJ'}-${task.seq}] ${task.title} · statut ${task.status} · priorité ${task.priority} · ${nameOf(task.assignee_id as string)}${
          task.blocked_reason ? ` · bloqué : ${task.blocked_reason}` : ''
        }`,
    )
    .join('\n')

  const teamLines = (people ?? [])
    .map((person) => {
      const membership = (members ?? []).find((member) => member.user_id === person.id)
      return `- ${person.full_name || person.email}${person.job_title ? ` (${person.job_title})` : ''} — ${membership?.role_in_project ?? 'dev'}`
    })
    .join('\n')

  const text = [
    `PROJET : ${project?.name ?? '—'} (${project?.code ?? '—'})${project?.client ? ` pour ${project.client}` : ''}`,
    `Statut : ${project?.status ?? '—'}${project?.due_date ? ` · échéance ${project.due_date}` : ''}`,
    project?.summary ? `Résumé : ${clip(project.summary, 600)}` : '',
    Array.isArray(project?.stack) && project.stack.length ? `Stack : ${(project.stack as string[]).join(', ')}` : '',
    '',
    briefToText(brief),
    '',
    teamLines ? `ÉQUIPE :\n${teamLines}` : '',
    '',
    taskLines ? `TÂCHES (${(tasks ?? []).length}) :\n${taskLines}` : 'Aucune tâche créée.',
    '',
    `Compte qui pose la question : ${caller.full_name || caller.email} (rôle ${caller.role}).`,
  ]
    .filter((line) => line !== null && line !== undefined)
    .join('\n')

  return {
    project: project ?? null,
    brief,
    tasks: (tasks ?? []) as Record<string, unknown>[],
    team: (people ?? []) as Record<string, unknown>[],
    text,
  }
}
