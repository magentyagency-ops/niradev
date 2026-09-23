import { aiApi } from '../aiApi.js'
import { openTaskDetail } from '../drawer.js'
import { openSubmissionDetail } from './reviews.js'
import { setupSectionProjectPicker } from '../projectPicker.js'
import { api } from '../api.js'
import {
  isManager,
  latestReview,
  personName,
  progressOf,
  projectById,
  pushActivity,
  setCurrentProject,
  state,
  subscribe,
  taskById,
  upsertTask,
} from '../store.js'
import type { Task, TaskStatus } from '../types.js'
import {
  $,
  $$,
  colorVar,
  emptyBlock,
  escapeHtml,
  formatHours,
  PRIORITIES,
  relativeDays,
  relativeTime,
  renderMarkdown,
  statusMeta,
  toast,
  viewIsActive,
} from '../ui.js'

/**
 * Page d'accueil : la journée de la personne connectée (objectifs, tâche en
 * cours, alertes, planning), puis la vue d'ensemble des projets.
 */

let standup = ''
let standupLoading = false

export function initDashboard(onNavigate: (view: string) => void): void {
  navigate = onNavigate
  setupSectionProjectPicker({
    containerId: 'dashboardProjectPicker',
    allowAll: true,
    allLabel: 'Tous les projets',
    getSelectedId: () => state.currentProjectId,
    onSelect: (id) => {
      if (id) setCurrentProject(id)
    },
  })

  $('#standupRefresh').addEventListener('click', () => void loadStandup())
  subscribe(render)
  // Les échéances « aujourd'hui / en retard » glissent avec l'heure.
  window.setInterval(() => render(), 5 * 60_000)
}

let navigate: (view: string) => void = () => {}

function render(): void {
  if (!viewIsActive('dashboard')) return
  renderHero()
  renderMetrics()
  renderMyTasks()
  renderNow()
  renderAlerts()
  renderAgenda()
  renderSubmissions()
  renderProjects()
  renderActivity()
  $('#standupText').innerHTML = standupLoading
    ? '<span class="today-muted"><i class="ri-loader-4-line spinning"></i> Lecture des projets en cours…</span>'
    : standup
      ? renderMarkdown(standup)
      : '<span class="today-muted">Génère une synthèse de l’avancement, des risques et des priorités du moment.</span>'
}

/* ----------------------------------------------------------------- dates */

const startOfDay = (date = new Date()): Date => {
  const copy = new Date(date)
  copy.setHours(0, 0, 0, 0)
  return copy
}
const todayKey = (): string => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
/** Écart en jours entre une échéance (YYYY-MM-DD) et aujourd'hui. */
const daysUntil = (due: string): number =>
  Math.round((new Date(`${due.slice(0, 10)}T00:00:00`).getTime() - startOfDay().getTime()) / 86_400_000)

const inScope = (task: Task): boolean =>
  !state.currentProjectId || state.currentProjectId === 'all' || task.project_id === state.currentProjectId

const mineAll = (): Task[] => state.tasks.filter((task) => task.assignee_id === state.profile?.id && inScope(task))

