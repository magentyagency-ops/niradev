import { HttpError } from './supabase.js'

/**
 * Appel minimal de l'API OpenAI (Chat Completions).
 *
 * Aucune dépendance : un `fetch` suffit, et le déploiement serverless reste léger.
 * La clé n'est lue que depuis l'environnement serveur — jamais préfixée `VITE_`,
 * donc jamais embarquée dans le bundle du navigateur.
 */

const API_URL = 'https://api.openai.com/v1/chat/completions'

const apiKey = (): string => {
  const key = (process.env.OPENAI_API_KEY ?? '').trim().replace(/^['"]|['"]$/g, '')
  if (!key) {
    throw new HttpError(
      503,
      "Fonctionnalités IA indisponibles : la variable d'environnement OPENAI_API_KEY n'est pas définie.",
    )
  }
  return key
}

const primaryModel = (): string => (process.env.OPENAI_MODEL ?? 'gpt-4o').trim().replace(/^['"]|['"]$/g, '') || 'gpt-4o'

/** Modèle de repli si celui demandé n'est pas accessible avec cette clé. */
const FALLBACK_MODEL = 'gpt-4o-mini'

export interface Message {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface CompleteOptions {
  messages: Message[]
  /** Force une réponse JSON valide (mode `json_object` d'OpenAI). */
  json?: boolean
  temperature?: number
  maxTokens?: number
}

export interface Completion {
  text: string
  model: string
}

async function call(model: string, options: CompleteOptions): Promise<Response> {
  return fetch(API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: options.messages,
      temperature: options.temperature ?? 0.3,
      max_tokens: options.maxTokens ?? 2000,
      ...(options.json ? { response_format: { type: 'json_object' } } : {}),
    }),
  })
}

export async function complete(options: CompleteOptions): Promise<Completion> {
  let model = primaryModel()
  let response = await call(model, options)

  // Une clé peut ne pas donner accès au modèle configuré : on retente une fois
  // avec un modèle largement disponible plutôt que de renvoyer une erreur.
  if (response.status === 404 && model !== FALLBACK_MODEL) {
    model = FALLBACK_MODEL
    response = await call(model, options)
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    let message = detail.slice(0, 300)
    try {
      message = JSON.parse(detail)?.error?.message ?? message
    } catch {
      /* la réponse d'erreur n'est pas toujours du JSON */
    }
    if (response.status === 401) throw new HttpError(503, 'Clé OpenAI refusée. Vérifie OPENAI_API_KEY.')
    if (response.status === 429) throw new HttpError(429, 'Quota OpenAI atteint, réessaie dans un instant.')
    throw new HttpError(502, `Appel IA en échec (${response.status}) : ${message}`)
  }

  const payload = (await response.json()) as { choices?: { message?: { content?: string } }[] }
  const text = payload.choices?.[0]?.message?.content?.trim() ?? ''
  if (!text) throw new HttpError(502, "L'IA n'a renvoyé aucun contenu.")
  return { text, model }
}

/** Complétion contrainte à du JSON, déjà analysée. */
export async function completeJson<T>(options: CompleteOptions): Promise<{ data: T; model: string }> {
  const { text, model } = await complete({ ...options, json: true })
  try {
    return { data: JSON.parse(text) as T, model }
  } catch {
    throw new HttpError(502, "Réponse IA illisible (JSON invalide).")
  }
}
