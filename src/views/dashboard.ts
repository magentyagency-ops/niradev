import { aiApi } from '../aiApi.js'
import { openTaskDetail } from '../drawer.js'
import { openSubmissionDetail } from './reviews.js'
import { setupSectionProjectPicker } from '../projectPicker.js'
import {
  latestReview,
  personName,
  progressOf,
  projectById,
  setCurrentProject,
  state,
  subscribe,
} from '../store.js'
import type { Task } from '../types.js'
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
  statusMeta,
  toast,
  viewIsActive,
} from '../ui.js'

/** Tableau de bord : ce que je dois faire, et ce qui mérite une décision. */

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
}

let navigate: (view: string) => void = () => {}

function render(): void {
  if (!viewIsActive('dashboard')) return
  renderMetrics()
  renderMyTasks()
  renderSubmissions()
  renderProjects()
  renderActivity()
  $('#standupText').textContent = standupLoading
    ? 'Lecture des projets en cours…'
    : standup || "Demande un point d'avancement pour obtenir une lecture synthétique de la situation."
}

const myTasks = (): Task[] =>
  state.tasks
    .filter((task) => task.assignee_id === state.profile?.id && task.status !== 'done')
    .sort(
      (a, b) =>
        PRIORITIES[b.priority].weight - PRIORITIES[a.priority].weight ||
        (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999'),
    )

function renderMetrics(): void {
  const mine = myTasks()
  const late = mine.filter((task) => task.due_date && new Date(task.due_date) < new Date())
  const blocked = state.tasks.filter((task) => task.status === 'blocked')
  const pending = state.submissions.filter(
    (submission) => submission.status === 'pending' || submission.status === 'reviewing',
  )
  const load = mine.reduce((sum, task) => sum + task.estimate, 0)

  $('#dashboardMetrics').innerHTML = `
    <article class="metric glass"><small>Mes tâches</small><strong>${mine.length}</strong>
      <span class="metric-trend${late.length ? ' down' : ''}">${late.length ? `${late.length} en retard` : 'aucun retard'}</span></article>
    <article class="metric glass"><small>Charge restante</small><strong>${formatHours(load)}</strong>
      <span class="metric-trend">estimation cumulée</span></article>
    <article class="metric glass"><small>Tâches bloquées</small><strong>${blocked.length}</strong>
      <span class="metric-trend${blocked.length ? ' down' : ''}">sur tous tes projets</span></article>
    <article class="metric glass"><small>Livraisons à traiter</small><strong>${pending.length}</strong>
      <span class="metric-trend">en attente de revue</span></article>`
}

function renderMyTasks(): void {
  const node = $('#dashboardTasks')
  const tasks = myTasks().slice(0, 6)

  if (!tasks.length) {
    node.innerHTML = emptyBlock('ri-checkbox-circle-line', 'Rien à faire', "Aucune tâche ouverte ne t'est assignée.")
    return
  }

  node.innerHTML = `<div class="recent-list">${tasks
    .map((task) => {
      const project = projectById(task.project_id)
      const meta = statusMeta(task.status)
      const late = task.due_date && new Date(task.due_date) < new Date()
      return `
      <button class="recent-item" type="button" data-task="${task.id}">
        <span class="recent-icon" style="color:${meta.color};background:color-mix(in srgb, ${meta.color} 12%, var(--surface))">
          <i class="ri-checkbox-blank-circle-line"></i>
        </span>
        <span>
          <b>${escapeHtml(task.title)}</b>
          <span>${escapeHtml(project?.code ?? '')}-${task.seq} · ${meta.label}</span>
        </span>
        <span class="recent-meta${late ? '' : ''}" style="${late ? 'color:var(--red)' : ''}">
          ${task.due_date ? relativeDays(task.due_date) : PRIORITIES[task.priority].label}
        </span>
      </button>`
    })
    .join('')}</div>`

  $$('[data-task]', node).forEach((button) => {
    button.addEventListener('click', () => openTaskDetail(button.dataset.task as string))
  })
}

function renderSubmissions(): void {
  const node = $('#dashboardSubmissions')
  const submissions = state.submissions
    .filter((submission) => submission.status !== 'approved')
    .slice(0, 6)

  if (!submissions.length) {
    node.innerHTML = emptyBlock('ri-code-box-line', 'Aucune livraison en attente', 'Tout le code livré a été validé.')
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
