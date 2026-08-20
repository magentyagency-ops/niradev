import type { VercelRequest, VercelResponse } from '@vercel/node'
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
 * Mise en forme d'un brief.
 *
 * Le manager écrit ce qu'il a — un mail client, des notes de réunion — et le
 * modèle le range dans les sections attendues. Rien n'est publié ici : le
 * résultat revient dans le formulaire, que le manager relit et corrige.
 */

const SYSTEM = `Tu es chef de projet technique dans une agence de développement francophone.

On te donne des notes brutes (mail client, compte-rendu de réunion, cahier des charges informel) et tu les transformes en brief structuré, exploitable par une équipe de développeurs.

Règles :
- N'invente aucune exigence fonctionnelle absente des notes. Si une information manque, écris-le explicitement dans la section concernée (ex : « À confirmer avec le client : … »).
- Les critères d'acceptation doivent être vérifiables : une phrase = un comportement observable et testable.
- Rédige en français, au présent, en phrases courtes. Pas de remplissage marketing.

Réponds UNIQUEMENT en JSON avec cette forme exacte :
{
  "title": "titre court du brief",
  "context": "pourquoi ce projet existe, qui est le client, quel problème est résolu",
  "objectives": "objectifs mesurables, en liste à puces markdown",
  "scope": "ce qui est à réaliser, en liste à puces markdown",
  "out_of_scope": "ce qui n'est explicitement pas à faire",
  "constraints": "contraintes de délai, de budget, réglementaires, d'accessibilité",
  "tech_notes": "stack, intégrations, contraintes d'architecture, environnements",
  "deliverables": "ce que l'équipe doit livrer concrètement",
  "acceptance": ["critère d'acceptation vérifiable", "..."]
}`

export default handleErrors(async (request: VercelRequest, response: VercelResponse) => {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST')
    response.status(405).json({ error: 'Méthode non autorisée.' })
    return
  }

  const caller = await authorize(request)
  if (!isManager(caller)) throw new HttpError(403, 'Seul un manager de projet peut rédiger un brief.')

  const body = readBody(request)
  const projectId = String(body.projectId ?? '')
  const raw = String(body.raw ?? '').trim()
  if (!projectId) throw new HttpError(400, 'Projet manquant.')
  if (raw.length < 30) throw new HttpError(400, 'Donne un peu plus de matière : au moins quelques phrases.')

  const client = admin()
  const project = await requireProjectAccess(client, caller, projectId)

  const { data, model } = await completeJson<Record<string, unknown>>({
    messages: [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: [
          `PROJET : ${project.name} (${project.code})${project.client ? ` — client : ${project.client}` : ''}`,
          Array.isArray(project.stack) && project.stack.length
            ? `Stack pressentie : ${(project.stack as string[]).join(', ')}`
            : '',
          project.due_date ? `Échéance : ${project.due_date}` : '',
          '',
          'NOTES BRUTES :',
          raw.slice(0, 20_000),
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
    temperature: 0.35,
    maxTokens: 2400,
  })

  const acceptance = Array.isArray(data.acceptance)
    ? (data.acceptance as unknown[]).map((text) => ({ id: crypto.randomUUID(), text: String(text), done: false }))
    : []

  response.status(200).json({
    brief: {
      title: String(data.title ?? project.name),
      context: String(data.context ?? ''),
      objectives: String(data.objectives ?? ''),
      scope: String(data.scope ?? ''),
      out_of_scope: String(data.out_of_scope ?? ''),
      constraints: String(data.constraints ?? ''),
      tech_notes: String(data.tech_notes ?? ''),
      deliverables: String(data.deliverables ?? ''),
      acceptance,
    },
    model,
  })
})
