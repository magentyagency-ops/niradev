import type { VercelRequest, VercelResponse } from '@vercel/node'
import { loadProjectContext } from '../_lib/context.js'
import { complete, type Message } from '../_lib/openai.js'
import { admin, authorize, handleErrors, HttpError, readBody, requireProjectAccess } from '../_lib/supabase.js'

/**
 * Assistant de l'équipe technique.
 *
 * Il répond en s'appuyant sur le brief et les tâches réelles du projet : le
 * contexte est relu côté serveur après vérification des droits, jamais fourni
 * par le navigateur — sans quoi n'importe qui pourrait faire résumer un projet
 * auquel il n'a pas accès.
 */

const SYSTEM = `Tu es l'assistant technique de Nira Dev, un outil de pilotage de projets de développement.

Tu aides les développeurs et les managers d'une équipe technique francophone. Tu réponds en français, de façon directe et concrète.

Règles :
- Appuie-toi en priorité sur le CONTEXTE PROJET fourni (brief, tâches, équipe). Cite les tâches par leur identifiant (ex : NIRA-12) quand c'est utile.
- Si l'information demandée n'est pas dans le brief, dis-le clairement et propose la question à poser au manager de projet, plutôt que d'inventer une exigence.
- Pour les questions techniques générales (langage, framework, erreur), réponds normalement avec ton expertise, en tenant compte de la stack du projet.
- Donne du code en blocs markdown avec le langage indiqué.
- Va à l'essentiel : pas de préambule, pas de reformulation de la question.`

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

  if (projectId) {
    await requireProjectAccess(client, caller, projectId)
    context = (await loadProjectContext(client, projectId, caller)).text
  }

  const messages: Message[] = [
    { role: 'system', content: SYSTEM },
    { role: 'system', content: `CONTEXTE PROJET\n---\n${context}\n---` },
    // Les 12 derniers tours suffisent à tenir une conversation et gardent le
    // coût par requête stable, même sur un fil très long.
    ...turns.slice(-12).map((turn) => ({
      role: turn.role === 'assistant' ? ('assistant' as const) : ('user' as const),
      content: String(turn.content ?? '').slice(0, 6000),
    })),
  ]

  const { text, model } = await complete({ messages, temperature: 0.4, maxTokens: 1400 })
  response.status(200).json({ reply: text, model })
})