const byUrgency = (a: Task, b: Task): number =>
  (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999') ||
  PRIORITIES[b.priority].weight - PRIORITIES[a.priority].weight

const myTasks = (): Task[] =>
  mineAll()
    .filter((task) => task.status !== 'done')
    .sort(
      (a, b) =>
        PRIORITIES[b.priority].weight - PRIORITIES[a.priority].weight ||
        (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999'),
    )

const doneToday = (): Task[] =>
  mineAll().filter((task) => task.status === 'done' && task.done_at && new Date(task.done_at) >= startOfDay())

/**
 * Objectifs du jour : ce qui est en retard ou dû aujourd'hui, ce qui est déjà
 * commencé, puis l'urgent. On complète avec la suite logique pour avoir au
 * moins trois objectifs, sans dépasser six pour que la liste reste actionnable.
 */
function todayObjectives(): Task[] {
  const open = myTasks().filter((task) => task.status !== 'backlog')
  const score = (task: Task): number => {
    let value = PRIORITIES[task.priority].weight
    if (task.due_date && daysUntil(task.due_date) <= 0) value += 20
    else if (task.due_date && daysUntil(task.due_date) <= 2) value += 6
    if (task.status === 'in_progress') value += 10
    if (task.status === 'review') value += 4
    if (task.status === 'blocked') value -= 3
    return value
  }
  const essential = open.filter(
    (task) =>
      (task.due_date && daysUntil(task.due_date) <= 0) ||
      task.status === 'in_progress' ||
      task.priority === 'urgent',
  )
  const rest = open.filter((task) => !essential.includes(task))
  const picked = [...essential]
  for (const task of rest.sort((a, b) => score(b) - score(a))) {
    if (picked.length >= 3) break
    picked.push(task)
  }
  return picked.sort((a, b) => score(b) - score(a)).slice(0, 6)
}

/* ------------------------------------------------------------------ hero */

function greeting(): string {
  const hour = new Date().getHours()
  if (hour < 5 || hour >= 18) return 'Bonsoir'
  if (hour < 12) return 'Bonjour'
  return 'Bon après-midi'
}

function ring(percent: number): string {
  const radius = 34
  const circumference = 2 * Math.PI * radius
  return `
    <svg viewBox="0 0 84 84" class="today-ring" aria-hidden="true">
      <circle cx="42" cy="42" r="${radius}" class="ring-track"></circle>
      <circle cx="42" cy="42" r="${radius}" class="ring-fill"
        stroke-dasharray="${circumference.toFixed(1)}" stroke-dashoffset="${(circumference * (1 - percent / 100)).toFixed(1)}"></circle>
    </svg>`
}

function renderHero(): void {
  const objectives = todayObjectives()
  const done = doneToday()
  const total = objectives.length + done.length
  const percent = total ? Math.round((done.length / total) * 100) : 0
  const late = myTasks().filter((task) => task.due_date && daysUntil(task.due_date) < 0)
  const firstName = (state.profile?.full_name || state.profile?.email || '').split(/[\s@]/)[0]
  const date = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })

  let headline: string
  if (!total) headline = "Aucun objectif aujourd'hui : c'est le moment d'avancer sur le backlog ou d'aider l'équipe."
  else if (!objectives.length) headline = 'Tous tes objectifs du jour sont atteints. Beau travail 👏'
  else
    headline = `Tu as <b>${objectives.length} objectif${objectives.length > 1 ? 's' : ''}</b> aujourd'hui${
      late.length ? `, dont <b class="danger">${late.length} en retard</b>` : ''
    }. ${objectives[0] ? `Commence par <b>${escapeHtml(objectives[0].title)}</b>.` : ''}`

  $('#todayHero').innerHTML = `
    <div class="today-hero-main">
      <p class="today-date"><i class="ri-calendar-event-line"></i>${escapeHtml(date.charAt(0).toUpperCase() + date.slice(1))}</p>
      <h1>${greeting()}${firstName ? ` ${escapeHtml(firstName)}` : ''}.</h1>
      <p class="today-headline">${headline}</p>
      <div class="today-hero-actions">
        ${
          objectives[0]
            ? `<button class="btn primary" type="button" data-task="${objectives[0].id}"><i class="ri-play-fill"></i>Ouvrir la priorité n°1</button>`
            : ''
        }
        <button class="btn" data-go="board"><i class="ri-kanban-view-2"></i>Board</button>
        <button class="btn" data-go="assistant"><i class="ri-sparkling-2-line"></i>Demander à Nira</button>
        <button class="btn manager-only" data-action="new-task"${isManager() ? '' : ' hidden'}><i class="ri-add-line"></i>Nouvelle tâche</button>
        <button class="btn dev-only" data-action="new-submission"${isManager() ? ' hidden' : ''}><i class="ri-upload-cloud-2-line"></i>Livrer du code</button>
      </div>
    </div>
    <div class="today-progress">
      <div class="ring-wrap">${ring(percent)}
      <div class="today-progress-label"><strong>${done.length}/${total}</strong><span>objectifs</span></div></div>
      <p>${percent === 100 && total ? 'Journée bouclée' : 'Progression du jour'}</p>
    </div>`

  $$('[data-task]', $('#todayHero')).forEach((button) =>
    button.addEventListener('click', () => openTaskDetail(button.dataset.task as string)),
  )
}

