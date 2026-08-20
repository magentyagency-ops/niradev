import { accessToken } from './auth.js'
import type { DevRole, Profile } from './types.js'

/**
 * Client de la fonction serverless `/api/admin/users`.
 * Toutes ces opérations sont refusées côté serveur si l'appelant n'est pas admin.
 */

async function request<T>(method: string, body?: unknown): Promise<T> {
  const token = await accessToken()
  const response = await fetch('/api/admin/users', {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new Error(payload?.error ?? `Requête refusée (${response.status}).`)
  return payload as T
}

export interface AccountStats {
  projects: number
  tasks: number
  done: number
  in_progress: number
  submissions: number
  approved: number
  last_activity: string | null
}

export interface Account extends Profile {
  stats: AccountStats
}

export const adminApi = {
  list: () => request<{ accounts: Account[] }>('GET'),

  create: (input: { email: string; password: string; full_name: string; dev_role: DevRole; job_title?: string }) =>
    request<{ account: Account }>('POST', input),

  update: (input: {
    id: string
    full_name?: string
    job_title?: string
    dev_role?: DevRole
    dev_access?: boolean
    active?: boolean
    password?: string
  }) => request<{ account: Profile | null }>('PATCH', input),

  remove: (input: { id: string; reassignTo?: string }) =>
    request<{ deleted: string; reassignedTo: string }>('DELETE', input),
}
