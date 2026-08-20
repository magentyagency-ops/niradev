import type {
  ActivityEntry,
  AppState,
  Brief,
  Profile,
  Project,
  ProjectMember,
  Review,
  Submission,
  Task,
} from './types.js'

type Listener = () => void

const listeners = new Set<Listener>()

export const state: AppState = {
  theme: 'light',
  profile: null,
  people: [],
  projects: [],
  members: [],
  briefs: [],
  tasks: [],
  submissions: [],
  reviews: [],
  activity: [],
  currentProjectId: null,
  assigneeFilter: null,
}

export function subscribe(listener: Listener): void {
  listeners.add(listener)
}

let frame = 0
let suspended = 0

function flush(): void {
  frame = 0
  listeners.forEach((listener) => listener())
}

/**
 * Redessine les vues, au plus une fois par image.
 *
 * Une seule action en déclenche plusieurs d'affilée : un glisser-déposer appelle
 * `upsertTask` en optimiste, puis à la réponse du serveur, puis au journal
 * d'activité. Sans regroupement, le board serait reconstruit trois fois de suite
 * — trois fois tout le HTML et tous les écouteurs, pour un seul geste.
 */
export function notify(): void {
  if (suspended > 0 || frame) return
  frame = requestAnimationFrame(flush)
}

/** Redessine immédiatement, sans attendre l'image suivante. */
export function notifyNow(): void {
  if (frame) cancelAnimationFrame(frame)
  flush()
}

/**
 * Suspend le redessin pendant un geste continu (glisser-déposer, saisie).
 * Reconstruire le DOM sous le curseur arrache l'élément en cours de manipulation.
 */
export function suspendRenders(): void {
  suspended += 1
}

export function resumeRenders(): void {
  suspended = Math.max(0, suspended - 1)
  if (suspended === 0) notify()
}

export function hydrate(next: Omit<AppState, 'currentProjectId' | 'assigneeFilter'>): void {
  Object.assign(state, next)
  // Un projet sélectionné qui a disparu (supprimé, ou droits retirés) laisserait
  // l'application sur une vue vide : on retombe sur le premier projet visible.
  if (!state.projects.some((project) => project.id === state.currentProjectId)) {
    state.currentProjectId = state.projects[0]?.id ?? null
  }
  notify()
}

/* --------------------------------------------------------------- rôles */

export const isAdmin = (): boolean => state.profile?.dev_role === 'admin'

/** Un admin est manager par défaut : il dispose partout des droits managers. */
export const isManager = (): boolean => state.profile?.dev_role === 'admin' || state.profile?.dev_role === 'manager'

/** Droits d'écriture « manager » sur un projet précis. */
export function canManage(projectId: string | null): boolean {
  if (isAdmin()) return true
  if (!isManager() || !projectId) return false
  const project = state.projects.find((item) => item.id === projectId)
  return Boolean(project && (project.manager_id === state.profile?.id || project.created_by === state.profile?.id))
}

/* ------------------------------------------------------------ sélecteurs */

export const currentProject = (): Project | null =>
  state.projects.find((project) => project.id === state.currentProjectId) ?? null

export function setCurrentProject(id: string | null): void {
  state.currentProjectId = id
  notify()
}

export function setAssigneeFilter(id: string | null): void {
  state.assigneeFilter = id
  notify()
}

export const personById = (id: string | null): Profile | undefined =>
  id ? state.people.find((person) => person.id === id) : undefined

export function personName(id: string | null): string {
  if (!id) return 'Non assigné'
  const person = personById(id)
  if (!person) return 'Compte supprimé'
  return person.full_name || person.email.split('@')[0]
}

export const projectById = (id: string | null): Project | undefined =>
  id ? state.projects.find((project) => project.id === id) : undefined

export const taskById = (id: string | null): Task | undefined =>
  id ? state.tasks.find((task) => task.id === id) : undefined

