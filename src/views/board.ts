import { api } from '../api.js'
import { openTaskPlanner } from '../forms.js'
import { openTaskDetail } from '../drawer.js'
import { setupSectionProjectPicker } from '../projectPicker.js'
import {
  canManage,
  currentProject,
  matchesAssignee,
  personName,
  projectTasks,
  projectTeam,
  pushActivity,
  resumeRenders,
  setAssigneeFilter,
  setCurrentProject,
  suspendRenders,
  state,
  subscribe,
  taskById,
  upsertTask,
} from '../store.js'
import type { Task, TaskStatus } from '../types.js'
import {
  $,
  $$,
  debounce,
  emptyBlock,
  escapeHtml,
  initialsOf,
  PRIORITIES,
  relativeDays,
  statusMeta,
  TASK_KINDS,
  TASK_STATUSES,
  toast,
  viewIsActive,
} from '../ui.js'

/** Board de type kanban : une colonne par statut, cartes déplaçables. */

let search = ''
let dragged: string | null = null

export function initBoard(): void {
  setupSectionProjectPicker({
    containerId: 'boardProjectPicker',
    getSelectedId: () => state.currentProjectId,
    onSelect: (id) => {
      if (id) setCurrentProject(id)
    },
  })

  const runSearch = debounce((value: string) => {
    search = value
    render()
  })
  $<HTMLInputElement>('#boardSearch').addEventListener('input', (event) => {
    runSearch((event.target as HTMLInputElement).value.toLowerCase())
  })

  const filter = $('#assigneeFilter')
  $('#assigneeFilterToggle').addEventListener('click', (event) => {
    event.stopPropagation()
    filter.classList.toggle('open')
  })
  document.addEventListener('click', (event) => {
    if (!filter.contains(event.target as Node)) filter.classList.remove('open')
  })

  $('#planTasksBtn').addEventListener('click', () => void openTaskPlanner())

  subscribe(render)
}

function render(): void {
  if (!viewIsActive('board')) return
  const project = currentProject()

  $('#boardProjectName').textContent = project ? project.name : 'Board'
  $('#planTasksBtn').hidden = !project || !canManage(project.id)
  renderAssigneeFilter()

  const board = $('#board')

  if (!project) {
    board.innerHTML = emptyBlock(
      'ri-folder-open-line',
      'Aucun projet sélectionné',
      'Choisis un projet dans le sélecteur en haut de page, ou demande à ton manager de t’affecter à un projet.',
      false,
    )
    board.style.display = 'block'
    return
  }

  board.style.display = ''
  const tasks = projectTasks(project.id).filter((task) => {
    if (!matchesAssignee(task)) return false
    if (!search) return true
    const haystack = `${project.code}-${task.seq} ${task.title} ${task.description} ${task.labels.join(' ')}`
    return haystack.toLowerCase().includes(search)
  })

  board.innerHTML = TASK_STATUSES.map((status) => {
    const columnTasks = tasks
      .filter((task) => task.status === status.id)
      .sort((a, b) => PRIORITIES[b.priority].weight - PRIORITIES[a.priority].weight || a.order_index - b.order_index)

    return `
      <section class="column glass" data-status="${status.id}">
        <header class="column-head">
          <span class="column-dot" style="background:${status.color}"></span>
          <b>${status.label}</b>
          <span class="count">${columnTasks.length}</span>
        </header>
        <div class="column-list">
          ${
            columnTasks.map((task) => card(task, project.code)).join('') ||
            '<div class="column-empty">Rien ici</div>'
          }
        </div>
      </section>`
  }).join('')

  bindDragAndDrop()
}

function card(task: Task, code: string): string {
  const priority = PRIORITIES[task.priority]
  const kind = TASK_KINDS[task.kind]
  const late = task.due_date && new Date(task.due_date) < new Date() && task.status !== 'done'
  const assignee = task.assignee_id ? personName(task.assignee_id) : ''

  return `
    <article class="task-card${task.priority === 'urgent' ? ' urgent' : ''}" draggable="true" data-task="${task.id}">
      <div class="task-top">
        <span class="task-ref">${escapeHtml(code)}-${task.seq}</span>
        <i class="${kind.icon}" style="color:var(--muted);font-size:13px" title="${kind.label}"></i>
      </div>
      <b>${escapeHtml(task.title)}</b>
      ${task.blocked_reason && task.status === 'blocked' ? `<p class="task-blocked">${escapeHtml(task.blocked_reason)}</p>` : ''}
      <div class="task-meta">
        ${assignee ? `<span class="avatar" title="${escapeHtml(assignee)}">${escapeHtml(initialsOf(assignee))}</span>` : ''}
        <span class="chip ${priority.chip}">${priority.label}</span>
        ${task.estimate ? `<span class="chip muted">${task.estimate} h</span>` : ''}
        ${task.due_date ? `<span class="chip ${late ? 'red' : 'muted'}">${relativeDays(task.due_date)}</span>` : ''}
        ${task.acceptance.length ? `<span class="chip muted"><i class="ri-list-check"></i>${task.acceptance.length}</span>` : ''}
      </div>
    </article>`
}

