import type { VercelRequest, VercelResponse } from '@vercel/node'
import { loadProjectContext } from '../_lib/context.js'
import { completeJson, type Message } from '../_lib/openai.js'
import { admin, authorize, handleErrors, HttpError, readBody, requireProjectAccess } from '../_lib/supabase.js'

/**
 * Assistant technique et chef de projet IA.
 *
 * Capable de répondre aux questions sur le brief ET d'agir directement sur le board
 * (création de tâches, modification de statut/priorité/assignation, suppression).
 */

const SYSTEM = `Tu es l'assistant technique intelligent et chef de projet IA de Nira Dev, un outil de pilotage de projets de développement.

Tu aides les développeurs et les managers d'une équipe technique francophone. Tu réponds en français, de façon directe, précise et concrète.

ACTIONS DIRECTES SUR LE BOARD :
Si l'utilisateur te demande de créer, modifier, déplacer, réassigner ou supprimer des tâches ou cartes sur le board (ex : « Ajoute une tâche X assignée à Y », « Passe la tâche 2 en cours », « Crée 3 tâches pour le module Z »), tu PEUX et DOIS le faire directement via le tableau "actions" de ta réponse JSON.

Tu dois TOUJOURS répondre UNIQUEMENT au format JSON avec cette structure exacte :
{
  "reply": "Ton message d'explication ou de confirmation en markdown direct pour l'utilisateur...",
  "actions": [
    // Liste d'actions à exécuter (laisse vide [] si l'utilisateur pose juste une question sans demander d'action sur le board) :
    //
    // Action 1 : Créer une tâche
    // {
    //   "type": "create_task",
    //   "title": "Titre clair et concis",
    //   "description": "Description technique optionnelle",
    //   "status": "todo" | "in_progress" | "review" | "blocked" | "done" | "backlog",
    //   "priority": "low" | "medium" | "high" | "urgent",
    //   "kind": "feature" | "bug" | "chore" | "spike" | "doc",
    //   "assignee_id": "UUID du membre ou null",
    //   "assignee_name": "Nom ou prénom du membre assigné",
    //   "due_date": "YYYY-MM-DD" ou null
    // }
    //
    // Action 2 : Mettre à jour une tâche
    // {
    //   "type": "update_task",
    //   "task_id": "UUID de la tâche ou ref ex: PRJ-2",
    //   "changes": {
    //     "title": "Nouveau titre",
    //     "status": "todo" | "in_progress" | "review" | "blocked" | "done",
    //     "priority": "low" | "medium" | "high" | "urgent",
    //     "assignee_id": "UUID ou null",
    //     "assignee_name": "Nom du membre",
    //     "blocked_reason": "Raison si blocked",
    //     "due_date": "YYYY-MM-DD"
    //   }
    // }
    //
    // Action 3 : Supprimer une tâche
    // {
    //   "type": "delete_task",
    //   "task_id": "UUID de la tâche ou ref ex: PRJ-3"
    // }
  ]
}

Règles impératives :
1. Pour chaque tâche que l'utilisateur demande de créer ou modifier, produis l'action correspondante et confirme-la dans le texte "reply".
2. Fais correspondre les noms des personnes avec la liste de l'équipe fournie dans le contexte (utilise leur UUID dans "assignee_id" si disponible).
3. Si l'utilisateur pose une question sans demander de modification du board, "actions" doit être [].
4. Reste concis, précis et professionnel. Pas de bavardage inutile.`

interface TaskAction {
  type: 'create_task' | 'update_task' | 'delete_task'
  title?: string
  description?: string
  status?: string
  priority?: string
  kind?: string
  assignee_id?: string | null
  assignee_name?: string
  due_date?: string | null
  task_id?: string
  changes?: {
    title?: string
    status?: string
    priority?: string
    kind?: string
    assignee_id?: string | null
    assignee_name?: string
    blocked_reason?: string
    due_date?: string | null
  }
}

interface ChatResponsePayload {
  reply: string
  actions?: TaskAction[]
}

