import { normalize } from './auth.js'
import { supabase } from './supabase.js'
import type {
  ActivityEntry,
  AppState,
  Brief,
  ChatMessage,
  ChatMessageMeta,
  ChatSession,
  Profile,
  Project,
  ProjectMember,
  Review,
  Submission,
  Task,
  TaskComment,
  Theme,
} from './types.js'

const now = (): string => new Date().toISOString()

async function currentUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getSession()
  return data.session?.user.id ?? null
}

function fail(context: string, error: { message: string } | null): void {
  if (!error) return
  console.error(`[nira-dev] ${context}`, error)
  throw new Error(`${context} : ${error.message}`)
}

/**
 * Colonnes chargées pour les listes.
 *
 * Deux colonnes pèsent lourd et ne servent jamais à l'affichage d'une liste :
 * `projects.brief_pdf_url` (le PDF en base64 quand le bucket Storage manque) et
 * `submissions.code` (des fichiers entiers). Elles sont lues à la demande, à
 * l'ouverture du document ou de la fiche.
 */
const PROJECT_COLUMNS =
  'id,name,code,client,summary,status,color,repo_url,stack,start_date,due_date,manager_id,created_by,created_at,updated_at,brief_pdf_name,brief_pdf_size'

const SUBMISSION_COLUMNS =
  'id,project_id,task_id,author_id,title,language,notes,repo_url,branch,status,score,created_at,updated_at'

const asArray = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : [])

const asTask = (row: Record<string, unknown>): Task => ({
  ...(row as unknown as Task),
  estimate: Number(row.estimate) || 0,
  spent: Number(row.spent) || 0,
  labels: asArray<string>(row.labels),
  acceptance: asArray(row.acceptance),
})

const asBrief = (row: Record<string, unknown>): Brief => ({
  ...(row as unknown as Brief),
  acceptance: asArray(row.acceptance),
})

const asProject = (row: Record<string, unknown>): Project => ({
  ...(row as unknown as Project),
  stack: asArray<string>(row.stack),
  // `undefined` = colonne non chargée (liste), `null` = aucun PDF attaché.
  // La distinction évite de redemander l'URL pour un projet qui n'en a pas.
  brief_pdf_url: 'brief_pdf_url' in row ? (row.brief_pdf_url as string) || null : undefined,
  brief_pdf_name: (row.brief_pdf_name as string) || null,
  brief_pdf_size: row.brief_pdf_size ? Number(row.brief_pdf_size) : null,
})

const asReview = (row: Record<string, unknown>): Review => ({
  ...(row as unknown as Review),
  criteria: asArray(row.criteria),
  issues: asArray(row.issues),
  suggestions: asArray<string>(row.suggestions),
})

