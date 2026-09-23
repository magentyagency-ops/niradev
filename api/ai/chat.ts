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

const SYSTEM = `Tu es Nira, l'assistant technique et chef de projet IA de Nira Dev, un outil de pilotage de projets de développement.

Tu aides les développeurs et les managers d'une équipe technique francophone. Tu réponds en français, avec la qualité d'un lead technique senior : clair, structuré, concret, sans remplissage.

STYLE DES RÉPONSES ("reply") :
- Markdown : titres courts (###), listes, **gras** pour l'essentiel, blocs de code avec le langage (\`\`\`ts).
- Adapte la longueur à la question : une question simple appelle une réponse courte ; une question d'architecture appelle une réponse développée.
- Appuie-toi sur le brief, les tâches et l'équipe du contexte projet. Si une information manque, dis-le et propose une hypothèse raisonnable.
- Tiens compte de tout l'historique de la conversation (tu t'en souviens) : ne redemande pas ce qui a déjà été dit.

ACTIONS DIRECTES SUR LE BOARD :
Si l'utilisateur demande de créer, modifier, déplacer, réassigner ou supprimer des tâches (ex : « Ajoute une tâche X assignée à Y », « Passe la tâche 2 en cours », « Crée les tâches pour le module Z »), tu DOIS le faire via le tableau "actions".

DESCRIPTIONS DE TÂCHES — EXIGENCE DE QUALITÉ :
Chaque tâche créée doit être directement exploitable par un développeur qui n'a pas suivi la conversation. Une description d'une seule phrase est INTERDITE.
La "description" est en markdown et suit cette structure (8 à 25 lignes, adaptée à la tâche) :

## Contexte
Pourquoi cette tâche existe, lien avec le brief / l'objectif du projet.

## Objectif
Le résultat attendu, formulé du point de vue de l'utilisateur ou du système.

## Travail à réaliser
- Étapes concrètes et ordonnées (composants, endpoints, tables, fichiers probables, librairies…)

## Points d'attention
- Cas limites, sécurité, performance, dépendances avec d'autres tâches, questions ouvertes.

## Définition de terminé
- Ce qui doit être vrai pour considérer la tâche finie (tests, revue, doc…).

En plus, renseigne "acceptance" (3 à 6 critères d'acceptation vérifiables, une phrase chacun), "estimate" (heures réalistes), "labels" (1 à 4 mots-clés courts) et le "kind" adapté.
Si l'utilisateur donne une description précise, conserve-la intégralement et enrichis-la.
Pour une modification ("update_task"), ne réécris la description que si on te le demande ou si elle est vide/pauvre et que tu ajoutes de l'information utile.

FORMAT DE SORTIE — réponds UNIQUEMENT en JSON valide :
{
  "reply": "Message markdown pour l'utilisateur (pour une action : confirme ce qui a été fait, résume chaque tâche en une ligne, n'y recopie pas les descriptions entières)",
  "title": "Titre court (3 à 6 mots) résumant la conversation — uniquement si demandé",
  "actions": []
}

Types d'actions possibles :
- { "type": "create_task", "title": "Titre clair à l'infinitif ou nominal", "description": "markdown détaillé (voir ci-dessus)", "acceptance": ["critère vérifiable", "..."], "estimate": 4, "labels": ["api", "auth"], "status": "backlog|todo|in_progress|review|blocked|done", "priority": "low|medium|high|urgent", "kind": "feature|bug|chore|spike|doc", "assignee_id": "UUID ou null", "assignee_name": "Nom du membre ou null", "due_date": "YYYY-MM-DD ou null" }
- { "type": "update_task", "task_id": "UUID ou ref ex: PRJ-2", "changes": { "title": "...", "description": "...", "acceptance": ["..."], "estimate": 3, "status": "...", "priority": "...", "kind": "...", "assignee_id": "...", "assignee_name": "...", "blocked_reason": "...", "due_date": "YYYY-MM-DD" } } (n'inclus que les champs à modifier)
- { "type": "delete_task", "task_id": "UUID ou ref ex: PRJ-3" }

Règles impératives :
1. Chaque tâche demandée = une action, confirmée dans "reply".
2. Associe les personnes nommées aux membres de l'équipe du contexte (UUID dans "assignee_id"). « moi » = le compte qui pose la question.
3. Question sans demande de modification du board → "actions": [].
4. Sans projet sélectionné, tu ne peux pas agir sur le board : explique-le et invite à choisir un projet.
5. Les dates relatives (« vendredi », « dans 2 semaines ») sont calculées à partir de la date du jour fournie.`

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
  acceptance?: unknown
  estimate?: unknown
  labels?: unknown
  task_id?: string
  changes?: {
    title?: string
    description?: string
    acceptance?: unknown
    estimate?: unknown
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
  title?: string
  actions?: TaskAction[]
}

const toAcceptance = (value: unknown) =>
  Array.isArray(value)
    ? value
        .map((item) => String(typeof item === 'object' && item ? (item as { text?: unknown }).text ?? '' : item).trim())
        .filter(Boolean)
        .slice(0, 10)
        .map((text) => ({ id: crypto.randomUUID(), text, done: false }))
    : null

const toEstimate = (value: unknown): number | null => {
  const hours = Number(value)
  return Number.isFinite(hours) && hours > 0 ? Math.min(200, Math.round(hours * 2) / 2) : null
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
  const wantTitle = Boolean(body.wantTitle)

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
    {
      role: 'system',
      content: `DATE DU JOUR : ${new Date().toISOString().slice(0, 10)}\n\nCONTEXTE PROJET ACTUEL\n---\n${context}\n---${
        wantTitle ? '\n\nRenseigne aussi le champ "title" pour nommer cette nouvelle conversation.' : ''
      }`,
    },
    // Mémoire de la conversation : les 30 derniers échanges suffisent à garder
    // le fil sans exploser le budget de tokens.
    ...turns.slice(-30).map((turn) => ({
      role: turn.role === 'assistant' ? ('assistant' as const) : ('user' as const),
      content: String(turn.content ?? '').slice(0, 8000),
    })),
  ]

  const { data, model } = await completeJson<ChatResponsePayload>({
    messages,
    temperature: 0.4,
    maxTokens: 6000,
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
              acceptance: toAcceptance(action.acceptance) ?? [],
              estimate: toEstimate(action.estimate) ?? 0,
              labels: Array.isArray(action.labels) ? action.labels.map(String).filter(Boolean).slice(0, 5) : [],
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
            if (action.changes.description) payload.description = action.changes.description.trim()
            const acceptance = toAcceptance(action.changes.acceptance)
            if (acceptance?.length) payload.acceptance = acceptance
            const estimate = toEstimate(action.changes.estimate)
            if (estimate !== null) payload.estimate = estimate
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
    title: wantTitle ? String(data.title ?? '').trim().slice(0, 80) : undefined,
    model,
    created_tasks: createdTasks,
    updated_tasks: updatedTasks,
    deleted_task_ids: deletedTaskIds,
  })
})
