import type { VercelRequest, VercelResponse } from '@vercel/node'
import { briefToText } from '../_lib/context.js'
import { completeJson } from '../_lib/openai.js'
import { admin, authorize, handleErrors, HttpError, readBody, requireProjectAccess } from '../_lib/supabase.js'

/**
 * Revue de code automatique d'une livraison.
 *
 * Le code soumis est confronté au brief du projet ET aux critères d'acceptation
 * de la tâche : la question posée au modèle n'est pas « ce code est-il bon ? »
 * mais « fait-il ce que le brief demandait, de la manière demandée ? ».
 */

const SYSTEM = `Tu es relecteur technique senior dans une agence de développement francophone.

On te donne : le brief d'un projet, la tâche livrée avec ses critères d'acceptation, et le code produit par le développeur.

Ta mission : déterminer si la fonctionnalité est réalisée conformément à ce qui était demandé.

Méthode :
1. Reprends CHAQUE critère d'acceptation (ceux de la tâche, puis ceux du brief qui concernent cette tâche) et détermine s'il est rempli par le code fourni. Cite l'élément du code qui le prouve, ou explique précisément ce qui manque.
2. Relève les défauts réels : écart au brief, bug, faille de sécurité, cas limite non traité, non-respect des contraintes techniques imposées. Classe-les en critical / major / minor. N'invente pas de défaut pour remplir la liste.
3. Ne reproche pas l'absence de code que le développeur n'avait pas à livrer pour cette tâche, ni ce qui est explicitement hors périmètre.
4. Le verdict découle des critères : "approved" si tous les critères essentiels sont remplis et qu'il n'y a aucun défaut critique ; "changes_requested" s'il manque peu de chose ; "rejected" si la fonctionnalité livrée ne correspond pas à la demande.

Réponds UNIQUEMENT en JSON, en français, avec cette forme exacte :
{
  "verdict": "approved" | "changes_requested" | "rejected",
  "score": 0-100,
  "summary": "2 à 4 phrases : ce qui est livré, et ce qui bloque ou non la validation",
  "criteria": [{ "criterion": "texte du critère", "met": true|false, "comment": "preuve dans le code ou manque constaté" }],
  "issues": [{ "severity": "critical"|"major"|"minor", "title": "court", "detail": "explication et correction attendue", "location": "fichier/fonction/ligne approximative" }],
  "suggestions": ["amélioration facultative, non bloquante"]
}`

interface AiReview {
  verdict?: string
  score?: number
  summary?: string
  criteria?: { criterion?: string; met?: boolean; comment?: string }[]
  issues?: { severity?: string; title?: string; detail?: string; location?: string }[]
  suggestions?: string[]
}

const VERDICTS = ['approved', 'changes_requested', 'rejected'] as const
const SEVERITIES = ['critical', 'major', 'minor'] as const

/** 120 000 caractères ≈ 30 k tokens : au-delà, la revue coûte plus qu'elle ne rapporte. */
const MAX_CODE = 120_000

