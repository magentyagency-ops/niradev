import type { VercelRequest, VercelResponse } from '@vercel/node'
import { loadProjectContext } from '../_lib/context.js'
import { completeJson } from '../_lib/openai.js'
import {
  admin,
  authorize,
  handleErrors,
  HttpError,
  isManager,
  readBody,
  requireProjectAccess,
} from '../_lib/supabase.js'

/**
 * Découpage du brief en tâches.
 *
 * La proposition n'est jamais écrite directement en base : elle revient au
 * manager, qui coche celles qu'il garde. C'est lui qui décide du plan de charge.
 */

const SYSTEM = `Tu es lead technique dans une agence de développement francophone.

À partir d'un brief projet, tu proposes un découpage en tâches de développement prêtes à être assignées.

Règles :
- Une tâche = un livrable vérifiable par une seule personne, entre 2 et 16 heures de travail.
- Couvre tout le périmètre du brief, y compris la mise en place technique, les tests et la recette. Ignore ce qui est hors périmètre.
- Ne redonne pas de tâche qui figure déjà dans la liste des tâches existantes.
- Chaque tâche porte des critères d'acceptation vérifiables : ce sont eux qui serviront à valider le code livré.
- Ordonne les tâches par dépendance : ce qui débloque le reste d'abord.

Réponds UNIQUEMENT en JSON :
{
  "tasks": [
    {
      "title": "verbe à l'infinitif + objet, court",
      "description": "ce qu'il faut faire, en 1 à 3 phrases",
      "kind": "feature" | "bug" | "chore" | "spike" | "doc",
      "priority": "low" | "medium" | "high" | "urgent",
      "estimate": nombre d'heures,
      "labels": ["mot-clé"],
      "acceptance": ["critère vérifiable", "..."]
    }
  ]
}`

const KINDS = ['feature', 'bug', 'chore', 'spike', 'doc']
const PRIORITIES = ['low', 'medium', 'high', 'urgent']

export default handleErrors(async (request: VercelRequest, response: VercelResponse) => {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST')
    response.status(405).json({ error: 'Méthode non autorisée.' })
    return
  }

  const caller = await authorize(request)
  if (!isManager(caller)) throw new HttpError(403, 'Seul un manager de projet peut générer un plan de tâches.')

  const body = readBody(request)
  const projectId = String(body.projectId ?? '')
  const count = Math.max(3, Math.min(20, Number(body.count) || 10))
  if (!projectId) throw new HttpError(400, 'Projet manquant.')

  const client = admin()
  await requireProjectAccess(client, caller, projectId)
  const context = await loadProjectContext(client, projectId, caller)

  if (!context.brief) throw new HttpError(400, "Publie d'abord un brief : c'est lui qui sert de base au découpage.")

  const { data, model } = await completeJson<{ tasks?: Record<string, unknown>[] }>({
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `${context.text}\n\nPropose au maximum ${count} tâches.` },
    ],
    temperature: 0.4,
    maxTokens: 3000,
  })

  const tasks = (data.tasks ?? []).slice(0, count).map((task) => ({
    title: String(task.title ?? 'Tâche'),
    description: String(task.description ?? ''),
    kind: KINDS.includes(String(task.kind)) ? String(task.kind) : 'feature',
    priority: PRIORITIES.includes(String(task.priority)) ? String(task.priority) : 'medium',
    estimate: Math.max(0, Math.min(80, Number(task.estimate) || 0)),
    labels: Array.isArray(task.labels) ? (task.labels as unknown[]).map(String).slice(0, 5) : [],
    acceptance: Array.isArray(task.acceptance)
      ? (task.acceptance as unknown[]).map((text) => ({ id: crypto.randomUUID(), text: String(text), done: false }))
      : [],
  }))

  response.status(200).json({ tasks, model })
})
