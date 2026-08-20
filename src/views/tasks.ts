import { openTaskDetail } from '../drawer.js'
import { setupSectionProjectPicker } from '../projectPicker.js'
import { personName, projectById, setCurrentProject, state, subscribe } from '../store.js'
import type { Task } from '../types.js'
import {
  $,
  $$,
  debounce,
  emptyBlock,
  escapeHtml,
  formatDate,
  initialsOf,
  PRIORITIES,
  relativeTime,
  statusMeta,
  TASK_STATUSES,
  viewIsActive,
} from '../ui.js'

/** Vue tableau : la charge de travail, triable et filtrable. */

type Scope = 'mine' | 'project' | 'all'

let scope: Scope = 'project'
let statusFilter = 'open'
let search = ''
let sortKey = 'priority'
let sortAsc = false

export function initTasks(): void {
  setupSectionProjectPicker({
    containerId: 'taskProjectPicker',
    allowAll: true,
    allLabel: 'Tous les projets',
    allowMine: true,
    mineLabel: 'Mes tâches',
    getSelectedId: () => {
      if (scope === 'all') return 'all'
      if (scope === 'mine') return 'mine'
      return state.currentProjectId
    },
    onSelect: (val) => {
      if (val === 'all') {
        scope = 'all'
        $<HTMLSelectElement>('#taskScopeFilter').value = 'all'
      } else if (val === 'mine') {
        scope = 'mine'
        $<HTMLSelectElement>('#taskScopeFilter').value = 'mine'
      } else {
        scope = 'project'
        $<HTMLSelectElement>('#taskScopeFilter').value = 'project'
        if (val) setCurrentProject(val)
      }
      render()
    },
  })

  const statusSelect = $<HTMLSelectElement>('#taskStatusFilter')
  statusSelect.innerHTML = [
    '<option value="open">Tâches ouvertes</option>',
    '<option value="all">Tous les statuts</option>',
    ...TASK_STATUSES.map((status) => `<option value="${status.id}">${status.label}</option>`),
  ].join('')

  statusSelect.addEventListener('change', () => {
    statusFilter = statusSelect.value
    render()
  })

  $<HTMLSelectElement>('#taskScopeFilter').addEventListener('change', (event) => {
    scope = (event.target as HTMLSelectElement).value as Scope
    render()
  })

  const runSearch = debounce((value: string) => {
    search = value
    render()
  })
  $<HTMLInputElement>('#taskSearch').addEventListener('input', (event) => {
    runSearch((event.target as HTMLInputElement).value.toLowerCase())
  })

  $$('#taskTable th[data-sort]').forEach((header) => {
    header.addEventListener('click', () => {
      const key = header.dataset.sort as string
      sortAsc = key === sortKey ? !sortAsc : true
      sortKey = key
      render()
    })
  })

  subscribe(render)
}

function visibleTasks(): Task[] {
  const tasks = state.tasks.filter((task) => {
    if (scope === 'mine' && task.assignee_id !== state.profile?.id) return false
    if (scope === 'project' && task.project_id !== state.currentProjectId) return false
    if (statusFilter === 'open' && task.status === 'done') return false
    if (statusFilter !== 'open' && statusFilter !== 'all' && task.status !== statusFilter) return false
    if (!search) return true
    const project = projectById(task.project_id)
    return `${project?.code}-${task.seq} ${task.title} ${task.description} ${task.labels.join(' ')}`
      .toLowerCase()
      .includes(search)
  })

  const value = (task: Task): string | number => {
    switch (sortKey) {
      case 'seq':
        return task.seq
      case 'title':
        return task.title.toLowerCase()
      case 'project':
        return projectById(task.project_id)?.name.toLowerCase() ?? ''
      case 'status':
        return TASK_STATUSES.findIndex((status) => status.id === task.status)
      case 'priority':
        return PRIORITIES[task.priority].weight
      case 'assignee':
        return personName(task.assignee_id).toLowerCase()
      case 'due_date':
        return task.due_date ?? '9999'
      default:
        return task.updated_at
    }
  }

  return tasks.sort((a, b) => {
    const left = value(a)
    const right = value(b)
    const comparison = typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right))
    return sortAsc ? comparison : -comparison
  })
}

function render(): void {
  if (!viewIsActive('tasks')) return
  const tasks = visibleTasks()
  const body = $('#taskTableBody')
  const empty = $('#taskTableEmpty')

  if (!tasks.length) {
    body.innerHTML = ''
    empty.innerHTML = emptyBlock(
      'ri-list-check-3',
      'Aucune tâche',
      scope === 'mine' ? "Rien ne t'est assigné avec ces filtres." : 'Aucune tâche ne correspond aux filtres.',
    )
    return
  }

  empty.innerHTML = ''
  body.innerHTML = tasks
    .map((task) => {
      const project = projectById(task.project_id)
      const meta = statusMeta(task.status)
      const priority = PRIORITIES[task.priority]
      const assignee = personName(task.assignee_id)
      const late = task.due_date && new Date(task.due_date) < new Date() && task.status !== 'done'

      return `
      <tr data-task="${task.id}">
        <td class="ref">${escapeHtml(project?.code ?? '')}-${task.seq}</td>
        <td class="cell-name">
          <b>${escapeHtml(task.title)}</b>
          ${task.labels.length ? `<span>${escapeHtml(task.labels.join(' · '))}</span>` : ''}
        </td>
        <td>${escapeHtml(project?.name ?? '—')}</td>
        <td><span class="chip" style="color:${meta.color};background:color-mix(in srgb, ${meta.color} 12%, var(--surface))">${meta.label}</span></td>
        <td><span class="chip ${priority.chip}">${priority.label}</span></td>
        <td>
          <span class="cell-person">
            ${task.assignee_id ? `<span class="avatar">${escapeHtml(initialsOf(assignee))}</span>` : ''}
            ${escapeHtml(assignee)}
          </span>
        </td>
        <td class="num"${late ? ' style="color:var(--red)"' : ''}>${formatDate(task.due_date)}</td>
        <td class="num">${relativeTime(task.updated_at)}</td>
      </tr>`
    })
    .join('')

  $$('tr[data-task]', body).forEach((row) => {
    row.addEventListener('click', () => openTaskDetail(row.dataset.task as string))
  })
}