export default handleErrors(async (request: VercelRequest, response: VercelResponse) => {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST')
    response.status(405).json({ error: 'Méthode non autorisée.' })
    return
  }

  const caller = await authorize(request)
  const body = readBody(request)
  const projectId = body.projectId ? String(body.projectId) : null
  const turns = Array.isArray(body.messages) ? (body.messages as { role: string; content: string }[]) : []

  if (!turns.length) throw new HttpError(400, 'Aucun message à traiter.')

  const client = admin()
  let context = "Aucun projet sélectionné : réponds de façon générale, en t'appuyant sur ton expertise technique."
  let projectContext: Awaited<ReturnType<typeof loadProjectContext>> | null = null

  if (projectId) {
    await requireProjectAccess(client, caller, projectId)
    projectContext = await loadProjectContext(client, projectId, caller)
    context = projectContext.text
  }

  const messages: Message[] = [
    { role: 'system', content: SYSTEM },
    { role: 'system', content: `CONTEXTE PROJET ACTUEL\n---\n${context}\n---` },
    ...turns.slice(-12).map((turn) => ({
      role: turn.role === 'assistant' ? ('assistant' as const) : ('user' as const),
      content: String(turn.content ?? '').slice(0, 6000),
    })),
  ]

  const { data, model } = await completeJson<ChatResponsePayload>({
    messages,
    temperature: 0.35,
    maxTokens: 2200,
  })

  const reply = String(data.reply ?? '').trim()
  const rawActions = Array.isArray(data.actions) ? data.actions : []

  const createdTasks: Record<string, unknown>[] = []
  const updatedTasks: Record<string, unknown>[] = []
  const deletedTaskIds: string[] = []

  // Exécution des actions sur le board si un projet est actif
  if (projectId && rawActions.length > 0) {
    const existingTasks = projectContext?.tasks ?? []
    const teamMembers = projectContext?.team ?? []

    // Helper pour trouver l'ID d'un membre à partir de son nom / email / id
    const matchMemberId = (nameOrId?: string | null): string | null => {
      if (!nameOrId) return null
      const clean = nameOrId.toLowerCase().trim()
      const exact = teamMembers.find(
        (m) =>
          String(m.id).toLowerCase() === clean ||
          String(m.email).toLowerCase() === clean ||
          String(m.full_name).toLowerCase() === clean,
      )
      if (exact) return String(exact.id)

      const partial = teamMembers.find(
        (m) =>
          String(m.full_name || '').toLowerCase().includes(clean) ||
          clean.includes(String(m.full_name || '').toLowerCase()) ||
          String(m.email || '').toLowerCase().includes(clean),
      )
      return partial ? String(partial.id) : null
    }

    // Helper pour trouver une tâche par son ID, code/seq (ex: PRJ-2 ou 2) ou titre
    const findTask = (refOrId?: string): Record<string, unknown> | undefined => {
      if (!refOrId) return undefined
      const clean = refOrId.toLowerCase().trim()
      return existingTasks.find((t) => {
        const idMatch = String(t.id).toLowerCase() === clean
        const seqMatch = clean.endsWith(`-${t.seq}`) || clean === String(t.seq)
        const titleMatch = String(t.title).toLowerCase().includes(clean)
        return idMatch || seqMatch || titleMatch
      })
    }

    for (const action of rawActions) {
      try {
        if (action.type === 'create_task' && action.title?.trim()) {
          const assigneeId =
            matchMemberId(action.assignee_id) || matchMemberId(action.assignee_name) || null
          const validStatuses = ['backlog', 'todo', 'in_progress', 'review', 'blocked', 'done']
          const validPriorities = ['low', 'medium', 'high', 'urgent']
          const validKinds = ['feature', 'bug', 'chore', 'spike', 'doc']

          const status = validStatuses.includes(action.status ?? '') ? action.status : 'todo'
          const priority = validPriorities.includes(action.priority ?? '') ? action.priority : 'medium'
          const kind = validKinds.includes(action.kind ?? '') ? action.kind : 'feature'

          const { data: created, error } = await client
            .from('tasks')
            .insert({
              project_id: projectId,
              title: action.title.trim(),
              description: action.description?.trim() || '',
              status,
              priority,
              kind,
              assignee_id: assigneeId,
              reporter_id: caller.id,
              due_date: action.due_date || null,
              order_index: Date.now(),
            })
            .select()
            .single()

          if (!error && created) {
            createdTasks.push(created)
            await client.from('activity').insert({
              project_id: projectId,
              kind: 'task',
              text: `Tâche créée par l'assistant : ${created.title}.`,
            })
          }
        } else if (action.type === 'update_task') {
          const target = findTask(action.task_id)
          if (target && action.changes) {
            const payload: Record<string, unknown> = { updated_at: new Date().toISOString() }
            if (action.changes.title) payload.title = action.changes.title.trim()
            if (action.changes.status) {
              payload.status = action.changes.status
              payload.done_at = action.changes.status === 'done' ? new Date().toISOString() : null
            }
            if (action.changes.priority) payload.priority = action.changes.priority
            if (action.changes.kind) payload.kind = action.changes.kind
            if (action.changes.blocked_reason !== undefined) {
              payload.blocked_reason = action.changes.blocked_reason
            }
            if (action.changes.due_date !== undefined) payload.due_date = action.changes.due_date || null
            if (action.changes.assignee_id !== undefined || action.changes.assignee_name !== undefined) {
              payload.assignee_id =
                matchMemberId(action.changes.assignee_id) ||
                matchMemberId(action.changes.assignee_name) ||
                null
            }

            const { data: updated, error } = await client
              .from('tasks')
              .update(payload)
              .eq('id', target.id)
              .select()
              .single()

            if (!error && updated) {
              updatedTasks.push(updated)
              await client.from('activity').insert({
                project_id: projectId,
                kind: 'task',
                text: `Tâche mise à jour par l'assistant : ${updated.title}.`,
              })
            }
          }
        } else if (action.type === 'delete_task') {
          const target = findTask(action.task_id)
          if (target) {
            const { error } = await client.from('tasks').delete().eq('id', target.id)
            if (!error) {
              deletedTaskIds.push(String(target.id))
              await client.from('activity').insert({
                project_id: projectId,
                kind: 'task',
                text: `Tâche supprimée par l'assistant : ${target.title}.`,
              })
            }
          }
        }
      } catch (actionErr) {
        console.warn('[nira-dev] Échec de l\'action board IA', actionErr)
      }
    }
  }

  response.status(200).json({
    reply,
    model,
    created_tasks: createdTasks,
    updated_tasks: updatedTasks,
    deleted_task_ids: deletedTaskIds,
  })
})