export const projectTasks = (projectId: string | null): Task[] =>
  state.tasks.filter((task) => task.project_id === projectId)

/** Membres d'un projet, manager inclus même s'il n'est pas dans l'équipe. */
export function projectTeam(projectId: string): Profile[] {
  const project = projectById(projectId)
  const ids = new Set(state.members.filter((member) => member.project_id === projectId).map((member) => member.user_id))
  if (project?.manager_id) ids.add(project.manager_id)
  return state.people.filter((person) => ids.has(person.id))
}

/** Dernière version publiée du brief ; le manager voit aussi ses brouillons. */
export function latestBrief(projectId: string | null, includeDrafts = false): Brief | undefined {
  return state.briefs
    .filter((brief) => brief.project_id === projectId && (includeDrafts || brief.published))
    .sort((a, b) => b.version - a.version)[0]
}

export const briefHistory = (projectId: string | null): Brief[] =>
  state.briefs.filter((brief) => brief.project_id === projectId).sort((a, b) => b.version - a.version)

export const submissionReviews = (submissionId: string): Review[] =>
  state.reviews.filter((review) => review.submission_id === submissionId)

export const latestReview = (submissionId: string): Review | undefined =>
  submissionReviews(submissionId).sort((a, b) => b.created_at.localeCompare(a.created_at))[0]

export interface Progress {
  total: number
  done: number
  inProgress: number
  blocked: number
  review: number
  percent: number
}

export function progressOf(projectId: string): Progress {
  const tasks = projectTasks(projectId)
  const done = tasks.filter((task) => task.status === 'done').length
  return {
    total: tasks.length,
    done,
    inProgress: tasks.filter((task) => task.status === 'in_progress').length,
    blocked: tasks.filter((task) => task.status === 'blocked').length,
    review: tasks.filter((task) => task.status === 'review').length,
    percent: tasks.length ? Math.round((done / tasks.length) * 100) : 0,
  }
}

/** Tâches visibles selon le filtre d'assignation actif. */
export const matchesAssignee = (task: Task): boolean =>
  !state.assigneeFilter || task.assignee_id === state.assigneeFilter

/* ------------------------------------------------------ mutations locales */

function upsert<T extends { id: string }>(collection: T[], item: T, prepend = false): T[] {
  const index = collection.findIndex((entry) => entry.id === item.id)
  if (index === -1) return prepend ? [item, ...collection] : [...collection, item]
  const next = [...collection]
  next[index] = item
  return next
}

export function upsertProject(project: Project): void {
  state.projects = upsert(state.projects, project, true)
  notify()
}

export function removeProject(id: string): void {
  state.projects = state.projects.filter((project) => project.id !== id)
  state.tasks = state.tasks.filter((task) => task.project_id !== id)
  state.briefs = state.briefs.filter((brief) => brief.project_id !== id)
  state.submissions = state.submissions.filter((submission) => submission.project_id !== id)
  if (state.currentProjectId === id) state.currentProjectId = state.projects[0]?.id ?? null
  notify()
}

export function upsertTask(task: Task): void {
  state.tasks = upsert(state.tasks, task)
  notify()
}

export function removeTask(id: string): void {
  state.tasks = state.tasks.filter((task) => task.id !== id)
  notify()
}

export function upsertBrief(brief: Brief): void {
  state.briefs = upsert(state.briefs, brief, true)
  notify()
}

export function upsertSubmission(submission: Submission): void {
  state.submissions = upsert(state.submissions, submission, true)
  notify()
}

export function upsertReview(review: Review): void {
  state.reviews = upsert(state.reviews, review, true)
  notify()
}

export function setMembers(members: ProjectMember[]): void {
  state.members = members
  notify()
}

export function pushActivity(entry: ActivityEntry): void {
  state.activity = [entry, ...state.activity].slice(0, 200)
  notify()
}

export function setPeople(people: Profile[]): void {
  state.people = people
  notify()
}
