import type { VercelRequest, VercelResponse } from '@vercel/node'
import { admin, authorize, handleErrors, HttpError, readBody, type Caller, type DevRole } from '../_lib/supabase.js'

/**
 * Administration des comptes de Nira Dev.
 *
 * Réservé au rôle `admin` : lui seul crée les accès, promeut des managers et
 * révoque des comptes. Un manager gère des projets, pas des comptes.
 */

function requireAdmin(caller: Caller): void {
  if (caller.role !== 'admin') throw new HttpError(403, 'Réservé aux administrateurs.')
}

const asRole = (value: unknown): DevRole =>
  value === 'admin' || value === 'manager' || value === 'dev' ? value : 'dev'

async function listAccounts(): Promise<unknown> {
  const client = admin()
  const [{ data: profiles, error }, { data: tasks }, { data: submissions }, { data: members }] = await Promise.all([
    client.from('profiles').select('*').order('created_at', { ascending: true }),
    client.from('tasks').select('assignee_id, status, updated_at'),
    client.from('submissions').select('author_id, status'),
    client.from('project_members').select('user_id, project_id'),
  ])
  if (error) throw new HttpError(500, error.message)

  interface Stats {
    projects: number
    tasks: number
    done: number
    in_progress: number
    submissions: number
    approved: number
    last_activity: string | null
  }

  const blank = (): Stats => ({
    projects: 0,
    tasks: 0,
    done: 0,
    in_progress: 0,
    submissions: 0,
    approved: 0,
    last_activity: null,
  })

  const stats = new Map<string, Stats>()
  const entry = (id: string | null): Stats => {
    const key = id ?? 'unassigned'
    const existing = stats.get(key) ?? blank()
    stats.set(key, existing)
    return existing
  }

  for (const task of tasks ?? []) {
    const item = entry(task.assignee_id as string | null)
    item.tasks += 1
    if (task.status === 'done') item.done += 1
    if (task.status === 'in_progress') item.in_progress += 1
    const updated = String(task.updated_at ?? '')
    if (!item.last_activity || updated > item.last_activity) item.last_activity = updated
  }

  for (const submission of submissions ?? []) {
    const item = entry(submission.author_id as string | null)
    item.submissions += 1
    if (submission.status === 'approved') item.approved += 1
  }

  for (const member of members ?? []) {
    entry(member.user_id as string).projects += 1
  }

  return {
    accounts: (profiles ?? []).map((profile) => ({
      ...profile,
      skills: Array.isArray(profile.skills) ? profile.skills : [],
      stats: stats.get(profile.id as string) ?? blank(),
    })),
  }
}

async function createAccount(body: Record<string, unknown>): Promise<unknown> {
  const email = String(body.email ?? '')
    .trim()
    .toLowerCase()
  const password = String(body.password ?? '')
  const fullName = String(body.full_name ?? '').trim()
  const jobTitle = String(body.job_title ?? '').trim()
  const devRole = asRole(body.dev_role)

  if (!email.includes('@')) throw new HttpError(400, 'Email invalide.')
  if (password.length < 8) throw new HttpError(400, 'Le mot de passe doit faire au moins 8 caractères.')

  const client = admin()
  const { data, error } = await client.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  })
  if (error || !data.user) throw new HttpError(400, error?.message ?? 'Création impossible.')

  // Le trigger a créé le profil ; on applique ensuite le rôle voulu par l'admin.
  const { data: profile, error: profileError } = await client
    .from('profiles')
    .upsert({
      id: data.user.id,
      email,
      full_name: fullName,
      job_title: jobTitle,
      // `role` reste le rôle du CRM : un manager Nira Dev n'est pas admin du CRM.
      role: devRole === 'admin' ? 'admin' : 'user',
      dev_role: devRole,
      dev_access: true,
      active: true,
    })
    .select()
    .single()
  if (profileError) throw new HttpError(500, profileError.message)

  return { account: profile }
}

async function updateAccount(body: Record<string, unknown>, caller: Caller): Promise<unknown> {
  const id = String(body.id ?? '')
  if (!id) throw new HttpError(400, 'Compte manquant.')

  const client = admin()
  const patch: Record<string, unknown> = {}
  if (typeof body.full_name === 'string') patch.full_name = body.full_name.trim()
  if (typeof body.job_title === 'string') patch.job_title = body.job_title.trim()
  if (typeof body.dev_role === 'string') {
    patch.dev_role = asRole(body.dev_role)
    patch.role = patch.dev_role === 'admin' ? 'admin' : 'user'
  }
  if (typeof body.dev_access === 'boolean') patch.dev_access = body.dev_access
  if (typeof body.active === 'boolean') patch.active = body.active
  if (Array.isArray(body.skills)) patch.skills = body.skills

  // Un admin qui se rétrograde lui-même laisserait potentiellement l'instance
  // sans administrateur : le garde-fou est ici, pas dans l'interface.
  const losingRights = patch.dev_role !== undefined && patch.dev_role !== 'admin'
  if (id === caller.id && (losingRights || patch.active === false || patch.dev_access === false)) {
    throw new HttpError(400, 'Tu ne peux pas retirer tes propres droits administrateur.')
  }

  if (typeof body.password === 'string' && body.password) {
    if (body.password.length < 8) throw new HttpError(400, 'Le mot de passe doit faire au moins 8 caractères.')
    const { error } = await client.auth.admin.updateUserById(id, { password: body.password })
    if (error) throw new HttpError(400, error.message)
  }

  if (Object.keys(patch).length === 0) return { account: null }

  const { data, error } = await client.from('profiles').update(patch).eq('id', id).select().single()
  if (error) throw new HttpError(500, error.message)
  return { account: data }
}

async function deleteAccount(body: Record<string, unknown>, caller: Caller): Promise<unknown> {
  const id = String(body.id ?? '')
  const reassignTo = body.reassignTo ? String(body.reassignTo) : null
  if (!id) throw new HttpError(400, 'Compte manquant.')
  if (id === caller.id) throw new HttpError(400, 'Tu ne peux pas supprimer ton propre compte.')

  const client = admin()
  const target = reassignTo ?? caller.id

  // Rien du travail réalisé ne doit disparaître avec le compte : tâches, projets
  // gérés et livraisons sont transférés avant la suppression.
  await client.from('tasks').update({ assignee_id: target }).eq('assignee_id', id)
  await client.from('projects').update({ manager_id: target }).eq('manager_id', id)
  await client.from('project_members').delete().eq('user_id', id)

  const { error } = await client.auth.admin.deleteUser(id)
  if (error) throw new HttpError(400, error.message)

  return { deleted: id, reassignedTo: target }
}

export default handleErrors(async (request: VercelRequest, response: VercelResponse) => {
  const caller = await authorize(request)
  requireAdmin(caller)
  const body = readBody(request)

  switch (request.method) {
    case 'GET':
      response.status(200).json(await listAccounts())
      return
    case 'POST':
      response.status(201).json(await createAccount(body))
      return
    case 'PATCH':
      response.status(200).json(await updateAccount(body, caller))
      return
    case 'DELETE':
      response.status(200).json(await deleteAccount(body, caller))
      return
    default:
      response.setHeader('Allow', 'GET, POST, PATCH, DELETE')
      response.status(405).json({ error: 'Méthode non autorisée.' })
  }
})
