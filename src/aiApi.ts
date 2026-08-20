import { accessToken } from './auth.js'
import type { Brief, Review, Task } from './types.js'

/**
 * Client des fonctions IA. La clé OpenAI ne vit que côté serveur : le navigateur
 * n'envoie qu'un identifiant de contexte, le serveur reconstitue lui-même le
 * brief et les tâches depuis la base avant d'appeler le modèle.
 */

async function post<T>(path: string, body: unknown): Promise<T> {
  const token = await accessToken()
  const response = await fetch(path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new Error(payload?.error ?? `Requête refusée (${response.status}).`)
  return payload as T
}

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

export const aiApi = {
  /** Assistant conversationnel, ancré sur le brief et les tâches du projet. */
  chat: (input: { projectId: string | null; messages: ChatTurn[] }) =>
    post<{ reply: string; model: string }>('/api/ai/chat', input),

  /** Revue de code : confronte le code livré au brief et aux critères de la tâche. */
  review: (input: { submissionId: string }) => post<{ review: Review }>('/api/ai/review', input),

  /** Structure un brief brut en sections exploitables. */
  draftBrief: (input: { projectId: string; raw: string }) =>
    post<{ brief: Partial<Brief> }>('/api/ai/brief', input),

  structureBrief: (input: { projectId: string; raw: string }) =>
    post<{ brief: Partial<Brief> }>('/api/ai/brief', input),

  /** Propose un découpage en tâches à partir du brief publié. */
  planTasks: (input: { projectId: string; count?: number }) =>
    post<{ tasks: Partial<Task>[] }>('/api/ai/plan', input),

  /** Résumé d'avancement type « daily », pour le tableau de bord. */
  standup: (input: { projectId: string | null }) => post<{ summary: string }>('/api/ai/standup', input),
}