export default handleErrors(async (request: VercelRequest, response: VercelResponse) => {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST')
    response.status(405).json({ error: 'Méthode non autorisée.' })
    return
  }

  const caller = await authorize(request)
  const submissionId = String(readBody(request).submissionId ?? '')
  if (!submissionId) throw new HttpError(400, 'Livraison manquante.')

  const client = admin()
  const { data: submission } = await client.from('submissions').select('*').eq('id', submissionId).maybeSingle()
  if (!submission) throw new HttpError(404, 'Livraison introuvable.')

  const project = await requireProjectAccess(client, caller, submission.project_id as string)

  const [{ data: briefs }, { data: task }] = await Promise.all([
    client
      .from('briefs')
      .select('*')
      .eq('project_id', submission.project_id)
      .eq('published', true)
      .order('version', { ascending: false })
      .limit(1),
    submission.task_id
      ? client.from('tasks').select('*').eq('id', submission.task_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  const code = String(submission.code ?? '').trim()
  if (!code) throw new HttpError(400, 'Aucun code à analyser dans cette livraison.')

  const taskCriteria = Array.isArray(task?.acceptance)
    ? (task.acceptance as { text: string }[]).map((item, index) => `  ${index + 1}. ${item.text}`).join('\n')
    : ''

  const taskBlock = task
    ? [
        `TÂCHE : [${project.code}-${task.seq}] ${task.title}`,
        `Type : ${task.kind} · priorité ${task.priority}`,
        `Description : ${task.description || '(aucune)'}`,
        taskCriteria ? `Critères d'acceptation de la tâche :\n${taskCriteria}` : "Aucun critère d'acceptation spécifique à la tâche : appuie-toi sur le brief.",
      ].join('\n')
    : "Cette livraison n'est rattachée à aucune tâche : évalue-la au regard du brief seul."

  const prompt = [
    `PROJET : ${project.name} (${project.code})`,
    Array.isArray(project.stack) && project.stack.length
      ? `Stack imposée : ${(project.stack as string[]).join(', ')}`
      : '',
    '',
    briefToText(briefs?.[0] ?? null),
    '',
    taskBlock,
    '',
    `LIVRAISON : ${submission.title}`,
    submission.notes ? `Note du développeur : ${submission.notes}` : '',
    submission.branch ? `Branche : ${submission.branch}` : '',
    '',
    `CODE LIVRÉ (${submission.language}) :`,
    '```' + String(submission.language ?? ''),
    code.slice(0, MAX_CODE),
    '```',
    code.length > MAX_CODE ? '(code tronqué : seule la partie ci-dessus a été analysée)' : '',
  ]
    .filter(Boolean)
    .join('\n')

  await client.from('submissions').update({ status: 'reviewing' }).eq('id', submissionId)

  let result: AiReview
  let model: string
  try {
    const completion = await completeJson<AiReview>({
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: prompt },
      ],
      temperature: 0.15,
      maxTokens: 2600,
    })
    result = completion.data
    model = completion.model
  } catch (error) {
    // Sans ce filet, une livraison resterait bloquée en « analyse en cours ».
    await client.from('submissions').update({ status: 'pending' }).eq('id', submissionId)
    throw error
  }

  const verdict = (VERDICTS as readonly string[]).includes(String(result.verdict))
    ? (result.verdict as string)
    : 'changes_requested'
  const score = Math.max(0, Math.min(100, Math.round(Number(result.score) || 0)))

  const { data: review, error: reviewError } = await client
    .from('reviews')
    .insert({
      submission_id: submissionId,
      reviewer: 'ai',
      reviewer_id: caller.id,
      verdict,
      score,
      summary: String(result.summary ?? '').slice(0, 4000),
      criteria: (result.criteria ?? []).map((item) => ({
        criterion: String(item.criterion ?? ''),
        met: Boolean(item.met),
        comment: String(item.comment ?? ''),
      })),
      issues: (result.issues ?? []).map((item) => ({
        severity: (SEVERITIES as readonly string[]).includes(String(item.severity))
          ? String(item.severity)
          : 'minor',
        title: String(item.title ?? ''),
        detail: String(item.detail ?? ''),
        location: String(item.location ?? ''),
      })),
      suggestions: (result.suggestions ?? []).map((item) => String(item)),
      model,
    })
    .select()
    .single()
  if (reviewError) throw new HttpError(500, reviewError.message)

  await client
    .from('submissions')
    .update({ status: verdict, score, updated_at: new Date().toISOString() })
    .eq('id', submissionId)

  // Une tâche validée passe en « terminé » ; une tâche recalée revient au
  // développeur plutôt que de rester en attente de relecture.
  if (task) {
    const nextStatus = verdict === 'approved' ? 'done' : 'in_progress'
    await client
      .from('tasks')
      .update({
        status: nextStatus,
        done_at: nextStatus === 'done' ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', task.id)
  }

  await client.from('activity').insert({
    project_id: submission.project_id,
    task_id: submission.task_id,
    actor_id: caller.id,
    kind: 'review',
    text: `Revue IA de « ${submission.title} » : ${verdict} (${score}/100).`,
  })

  response.status(200).json({ review })
})