export const api = {
  /**
   * Upload d'un PDF de brief : tente d'abord le bucket Supabase Storage `briefs`.
   * En cas d'indisponibilité du bucket, bascule automatiquement sur un encodage Data URL.
   */
  async uploadBriefPdf(file: File): Promise<{ url: string; name: string; size: number }> {
    const cleanName = file.name.replace(/[^a-zA-Z0-9.-]/g, '_')
    const path = `briefs/${Date.now()}_${cleanName}`
    try {
      const { data, error } = await supabase.storage.from('briefs').upload(path, file, {
        cacheControl: '3600',
        upsert: true,
      })
      if (!error && data) {
        const { data: pub } = supabase.storage.from('briefs').getPublicUrl(data.path)
        if (pub?.publicUrl) {
          return { url: pub.publicUrl, name: file.name, size: file.size }
        }
      }
      if (error) {
        console.warn(
          "[nira-dev] bucket Storage « briefs » indisponible : le PDF va être stocké en base64 dans la table projects, ce qui alourdit fortement le chargement. Exécute supabase/storage-briefs.sql pour créer le bucket.",
          error,
        )
      }
    } catch (e) {
      console.warn('[nira-dev] upload storage Supabase non disponible, repli local base64', e)
    }

    // Repli Data URL fiable en tout environnement
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        resolve({
          url: String(reader.result),
          name: file.name,
          size: file.size,
        })
      }
      reader.onerror = () => reject(new Error('Lecture du fichier PDF impossible.'))
      reader.readAsDataURL(file)
    })
  },

  /**
   * Charge tout ce que la RLS autorise pour le compte connecté : un développeur
   * ne reçoit que les projets dont il est membre, un admin les reçoit tous.
   */
  async loadState(): Promise<Omit<AppState, 'currentProjectId' | 'assigneeFilter'>> {
    const [peopleRes, projectsRes, membersRes, briefsRes, tasksRes, submissionsRes, reviewsRes, activityRes] =
      await Promise.all([
        supabase.from('profiles').select('*').order('created_at', { ascending: true }),
        // `brief_pdf_url` est volontairement exclu : quand le bucket Storage n'est
        // pas disponible, il contient le PDF entier encodé en base64. Le charger
        // ici, c'est télécharger plusieurs Mo par projet à chaque démarrage. Le
        // nom et la taille suffisent à savoir qu'un PDF existe ; l'URL est lue à
        // la demande par `loadProjectPdf`, au moment de l'afficher.
        supabase
          .from('projects')
          .select(PROJECT_COLUMNS)
          .order('created_at', { ascending: false }),
        supabase.from('project_members').select('*'),
        supabase.from('briefs').select('*').order('version', { ascending: false }),
        supabase.from('tasks').select('*').order('order_index', { ascending: true }),
        supabase.from('submissions').select(SUBMISSION_COLUMNS).order('created_at', { ascending: false }),
        supabase.from('reviews').select('*').order('created_at', { ascending: false }),
        supabase.from('activity').select('*').order('created_at', { ascending: false }).limit(200),
      ])

    fail('Chargement des projets', projectsRes.error)
    fail('Chargement des tâches', tasksRes.error)

    const userId = await currentUserId()
    const people = (peopleRes.data ?? []).map((row) => normalize(row)).filter((person) => person.active)
    const profile = people.find((person) => person.id === userId) ?? null

    return {
      theme: profile?.theme ?? 'light',
      profile,
      people,
      projects: (projectsRes.data ?? []).map(asProject),
      members: (membersRes.data ?? []) as ProjectMember[],
      briefs: (briefsRes.data ?? []).map(asBrief),
      tasks: (tasksRes.data ?? []).map(asTask),
      submissions: (submissionsRes.data ?? []) as Submission[],
      reviews: (reviewsRes.data ?? []).map(asReview),
      activity: (activityRes.data ?? []) as ActivityEntry[],
    }
  },

  async saveTheme(theme: Theme): Promise<void> {
    const userId = await currentUserId()
    if (!userId) return
    const { error } = await supabase.from('profiles').update({ theme }).eq('id', userId)
    if (error) console.warn('[nira-dev] thème non enregistré', error)
  },

  async updateOwnProfile(input: { full_name?: string; job_title?: string; skills?: string[] }): Promise<Profile> {
    const userId = await currentUserId()
    if (!userId) throw new Error('Session expirée.')
    const { data, error } = await supabase.from('profiles').update(input).eq('id', userId).select().single()
    fail('Mise à jour du profil', error)
    return normalize(data as Record<string, unknown>)
  },

  /* ------------------------------------------------------------- projets */

  async createProject(input: Partial<Project>): Promise<Project> {
    const userId = await currentUserId()
    const payload = {
      name: input.name?.trim() || 'Nouveau projet',
      code: (input.code?.trim() || input.name?.slice(0, 4) || 'PRJ').toUpperCase(),
      client: input.client?.trim() ?? '',
      summary: input.summary?.trim() ?? '',
      status: input.status ?? 'active',
      color: input.color ?? 'violet',
      repo_url: input.repo_url?.trim() ?? '',
      stack: input.stack ?? [],
      start_date: input.start_date || null,
      due_date: input.due_date || null,
      brief_pdf_url: input.brief_pdf_url || null,
      brief_pdf_name: input.brief_pdf_name || null,
      brief_pdf_size: input.brief_pdf_size || null,
      // Le créateur est manager du projet par défaut : sans cela il perdrait
      // immédiatement le droit de le modifier.
      manager_id: input.manager_id ?? userId,
      created_by: userId,
    }
    let { data, error } = await supabase.from('projects').insert(payload).select().single()
    if (error && error.message.toLowerCase().includes('schema cache')) {
      console.warn('[nira-dev] Colonnes brief_pdf non encore créées dans Supabase, repli sans PDF', error)
      const fallbackPayload = { ...payload }
      delete (fallbackPayload as any).brief_pdf_url
      delete (fallbackPayload as any).brief_pdf_name
      delete (fallbackPayload as any).brief_pdf_size
      const retry = await supabase.from('projects').insert(fallbackPayload).select().single()
      data = retry.data
      error = retry.error
    }
    fail('Création du projet', error)
    return asProject(data as Record<string, unknown>)
  },

  async updateProject(id: string, input: Partial<Project>): Promise<Project> {
    const payload: Record<string, unknown> = { ...input, updated_at: now() }
    delete payload.id
    delete payload.created_at
    delete payload.created_by
    let { data, error } = await supabase.from('projects').update(payload).eq('id', id).select().single()
    if (error && error.message.toLowerCase().includes('schema cache')) {
      console.warn('[nira-dev] Colonnes brief_pdf non encore créées dans Supabase, repli sans PDF', error)
      const fallbackPayload = { ...payload }
      delete fallbackPayload.brief_pdf_url
      delete fallbackPayload.brief_pdf_name
      delete fallbackPayload.brief_pdf_size
      const retry = await supabase.from('projects').update(fallbackPayload).eq('id', id).select().single()
      data = retry.data
      error = retry.error
    }
    fail('Mise à jour du projet', error)
    return asProject(data as Record<string, unknown>)
  },

  /** URL du PDF de brief, lue à la demande (voir PROJECT_COLUMNS). */
  async loadProjectPdf(projectId: string): Promise<string | null> {
    const { data, error } = await supabase
      .from('projects')
      .select('brief_pdf_url')
      .eq('id', projectId)
      .maybeSingle()
    if (error) {
      console.warn('[nira-dev] PDF du brief illisible', error)
      return null
    }
    return (data?.brief_pdf_url as string) || null
  },

  async deleteProject(id: string): Promise<void> {
    const { error } = await supabase.from('projects').delete().eq('id', id)
    fail('Suppression du projet', error)
  },

  async setProjectTeam(projectId: string, entries: { user_id: string; role_in_project: string }[]): Promise<ProjectMember[]> {
    // Remplacement complet de l'équipe : plus simple et plus sûr qu'un diff, la
    // table ne porte aucune donnée métier propre.
    const { error: deleteError } = await supabase.from('project_members').delete().eq('project_id', projectId)
    fail("Mise à jour de l'équipe", deleteError)

    if (!entries.length) return []
    const { data, error } = await supabase
      .from('project_members')
      .insert(entries.map((entry) => ({ ...entry, project_id: projectId })))
      .select()
    fail("Mise à jour de l'équipe", error)
    return (data ?? []) as ProjectMember[]
  },

  async loadMembers(): Promise<ProjectMember[]> {
    const { data, error } = await supabase.from('project_members').select('*')
    fail("Chargement des équipes", error)
    return (data ?? []) as ProjectMember[]
  },

  /* -------------------------------------------------------------- briefs */

  async saveBrief(input: Partial<Brief> & { project_id: string }, publish: boolean): Promise<Brief> {
    const userId = await currentUserId()
    const base = {
      project_id: input.project_id,
      title: input.title?.trim() || 'Brief projet',
      context: input.context ?? '',
      objectives: input.objectives ?? '',
      scope: input.scope ?? '',
      out_of_scope: input.out_of_scope ?? '',
      constraints: input.constraints ?? '',
      tech_notes: input.tech_notes ?? '',
      deliverables: input.deliverables ?? '',
      acceptance: input.acceptance ?? [],
      published: publish,
      author_id: userId,
      updated_at: now(),
    }

    // Un brief déjà publié n'est jamais réécrit : l'équipe doit pouvoir se référer
    // à la version sur laquelle elle a commencé à travailler. On crée une version.
    if (input.id && !input.published) {
      const { data, error } = await supabase.from('briefs').update(base).eq('id', input.id).select().single()
      fail('Enregistrement du brief', error)
      return asBrief(data as Record<string, unknown>)
    }

    const { data: previous } = await supabase
      .from('briefs')
      .select('version')
      .eq('project_id', input.project_id)
      .order('version', { ascending: false })
      .limit(1)

    const version = ((previous?.[0]?.version as number) ?? 0) + 1
    const { data, error } = await supabase
      .from('briefs')
      .insert({ ...base, version })
      .select()
      .single()
    fail('Enregistrement du brief', error)
    return asBrief(data as Record<string, unknown>)
  },

  /* -------------------------------------------------------------- tâches */

  async createTask(input: Partial<Task> & { project_id: string }): Promise<Task> {
    const userId = await currentUserId()
    const payload = {
      project_id: input.project_id,
      title: input.title?.trim() || 'Nouvelle tâche',
      description: input.description ?? '',
      status: input.status ?? 'todo',
      priority: input.priority ?? 'medium',
      kind: input.kind ?? 'feature',
      assignee_id: input.assignee_id || null,
      reporter_id: userId,
      estimate: Number(input.estimate) || 0,
      due_date: input.due_date || null,
      labels: input.labels ?? [],
      acceptance: input.acceptance ?? [],
      order_index: input.order_index ?? Date.now(),
    }
    const { data, error } = await supabase.from('tasks').insert(payload).select().single()
    fail('Création de la tâche', error)
    return asTask(data as Record<string, unknown>)
  },

  async updateTask(id: string, input: Partial<Task>): Promise<Task> {
    const payload: Record<string, unknown> = { ...input, updated_at: now() }
    delete payload.id
    delete payload.created_at
    delete payload.seq
    delete payload.project_id
    if (input.status) payload.done_at = input.status === 'done' ? now() : null
    if ('estimate' in input) payload.estimate = Number(input.estimate) || 0
    if ('spent' in input) payload.spent = Number(input.spent) || 0
    if ('due_date' in input) payload.due_date = input.due_date || null
    if ('assignee_id' in input) payload.assignee_id = input.assignee_id || null

    const { data, error } = await supabase.from('tasks').update(payload).eq('id', id).select().single()
    fail('Mise à jour de la tâche', error)
    return asTask(data as Record<string, unknown>)
  },

  async deleteTask(id: string): Promise<void> {
    const { error } = await supabase.from('tasks').delete().eq('id', id)
    fail('Suppression de la tâche', error)
  },

  async loadComments(taskId: string): Promise<TaskComment[]> {
    const { data, error } = await supabase
      .from('task_comments')
      .select('*')
      .eq('task_id', taskId)
      .order('created_at', { ascending: true })
    fail('Chargement des commentaires', error)
    return (data ?? []) as TaskComment[]
  },

  async addComment(taskId: string, body: string): Promise<TaskComment> {
    const userId = await currentUserId()
    const { data, error } = await supabase
      .from('task_comments')
      .insert({ task_id: taskId, author_id: userId, body })
      .select()
      .single()
    fail('Ajout du commentaire', error)
    return data as TaskComment
  },

  /* --------------------------------------------------------- soumissions */

  async createSubmission(input: Partial<Submission> & { project_id: string }): Promise<Submission> {
    const userId = await currentUserId()
    const payload = {
      project_id: input.project_id,
      task_id: input.task_id || null,
      author_id: userId,
      title: input.title?.trim() || 'Livraison',
      language: input.language ?? 'typescript',
      code: input.code ?? '',
      notes: input.notes ?? '',
      repo_url: input.repo_url ?? '',
      branch: input.branch ?? '',
      status: 'pending' as const,
    }
    const { data, error } = await supabase.from('submissions').insert(payload).select().single()
    fail('Envoi du code', error)
    return data as Submission
  },

  async updateSubmission(id: string, input: Partial<Submission>): Promise<Submission> {
    const payload: Record<string, unknown> = { ...input, updated_at: now() }
    delete payload.id
    delete payload.created_at
    const { data, error } = await supabase.from('submissions').update(payload).eq('id', id).select().single()
    fail('Mise à jour de la livraison', error)
    return data as Submission
  },

  /** Relecture unitaire, après qu'une fonction serverless a modifié la ligne. */
  async getSubmission(id: string): Promise<Submission | null> {
    const { data, error } = await supabase.from('submissions').select('*').eq('id', id).maybeSingle()
    if (error) console.warn('[nira-dev] livraison illisible', error)
    return (data as Submission) ?? null
  },

  async getTask(id: string): Promise<Task | null> {
    const { data, error } = await supabase.from('tasks').select('*').eq('id', id).maybeSingle()
    if (error) console.warn('[nira-dev] tâche illisible', error)
    return data ? asTask(data as Record<string, unknown>) : null
  },

  async deleteSubmission(id: string): Promise<void> {
    const { error } = await supabase.from('submissions').delete().eq('id', id)
    fail('Suppression de la livraison', error)
  },

  /* ------------------------------------------------------------ activité */

  async logActivity(entry: {
    project_id: string | null
    task_id?: string | null
    kind: string
    text: string
  }): Promise<ActivityEntry | null> {
    const userId = await currentUserId()
    const { data, error } = await supabase
      .from('activity')
      .insert({ ...entry, task_id: entry.task_id ?? null, actor_id: userId })
      .select()
      .single()
    // Le journal est un confort : son échec ne doit jamais interrompre l'action.
    if (error) {
      console.warn('[nira-dev] activité non journalisée', error)
      return null
    }
    return data as ActivityEntry
  },

  /* ------------------------------------------------------------ assistant */

  async listChatSessions(projectId: string | null): Promise<ChatSession[]> {
    const query = supabase.from('chat_sessions').select('*').order('updated_at', { ascending: false }).limit(200)
    const { data, error } = projectId ? await query.eq('project_id', projectId) : await query.is('project_id', null)
    fail('Chargement des conversations', error)
    return (data ?? []) as ChatSession[]
  },

  async createChatSession(projectId: string | null, title = 'Nouvelle conversation'): Promise<ChatSession> {
    const userId = await currentUserId()
    if (!userId) throw new Error('Session expirée.')
    const { data, error } = await supabase
      .from('chat_sessions')
      .insert({ project_id: projectId, user_id: userId, title })
      .select()
      .single()
    fail('Création de la conversation', error)
    return data as ChatSession
  },

  async updateChatSession(id: string, changes: Partial<Pick<ChatSession, 'title'>>): Promise<ChatSession> {
    const { data, error } = await supabase
      .from('chat_sessions')
      .update({ ...changes, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
    fail('Mise à jour de la conversation', error)
    return data as ChatSession
  },

  async deleteChatSession(id: string): Promise<void> {
    const { error } = await supabase.from('chat_sessions').delete().eq('id', id)
    fail('Suppression de la conversation', error)
  },

  async loadChat(sessionId: string): Promise<ChatMessage[]> {
    const { data, error } = await supabase
      .from('chat_messages')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true })
      .limit(500)
    fail("Chargement de l'historique", error)
    return (data ?? []) as ChatMessage[]
  },

  async deleteChatMessage(id: string): Promise<void> {
    const { error } = await supabase.from('chat_messages').delete().eq('id', id)
    fail('Suppression du message', error)
  },

  async saveChatMessage(
    session: ChatSession,
    role: 'user' | 'assistant',
    content: string,
    meta: ChatMessageMeta = {},
  ): Promise<ChatMessage> {
    const userId = await currentUserId()
    if (!userId) throw new Error('Session expirée.')
    const { data, error } = await supabase
      .from('chat_messages')
      .insert({ project_id: session.project_id, session_id: session.id, user_id: userId, role, content, meta })
      .select()
      .single()
    fail('Enregistrement du message', error)
    // La conversation remonte en tête de liste, comme dans un chat classique.
    void supabase.from('chat_sessions').update({ updated_at: new Date().toISOString() }).eq('id', session.id).then(() => undefined)
    return data as ChatMessage
  },
}
