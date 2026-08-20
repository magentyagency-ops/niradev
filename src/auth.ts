import { supabase } from './supabase.js'
import type { Profile } from './types.js'

/**
 * Session et profil du compte connecté.
 *
 * Le cloisonnement réel est assuré par la RLS Supabase : le rôle lu ici ne sert
 * qu'à afficher ou masquer les commandes réservées aux managers et aux admins.
 */

export async function currentProfile(): Promise<Profile | null> {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession()
  if (sessionError) throw new Error(`Session illisible : ${sessionError.message}`)
  const user = sessionData.session?.user
  if (!user) return null

  const { data, error } = await supabase.from('profiles').select('*').eq('id', user.id).maybeSingle()
  if (error) throw new Error(`Profil illisible (${error.code ?? 'erreur'}) : ${error.message}`)

  if (!data) {
    throw new Error(
      `Aucun profil n'est associé à ${user.email}. Exécute supabase/schema.sql dans l'éditeur SQL de Supabase.`,
    )
  }
  if (!data.active || !data.dev_access) {
    throw new Error("Ce compte n'a pas accès à Nira Dev. Contacte un administrateur.")
  }
  return normalize(data)
}

export function normalize(row: Record<string, unknown>): Profile {
  return {
    ...(row as unknown as Profile),
    skills: Array.isArray(row.skills) ? (row.skills as string[]) : [],
    dev_role: (row.dev_role as Profile['dev_role']) ?? 'dev',
    job_title: (row.job_title as string) ?? '',
  }
}

export async function signIn(email: string, password: string): Promise<void> {
  const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
  if (error) {
    throw new Error(error.message === 'Invalid login credentials' ? 'Email ou mot de passe incorrect.' : error.message)
  }
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut()
}

export async function sendPasswordReset(email: string): Promise<void> {
  const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: window.location.origin })
  if (error) throw new Error(error.message)
}

export async function updateOwnPassword(password: string): Promise<void> {
  const { error } = await supabase.auth.updateUser({ password })
  if (error) throw new Error(error.message)
}

/** Jeton d'accès transmis aux fonctions serverless (`/api/...`). */
export async function accessToken(): Promise<string> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new Error('Session expirée, reconnecte-toi.')
  return token
}

export function onAuthChange(listener: () => void): void {
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT' || event === 'SIGNED_IN') listener()
  })
}
