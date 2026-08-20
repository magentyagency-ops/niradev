import type { VercelRequest, VercelResponse } from '@vercel/node'
import { loadProjectContext } from '../_lib/context.js'
import { complete } from '../_lib/openai.js'
import { admin, authorize, handleErrors, readBody, requireProjectAccess } from '../_lib/supabase.js'

/**
 * Point d'avancement affiché en haut du tableau de bord.
 *
 * L'idée n'est pas de paraphraser les compteurs déjà visibles à l'écran, mais de
 * signaler ce qui mérite une décision : blocages, retards, tâches sans titulaire.
 */

const SYSTEM = `Tu es chef de projet technique. Tu rédiges un point d'avancement en français, en 3 à 5 phrases, à lire en dix secondes.

Règles :
- Commence par l'état général, puis ce qui mérite une action aujourd'hui.
- Nomme les tâches bloquées, en retard, ou sans assigné, avec leur identifiant.
- Ne répète pas des chiffres bruts déjà affichés ailleurs, interprète-les.
- Si tout est sous contrôle, dis-le sobrement en une phrase, sans inventer d'alerte.
- Pas de titre, pas de liste à puces, pas de formule de politesse : du texte courant.`

export default handleErrors(async (request: VercelRequest, response: VercelResponse) => {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST')
    response.status(405).json({ error: 'Méthode non autorisée.' })
    return
  }

  const caller = await authorize(request)
  const projectId = readBody(request).projectId ? String(readBody(request).projectId) : null
  const client = admin()

  let context: string
  if (projectId) {
    await requireProjectAccess(client, caller, projectId)
    context = (await loadProjectContext(client, projectId, caller)).text
  } else {
    // Vue « tous projets » : on résume l'ensemble de ce que le compte peut voir.
    const { data: projects } = await client.from('projects').select('*').neq('status', 'archived')
    const visible = (projects ?? []).filter(
      (project) => caller.role === 'admin' || project.manager_id === caller.id || project.created_by === caller.id,
    )
    const parts = await Promise.all(
      visible.slice(0, 5).map(async (project) => (await loadProjectContext(client, project.id, caller)).text),
    )
    context = parts.join('\n\n=====\n\n') || 'Aucun projet accessible.'
  }

  const today = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })
  const { text } = await complete({
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Nous sommes ${today}.\n\n${context}` },
    ],
    temperature: 0.35,
    maxTokens: 400,
  })

  response.status(200).json({ summary: text })
})