function renderMetrics(): void {
  const mine = myTasks()
  const late = mine.filter((task) => task.due_date && daysUntil(task.due_date) < 0)
  const weekStart = startOfDay()
  weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7))
  const doneWeek = mineAll().filter((task) => task.done_at && new Date(task.done_at) >= weekStart)
  const load = mine.reduce((sum, task) => sum + Math.max(0, task.estimate - task.spent), 0)
  const inReview = mine.filter((task) => task.status === 'review')

  const stat = (icon: string, color: string, label: string, value: string, hint: string, tone = '') => `
    <article class="today-stat glass">
      <span class="today-stat-icon" style="color:${color};background:color-mix(in srgb, ${color} 13%, var(--surface))"><i class="${icon}"></i></span>
      <div><small>${label}</small><strong>${value}</strong><span class="${tone}">${hint}</span></div>
    </article>`

  $('#dashboardMetrics').innerHTML = [
    stat('ri-list-check-3', 'var(--blue)', 'Tâches ouvertes', String(mine.length), `${mine.filter((t) => t.status === 'in_progress').length} en cours`),
    stat('ri-time-line', 'var(--red)', 'En retard', String(late.length), late.length ? 'à replanifier ou livrer' : 'rien en retard', late.length ? 'down' : 'up'),
    stat('ri-checkbox-circle-line', 'var(--green)', 'Terminées cette semaine', String(doneWeek.length), `${doneToday().length} aujourd'hui`, 'up'),
    stat('ri-hourglass-2-line', 'var(--amber)', 'Charge restante', formatHours(load), `${inReview.length} en revue`),
  ].join('')
}

function dueLabel(task: Task): { text: string; tone: string } {
  if (!task.due_date) return { text: 'Sans échéance', tone: 'muted' }
  const days = daysUntil(task.due_date)
  if (days < 0) return { text: `En retard de ${-days} j`, tone: 'red' }
  if (days === 0) return { text: "Aujourd'hui", tone: 'amber' }
  if (days === 1) return { text: 'Demain', tone: '' }
  return { text: relativeDays(task.due_date), tone: 'muted' }
}

function objectiveRow(task: Task, index: number, done = false): string {
  const project = projectById(task.project_id)
  const meta = statusMeta(task.status)
  const due = dueLabel(task)
  const prio = PRIORITIES[task.priority]
  const checklist = task.acceptance.length
    ? `<span><i class="ri-checkbox-multiple-line"></i>${task.acceptance.filter((c) => c.done).length}/${task.acceptance.length}</span>`
    : ''
  const action = done
    ? ''
    : task.status === 'todo' || task.status === 'backlog'
      ? `<button class="btn small" type="button" data-move="${task.id}" data-to="in_progress"><i class="ri-play-line"></i>Démarrer</button>`
      : task.status === 'in_progress'
        ? `<button class="btn small" type="button" data-move="${task.id}" data-to="review"><i class="ri-send-plane-line"></i>En revue</button>`
        : ''
  return `
    <article class="objective${done ? ' done' : ''}${task.status === 'blocked' ? ' blocked' : ''}">
      <button class="objective-check" type="button" ${done ? 'disabled' : `data-complete="${task.id}"`} title="${done ? 'Terminée' : 'Marquer comme terminée'}">
        <i class="${done ? 'ri-checkbox-circle-fill' : 'ri-checkbox-blank-circle-line'}"></i>
      </button>
      <div class="objective-body" data-task="${task.id}">
        <div class="objective-top">
          ${done ? '' : `<span class="objective-rank">${index + 1}</span>`}
          <b>${escapeHtml(task.title)}</b>
        </div>
        <div class="objective-meta">
          <span class="project-dot" style="background:${colorVar(project?.color ?? 'blue')}"></span>
          <span>${escapeHtml(project?.code ?? '')}-${task.seq}</span>
          <span style="color:${meta.color}">● ${meta.label}</span>
          ${task.estimate ? `<span><i class="ri-time-line"></i>${formatHours(task.estimate)}</span>` : ''}
          ${checklist}
        </div>
      </div>
      <div class="objective-side">
        ${done ? '<span class="chip green">Fait</span>' : `<span class="chip ${prio.chip}">${prio.label}</span><span class="chip ${due.tone}">${due.text}</span>`}
        ${action}
      </div>
    </article>`
}