function renderAssigneeFilter(): void {
  const project = currentProject()
  const team = project ? projectTeam(project.id) : state.people
  const list = $('#assigneeFilterList')
  const current = state.assigneeFilter

  list.innerHTML = [
    `<button class="owner-option${current ? '' : ' active'}" type="button" data-assignee="">
       <span class="avatar muted"><i class="ri-group-line"></i></span>
       <span><b>Toute l'équipe</b><small>aucun filtre</small></span>
     </button>`,
    ...team.map((person) => {
      const name = person.full_name || person.email
      return `<button class="owner-option${current === person.id ? ' active' : ''}" type="button" data-assignee="${person.id}">
        <span class="avatar">${escapeHtml(initialsOf(name))}</span>
        <span><b>${escapeHtml(name)}</b><small>${escapeHtml(person.job_title || person.dev_role)}</small></span>
      </button>`
    }),
  ].join('')

  $('#assigneeFilterLabel').textContent = current ? personName(current) : "Toute l'équipe"

  $$('[data-assignee]', list).forEach((button) => {
    button.addEventListener('click', () => {
      setAssigneeFilter(button.dataset.assignee || null)
      $('#assigneeFilter').classList.remove('open')
    })
  })
}

/* ------------------------------------------------------ glisser-déposer */

function bindDragAndDrop(): void {
  $$('.task-card').forEach((node) => {
    node.addEventListener('dragstart', () => {
      dragged = node.dataset.task ?? null
      node.classList.add('dragging')
      // Reconstruire le board pendant le geste supprimerait la carte que
      // l'utilisateur est en train de déplacer.
      suspendRenders()
    })
    node.addEventListener('dragend', () => {
      dragged = null
      node.classList.remove('dragging')
      resumeRenders()
    })
    node.addEventListener('click', () => {
      if (node.dataset.task) openTaskDetail(node.dataset.task)
    })
  })

  $$('.column').forEach((column) => {
    column.addEventListener('dragover', (event) => {
      event.preventDefault()
      column.classList.add('drag-over')
    })
    column.addEventListener('dragleave', () => column.classList.remove('drag-over'))
    column.addEventListener('drop', (event) => {
      event.preventDefault()
      column.classList.remove('drag-over')
      const status = column.dataset.status as TaskStatus
      if (dragged) void moveTask(dragged, status)
    })
  })
}

async function moveTask(taskId: string, status: TaskStatus): Promise<void> {
  const task = taskById(taskId)
  if (!task || task.status === status) return

  // Un développeur fait avancer son propre travail ; réattribuer ou déplacer la
  // tâche d'un collègue reste une décision de manager.
  if (!canManage(task.project_id) && task.assignee_id !== state.profile?.id) {
    toast("Cette tâche n'est pas la tienne : demande au manager de la déplacer.", 'error')
    return
  }

  let reason = ''
  if (status === 'blocked') {
    const answer = window.prompt('Qu\'est-ce qui bloque cette tâche ?', task.blocked_reason)
    if (answer === null) return
    reason = answer
  }

  const previous = task.status
  // Déplacement optimiste : la carte suit le curseur, la base rattrape ensuite.
  upsertTask({ ...task, status, blocked_reason: status === 'blocked' ? reason : '' })

  try {
    const updated = await api.updateTask(task.id, {
      status,
      blocked_reason: status === 'blocked' ? reason : '',
    })
    upsertTask(updated)
    void api
      .logActivity({
        project_id: task.project_id,
        task_id: task.id,
        kind: 'status',
        text: `${statusMeta(previous).label} → ${statusMeta(status).label} : ${task.title}.`,
      })
      .then((entry) => entry && pushActivity(entry))
  } catch (error) {
    upsertTask({ ...task, status: previous })
    toast((error as Error).message, 'error')
  }
}
