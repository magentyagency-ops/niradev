import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { VercelRequest, VercelResponse } from '@vercel/node'

/**
 * Socle commun des fonctions serverless.
 *
 * C'est le SEUL endroit qui manipule la clé `service_role` : elle ne doit jamais
 * être exposée au navigateur. Chaque appel est authentifié avec le jeton du
 * compte appelant, puis autorisé en relisant son rôle en base.
 */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export const admin = (): SupabaseClient => {
  const supabaseUrl = (process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '').trim().replace(/^['"]|['"]$/g, '')
  const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim().replace(/^['"]|['"]$/g, '')

  if (!supabaseUrl || !serviceRoleKey) {
    throw new HttpError(
      500,
      "Configuration serveur incomplète : SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY doivent être définis dans les variables d'environnement Vercel.",
    )
  }
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

export type DevRole = 'admin' | 'manager' | 'dev'

export interface Caller {
  id: string
  email: string
  role: DevRole
  full_name: string
}

export async function authorize(request: VercelRequest): Promise<Caller> {
  const header = request.headers.authorization ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!token) throw new HttpError(401, 'Jeton manquant.')

  const client = admin()
  const { data, error } = await client.auth.getUser(token)
  if (error || !data.user) throw new HttpError(401, 'Session invalide.')

  const { data: profile } = await client
    .from('profiles')
    .select('dev_role, active, dev_access, full_name')
    .eq('id', data.user.id)
    .single()

  if (!profile?.active || !profile?.dev_access) throw new HttpError(403, "Ce compte n'a pas accès à Nira Dev.")

  return {
    id: data.user.id,
    email: data.user.email ?? '',
    role: (profile.dev_role as DevRole) ?? 'dev',
    full_name: (profile.full_name as string) ?? '',
  }
}

export const isManager = (caller: Caller): boolean => caller.role === 'admin' || caller.role === 'manager'

/** Vérifie que l'appelant a le droit de lire un projet, et le renvoie. */
export async function requireProjectAccess(
  client: SupabaseClient,
  caller: Caller,
  projectId: string,
): Promise<Record<string, unknown>> {
  const { data: project } = await client.from('projects').select('*').eq('id', projectId).maybeSingle()
  if (!project) throw new HttpError(404, 'Projet introuvable.')
  if (caller.role === 'admin') return project

  if (project.manager_id === caller.id || project.created_by === caller.id) return project

  const { data: membership } = await client
    .from('project_members')
    .select('user_id')
    .eq('project_id', projectId)
    .eq('user_id', caller.id)
    .maybeSingle()

  if (!membership) throw new HttpError(403, "Ce projet n'est pas accessible avec ce compte.")
  return project
}

export function readBody(request: VercelRequest): Record<string, unknown> {
  if (typeof request.body === 'string') {
    try {
      return JSON.parse(request.body || '{}')
    } catch {
      throw new HttpError(400, 'Corps de requête illisible.')
    }
  }
  return (request.body as Record<string, unknown>) ?? {}
}

/** Enveloppe commune : traduit les HttpError en réponses propres. */
export function handleErrors(
  handler: (request: VercelRequest, response: VercelResponse) => Promise<void>,
): (request: VercelRequest, response: VercelResponse) => Promise<void> {
  return async (request, response) => {
    try {
      await handler(request, response)
    } catch (error) {
      if (error instanceof HttpError) {
        response.status(error.status).json({ error: error.message })
        return
      }
      console.error('[nira-dev/api]', error)
      response.status(500).json({ error: (error as Error).message || 'Erreur serveur.' })
    }
  }
}
