export type Theme = 'light' | 'midnight' | 'ocean' | 'sunset'

/** Rôle applicatif de Nira Dev. Un admin est manager par défaut. */
export type DevRole = 'admin' | 'manager' | 'dev'

export type ProjectStatus = 'draft' | 'active' | 'paused' | 'shipped' | 'archived'
export type TaskStatus = 'backlog' | 'todo' | 'in_progress' | 'review' | 'blocked' | 'done'
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent'
export type TaskKind = 'feature' | 'bug' | 'chore' | 'spike' | 'doc'
export type MemberRole = 'lead' | 'dev' | 'qa' | 'design'
export type SubmissionStatus = 'pending' | 'reviewing' | 'approved' | 'changes_requested' | 'rejected'
export type Verdict = 'approved' | 'changes_requested' | 'rejected'

export interface Profile {
  id: string
  email: string
  full_name: string
  /** Rôle hérité du CRM ; conservé pour la compatibilité du même projet Supabase. */
  role: 'admin' | 'user'
  dev_role: DevRole
  dev_access: boolean
  job_title: string
  skills: string[]
  active: boolean
  theme: Theme
  created_at: string
}

export interface ProjectMember {
  project_id: string
  user_id: string
  role_in_project: MemberRole
  added_at: string
}

export interface Project {
  id: string
  name: string
  code: string
  client: string
  summary: string
  status: ProjectStatus
  color: string
  repo_url: string
  stack: string[]
  start_date: string | null
  due_date: string | null
  manager_id: string | null
  created_by: string | null
  brief_pdf_url?: string | null
  brief_pdf_name?: string | null
  brief_pdf_size?: number | null
  created_at: string
  updated_at: string
}

export interface AcceptanceCriterion {
  id: string
  text: string
  /** Coché par le manager en revue de recette, ou par la revue IA. */
  done?: boolean
}

export interface Brief {
  id: string
  project_id: string
  version: number
  title: string
  context: string
  objectives: string
  scope: string
  out_of_scope: string
  constraints: string
  tech_notes: string
  deliverables: string
  acceptance: AcceptanceCriterion[]
  published: boolean
  author_id: string | null
  created_at: string
  updated_at: string
}

export interface Task {
  id: string
  project_id: string
  seq: number
  title: string
  description: string
  status: TaskStatus
  priority: TaskPriority
  kind: TaskKind
  assignee_id: string | null
  reporter_id: string | null
  estimate: number
  spent: number
  due_date: string | null
  labels: string[]
  acceptance: AcceptanceCriterion[]
  order_index: number
  blocked_reason: string
  created_at: string
  updated_at: string
  done_at: string | null
}

export interface TaskComment {
  id: string
  task_id: string
  author_id: string | null
  body: string
  created_at: string
}

export interface ReviewCriterion {
  criterion: string
  met: boolean
  comment: string
}

export interface ReviewIssue {
  severity: 'critical' | 'major' | 'minor'
  title: string
  detail: string
  location: string
}

export interface Review {
  id: string
  submission_id: string
  reviewer: 'ai' | 'human'
  reviewer_id: string | null
  verdict: Verdict
  score: number
  summary: string
  criteria: ReviewCriterion[]
  issues: ReviewIssue[]
  suggestions: string[]
  model: string
  created_at: string
}

export interface Submission {
  id: string
  project_id: string
  task_id: string | null
  author_id: string | null
  title: string
  language: string
  /** `undefined` tant que le code n'a pas été chargé (voir SUBMISSION_COLUMNS). */
  code?: string
  notes: string
  repo_url: string
  branch: string
  status: SubmissionStatus
  score: number | null
  created_at: string
  updated_at: string
}

export interface ActivityEntry {
  id: string
  project_id: string | null
  task_id: string | null
  actor_id: string | null
  kind: string
  text: string
  created_at: string
}

export interface ChatSession {
  id: string
  project_id: string | null
  user_id: string
  title: string
  created_at: string
  updated_at: string
}

/** Trace des actions menées sur le board, affichée sous la réponse. */
export interface ChatMessageMeta {
  created?: { id: string; seq: number; title: string }[]
  updated?: { id: string; seq: number; title: string }[]
  deleted?: string[]
  model?: string
}

export interface ChatMessage {
  id: string
  project_id: string | null
  session_id?: string | null
  user_id: string
  role: 'user' | 'assistant'
  content: string
  meta?: ChatMessageMeta | null
  created_at: string
}

export interface AppState {
  theme: Theme
  profile: Profile | null
  people: Profile[]
  projects: Project[]
  members: ProjectMember[]
  briefs: Brief[]
  tasks: Task[]
  submissions: Submission[]
  reviews: Review[]
  activity: ActivityEntry[]
  /** Projet actuellement sélectionné ; null = tous les projets. */
  currentProjectId: string | null
  /** Filtre du board : null = toute l'équipe, sinon un identifiant de compte. */
  assigneeFilter: string | null
}