function renderMyTasks(): void {
  const node = $('#dashboardTasks')
  const objectives = todayObjectives()
  const done = doneToday()

  if (!objectives.length && !done.length) {
    node.innerHTML = emptyBlock('ri-cup-line', 'Journée libre', "Aucune tâche ouverte ne t'est assignée. Demande au manager ou pioche dans le backlog.")
    return
  }

  node.innerHTML = `<div class="objectives">${objectives.map((task, index) => objectiveRow(task, index)).join('')}${
    done.length ? `<p class="objectives-sep">Terminé aujourd'hui</p>${done.map((task, index) => objectiveRow(task, index, true)).join('')}` : ''
  }</div>`

  bindTaskActions(node)
}

function bindTaskActions(node: HTMLElement): void {
  $$('[data-task]', node).forEach((el) => el.addEventListener('click', () => openTaskDetail(el.dataset.task as string)))
  $$('[data-complete]', node).forEach((el) =>
    el.addEventListener('click', (event) => {
      event.stopPropagation()
      void moveTask(el.dataset.complete as string, 'done')
    }),
  )
  $$('[data-move]', node).forEach((el) =>
    el.addEventListener('click', (event) => {
      event.stopPropagation()
      void moveTask(el.dataset.move as string, el.dataset.to as TaskStatus)
    }),
  )
}

async function moveTask(taskId: string, status: TaskStatus): Promise<void> {
  const task = taskById(taskId)
  if (!task || task.status === status) return
  const previous = task
  upsertTask({ ...task, status, done_at: status === 'done' ? new Date().toISOString() : null })
  try {
    upsertTask(await api.updateTask(task.id, { status }))
    if (status === 'done') toast(`Bravo ! « ${task.title} » est terminée.`)
    void api
      .logActivity({
        project_id: task.project_id,
        task_id: task.id,
        kind: 'status',
        text: `${statusMeta(previous.status).label} → ${statusMeta(status).label} : ${task.title}.`,
      })
      .then((entry) => entry && pushActivity(entry))
  } catch (error) {
    upsertTask(previous)
    toast((error as Error).message, 'error')
  }
}

function renderNow(): void {
  const node = $('#todayNow')
  const current = myTasks().filter((task) => task.status === 'in_progress')
  if (!current.length) {
    const next = todayObjectives()[0]
    node.innerHTML = next
      ? `<div class="now-empty"><p>Aucune tâche en cours.</p><button class="btn primary small" type="button" data-move="${next.id}" data-to="in_progress"><i class="ri-play-fill"></i>Démarrer « ${escapeHtml(next.title.length > 34 ? `${next.title.slice(0, 34)}…` : next.title)} »</button></div>`
      : `<p class="today-muted">Rien en cours pour le moment.</p>`
    bindTaskActions(node)
    return
  }
  node.innerHTML = current
    .slice(0, 2)
    .map((task) => {
      const project = projectById(task.project_id)
      const doneCriteria = task.acceptance.filter((c) => c.done).length
      const percent = task.acceptance.length
        ? Math.round((doneCriteria / task.acceptance.length) * 100)
        : task.estimate
          ? Math.min(100, Math.round((task.spent / task.estimate) * 100))
          : 0
      return `
      <div class="now-card" data-task="${task.id}">
        <span class="now-live"><span></span>En cours</span>
        <b>${escapeHtml(task.title)}</b>
        <small>${escapeHtml(project?.name ?? '')} · ${escapeHtml(project?.code ?? '')}-${task.seq}</small>
        <div class="progress-track"><div class="progress-fill" style="width:${percent}%;background:var(--violet)"></div></div>
        <div class="now-foot">
          <span>${task.acceptance.length ? `${doneCriteria}/${task.acceptance.length} critères` : `${formatHours(task.spent)} / ${formatHours(task.estimate)}`}</span>
          <button class="btn small" type="button" data-move="${task.id}" data-to="review"><i class="ri-send-plane-line"></i>Passer en revue</button>
        </div>
      </div>`
    })
    .join('')
  bindTaskActions(node)
}

function renderAlerts(): void {
  const node = $('#todayAlerts')
  const me = state.profile?.id
  const blocked = myTasks().filter((task) => task.status === 'blocked')
  const late = myTasks().filter((task) => task.due_date && daysUntil(task.due_date) < 0 && task.status !== 'blocked')
  const fixes = state.submissions.filter(
    (submission) => submission.author_id === me && (submission.status === 'changes_requested' || submission.status === 'rejected'),
  )

  const items = [
    ...blocked.map(
      (task) => `<button class="alert-item red" type="button" data-task="${task.id}"><i class="ri-forbid-2-line"></i><span><b>${escapeHtml(task.title)}</b><small>Bloquée${task.blocked_reason ? ` : ${escapeHtml(task.blocked_reason)}` : ''}</small></span></button>`,
    ),
    ...fixes.map(
      (submission) => `<button class="alert-item amber" type="button" data-submission="${submission.id}"><i class="ri-error-warning-line"></i><span><b>${escapeHtml(submission.title)}</b><small>Corrections demandées${submission.score !== null ? ` · ${submission.score}/100` : ''}</small></span></button>`,
    ),
    ...late.map(
      (task) => `<button class="alert-item red" type="button" data-task="${task.id}"><i class="ri-time-line"></i><span><b>${escapeHtml(task.title)}</b><small>${dueLabel(task).text}</small></span></button>`,
    ),
  ]

  node.innerHTML = items.length
    ? `<div class="alert-list">${items.slice(0, 6).join('')}</div>`
    : `<div class="all-clear"><i class="ri-shield-check-line"></i><span>Rien à signaler, tout est sous contrôle.</span></div>`

  $$('[data-task]', node).forEach((el) => el.addEventListener('click', () => openTaskDetail(el.dataset.task as string)))
  $$('[data-submission]', node).forEach((el) =>
    el.addEventListener('click', () => openSubmissionDetail(el.dataset.submission as string)),
  )
}

function renderAgenda(): void {
  const node = $('#todayAgenda')
  const open = myTasks().filter((task) => task.status !== 'done')
  const buckets: { label: string; icon: string; tasks: Task[] }[] = [
    { label: 'En retard', icon: 'ri-error-warning-line', tasks: [] },
    { label: "Aujourd'hui", icon: 'ri-sun-line', tasks: [] },
    { label: 'Cette semaine', icon: 'ri-calendar-line', tasks: [] },
    { label: 'Plus tard', icon: 'ri-calendar-2-line', tasks: [] },
    { label: 'Sans échéance', icon: 'ri-inbox-line', tasks: [] },
  ]
  const endOfWeek = 7 - ((new Date().getDay() + 6) % 7) - 1
  for (const task of open.sort(byUrgency)) {
    if (!task.due_date) buckets[4].tasks.push(task)
    else {
      const days = daysUntil(task.due_date)
      buckets[days < 0 ? 0 : days === 0 ? 1 : days <= endOfWeek ? 2 : 3].tasks.push(task)
    }
  }

  if (!open.length) {
    node.innerHTML = emptyBlock('ri-calendar-check-line', 'Planning vide', 'Aucune tâche ouverte ne t’est assignée.')
    return
  }

  node.innerHTML = buckets
    .map(
      (bucket, index) => `
      <div class="agenda-col${index === 0 && bucket.tasks.length ? ' late' : ''}">
        <p class="agenda-head"><i class="${bucket.icon}"></i>${bucket.label}<span>${bucket.tasks.length}</span></p>
        ${
          bucket.tasks.length
            ? bucket.tasks
                .slice(0, 5)
                .map((task) => {
                  const project = projectById(task.project_id)
                  return `<button class="agenda-item" type="button" data-task="${task.id}">
                    <b>${escapeHtml(task.title)}</b>
                    <small><span class="project-dot" style="background:${colorVar(project?.color ?? 'blue')}"></span>${escapeHtml(project?.code ?? '')}-${task.seq}${
                      task.due_date ? ` · ${new Date(`${task.due_date.slice(0, 10)}T00:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}` : ''
                    }<span class="chip ${PRIORITIES[task.priority].chip}">${PRIORITIES[task.priority].label}</span></small>
                  </button>`
                })
                .join('') + (bucket.tasks.length > 5 ? `<p class="agenda-more">+ ${bucket.tasks.length - 5} autre(s)</p>` : '')
            : '<p class="agenda-empty">—</p>'
        }
      </div>`,
    )
    .join('')
  bindTaskActions(node)
}

function renderSubmissions(): void {
  const node = $('#dashboardSubmissions')
  const manager = isManager()
  $('#submissionsTitle').textContent = manager ? 'Livraisons à examiner' : 'Mes livraisons'
  $('#submissionsHint').textContent = manager
    ? 'Code soumis, en attente ou en retour de revue.'
    : 'Le code que tu as livré et le verdict de la revue.'
  const submissions = state.submissions
    .filter((submission) => (manager ? submission.status !== 'approved' : submission.author_id === state.profile?.id))
    .slice(0, 6)

  if (!submissions.length) {
    node.innerHTML = emptyBlock('ri-code-box-line', manager ? 'Aucune livraison en attente' : 'Aucune livraison', manager ? 'Tout le code livré a été validé.' : 'Livre ton code depuis une tâche pour obtenir une revue.')
    return
  }

  node.innerHTML = `<div class="recent-list">${submissions
    .map((submission) => {
      const review = latestReview(submission.id)
      const project = projectById(submission.project_id)
      return `
      <button class="recent-item" type="button" data-submission="${submission.id}">
        <span class="recent-icon"><i class="ri-code-s-slash-line"></i></span>
        <span>
          <b>${escapeHtml(submission.title)}</b>
          <span>${escapeHtml(project?.name ?? '')} · ${escapeHtml(personName(submission.author_id))} · ${relativeTime(submission.created_at)}</span>
        </span>
        <span class="recent-meta">${review ? `${review.score}/100` : 'à analyser'}</span>
      </button>`
    })
    .join('')}</div>`

  $$('[data-submission]', node).forEach((button) => {
    button.addEventListener('click', () => openSubmissionDetail(button.dataset.submission as string))
  })
}

function renderProjects(): void {
  const node = $('#dashboardProjects')
  const projects = state.projects.filter((project) => project.status === 'active' || project.status === 'paused')

  if (!projects.length) {
    node.innerHTML = emptyBlock('ri-folder-line', 'Aucun projet actif', 'Les projets livrés ou archivés sont masqués ici.')
    return
  }

  node.innerHTML = `<div class="progress-rows">${projects
    .map((project) => {
      const progress = progressOf(project.id)
      return `
      <div class="progress-row" data-project="${project.id}">
        <b>${escapeHtml(project.name)}</b>
        <div class="progress-track">
          <div class="progress-fill" style="width:${progress.percent}%;background:${colorVar(project.color)}"></div>
        </div>
        <span>${progress.done}/${progress.total} · ${progress.percent} %</span>
      </div>`
    })
    .join('')}</div>`

  $$('[data-project]', node).forEach((row) => {
    row.addEventListener('click', () => {
      setCurrentProject(row.dataset.project as string)
      navigate('board')
    })
  })
}

const ACTIVITY_ICONS: Record<string, string> = {
  task: 'ri-add-line',
  status: 'ri-arrow-right-line',
  brief: 'ri-file-text-line',
  submission: 'ri-upload-cloud-2-line',
  review: 'ri-scan-line',
  project: 'ri-folder-line',
}

function renderActivity(): void {
  const node = $('#dashboardActivity')
  const entries = state.activity.filter((entry) => entry.text).slice(0, 12)

  if (!entries.length) {
    node.innerHTML = emptyBlock('ri-pulse-line', 'Pas encore d’activité', 'Les mouvements de l’équipe apparaîtront ici.')
    return
  }

  node.innerHTML = `<div class="timeline">${entries
    .map(
      (entry) => `
      <article class="timeline-item">
        <i class="${ACTIVITY_ICONS[entry.kind] ?? 'ri-information-line'}"></i>
        <div>
          <p>${escapeHtml(entry.text)}</p>
          <time>${escapeHtml(personName(entry.actor_id))} · ${relativeTime(entry.created_at)}</time>
        </div>
      </article>`,
    )
    .join('')}</div>`
}

/* -------------------------------------------------- point d'avancement IA */

async function loadStandup(): Promise<void> {
  if (standupLoading) return
  standupLoading = true
  const button = $<HTMLButtonElement>('#standupRefresh')
  button.disabled = true
  button.innerHTML = '<i class="ri-loader-4-line spinning"></i>Lecture…'
  render()

  try {
    const { summary } = await aiApi.standup({ projectId: state.currentProjectId })
    standup = summary
  } catch (error) {
    toast((error as Error).message, 'error')
  } finally {
    standupLoading = false
    button.disabled = false
    button.innerHTML = '<i class="ri-refresh-line"></i>Générer'
    render()
  }
}
