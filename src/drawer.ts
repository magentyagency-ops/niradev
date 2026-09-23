import { api } from './api.js'
import { openSubmissionForm, openTaskForm } from './forms.js'
import { openSubmissionDetail } from './views/reviews.js'
import { closeDrawer, openDrawer } from './modal.js'
import {
  canManage,
  latestReview,
  personById,
  personName,
  projectById,
  pushActivity,
  state,
  taskById,
  upsertTask,
} from './store.js'
import type { Task, TaskComment } from './types.js'
import {
  $,
  $$,
  escapeHtml,
  formatDate,
  formatHours,
  initialsOf,
  PRIORITIES,
  relativeTime,
  renderMarkdown,
  statusMeta,
  TASK_KINDS,
  TASK_STATUSES,
  toast,
} from './ui.js'

/**
 * Fiche détaillée d'une tâche.
 *
 * Le développeur y fait avancer son travail (statut, temps passé, commentaires,
 * livraison du code) ; le manager y retrouve en plus l'édition complète.
 */

let openTaskId: string | null = null

export function openTaskDetail(taskId: string): void {
  const task = taskById(taskId)
  if (!task) return
  openTaskId = taskId
  render(task)
  void loadComments(taskId)
}

function render(task: Task): void {
  const project = projectById(task.project_id)
  const meta = statusMeta(task.status)
  const kind = TASK_KINDS[task.kind]
  const priority = PRIORITIES[task.priority]
  const editable = canManage(task.project_id)
  const mine = task.assignee_id === state.profile?.id
  const submissions = state.submissions.filter((submission) => submission.task_id === task.id)

  const panel = openDrawer(`
    <div class="panel-head">
      <div>
        <p class="eyebrow">${escapeHtml(project?.code ?? 'PRJ')}-${task.seq} · ${escapeHtml(project?.name ?? '')}</p>
        <h2>${escapeHtml(task.title)}</h2>
        <p>Créée ${relativeTime(task.created_at)} par ${escapeHtml(personName(task.reporter_id))}</p>
      </div>
      <button class="icon-btn" type="button" data-close-drawer aria-label="Fermer"><i class="ri-close-line"></i></button>
    </div>

    <div class="status-picker" id="statusPicker">
      ${TASK_STATUSES.map(
        (status) => `
        <button class="status-pick${status.id === task.status ? ' active' : ''}" type="button" data-status="${status.id}"
          style="${status.id === task.status ? `background:${status.color};border-color:${status.color}` : ''}">
          ${status.label}
        </button>`,
      ).join('')}
    </div>

    <div class="detail-facts">
      <div class="fact"><small>Assigné à</small><b>${escapeHtml(personName(task.assignee_id))}</b></div>
      <div class="fact"><small>Priorité</small><b>${priority.label}</b></div>
      <div class="fact"><small>Type</small><b>${kind.label}</b></div>
      <div class="fact"><small>Échéance</small><b>${formatDate(task.due_date)}</b></div>
      <div class="fact"><small>Estimation</small><b>${formatHours(task.estimate)}</b></div>
      <div class="fact"><small>Temps passé</small><b>${formatHours(task.spent)}</b></div>
    </div>

    ${
      task.status === 'blocked'
        ? `<div class="task-blocked" style="margin-bottom:16px">${escapeHtml(task.blocked_reason || 'Tâche bloquée, motif non précisé.')}</div>`
        : ''
    }

    ${
      task.description
        ? `<p class="section-title">Description</p><div class="brief-text selectable md-body" style="font-size:12px;line-height:1.7">${renderMarkdown(task.description)}</div>`
        : ''
    }

    ${
      task.acceptance.length
        ? `<p class="section-title">Critères d'acceptation</p>
           <div class="criteria-list">
             ${task.acceptance
               .map(
                 (criterion) => `
               <div class="criterion${criterion.done ? ' done' : ''}">
                 <i class="${criterion.done ? 'ri-checkbox-circle-fill' : 'ri-checkbox-blank-circle-line'}"></i>
                 <span>${escapeHtml(criterion.text)}</span>
               </div>`,
               )
               .join('')}
           </div>`
        : ''
    }

    ${
      task.labels.length
        ? `<p class="section-title">Étiquettes</p><div class="task-meta">${task.labels
            .map((label) => `<span class="chip muted">${escapeHtml(label)}</span>`)
            .join('')}</div>`
        : ''
    }

    <p class="section-title">Livraisons</p>
    ${
      submissions.length
        ? `<div class="recent-list">${submissions
            .map((submission) => {
              const review = latestReview(submission.id)
              return `
              <button class="recent-item" type="button" data-submission="${submission.id}">
                <span class="recent-icon"><i class="ri-code-s-slash-line"></i></span>
                <span>
                  <b>${escapeHtml(submission.title)}</b>
                  <span>${escapeHtml(personName(submission.author_id))} · ${relativeTime(submission.created_at)}</span>
                </span>
                <span class="recent-meta">${review ? `${review.score}/100` : '—'}</span>
              </button>`
            })
            .join('')}</div>`
        : '<p class="muted" style="font-size:10.5px;margin:0">Aucun code livré pour cette tâche.</p>'
    }

    <div class="form-actions" style="justify-content:flex-start;margin-top:14px">
      ${mine || editable ? '<button class="btn primary" type="button" id="submitCode"><i class="ri-upload-cloud-2-line"></i>Livrer le code</button>' : ''}
      ${mine || editable ? '<button class="btn" type="button" id="logTime"><i class="ri-time-line"></i>Ajouter du temps</button>' : ''}
      ${editable ? '<button class="btn" type="button" id="editTask"><i class="ri-edit-line"></i>Modifier</button>' : ''}
    </div>

    <p class="section-title">Commentaires</p>
    <form class="comment-form" id="commentForm">
      <input class="field" name="body" placeholder="Poser une question, signaler un blocage…" required>
      <button class="btn primary" type="submit"><i class="ri-send-plane-2-line"></i></button>
    </form>
    <div class="comment-list" id="commentList">
      <p class="muted" style="font-size:10px;margin:0">Chargement…</p>
    </div>`)

  $$('[data-status]', panel).forEach((button) => {
    button.addEventListener('click', () => void changeStatus(task, button.dataset.status as Task['status']))
  })

  panel.querySelector('#editTask')?.addEventListener('click', () => openTaskForm(task))
  panel.querySelector('#submitCode')?.addEventListener('click', () => openSubmissionForm(task.id))
  panel.querySelector('#logTime')?.addEventListener('click', () => void logTime(task))

  $$('[data-submission]', panel).forEach((button) => {
    button.addEventListener('click', () => openSubmissionDetail(button.dataset.submission as string))
  })

  $<HTMLFormElement>('#commentForm', panel).addEventListener('submit', async (event) => {
    event.preventDefault()
    const form = event.currentTarget as HTMLFormElement
    const input = form.querySelector<HTMLInputElement>('input[name="body"]')
    const body = input?.value.trim()
    if (!body) return
    try {
      await api.addComment(task.id, body)
      if (input) input.value = ''
      await loadComments(task.id)
    } catch (error) {
      toast((error as Error).message, 'error')
    }
  })
}

async function changeStatus(task: Task, status: Task['status']): Promise<void> {
  if (status === task.status) return

  let reason = task.blocked_reason
  if (status === 'blocked') {
    const answer = window.prompt('Qu\'est-ce qui bloque cette tâche ?', task.blocked_reason)
    if (answer === null) return
    reason = answer
  }

  try {
    const updated = await api.updateTask(task.id, {
      status,
      blocked_reason: status === 'blocked' ? reason : '',
    })
    upsertTask(updated)
    const project = projectById(task.project_id)
    void api
      .logActivity({
        project_id: task.project_id,
        task_id: task.id,
        kind: 'status',
        text: `[${project?.code}-${task.seq}] ${statusMeta(task.status).label} → ${statusMeta(status).label}.`,
      })
      .then((entry) => entry && pushActivity(entry))
    render(updated)
    void loadComments(updated.id)
    toast(`Tâche déplacée vers « ${statusMeta(status).label} ».`)
  } catch (error) {
    toast((error as Error).message, 'error')
  }
}

async function logTime(task: Task): Promise<void> {
  const answer = window.prompt('Heures passées à ajouter :', '1')
  if (answer === null) return
  const hours = Number(answer.replace(',', '.'))
  if (!Number.isFinite(hours) || hours <= 0) {
    toast('Durée invalide.', 'error')
    return
  }
  try {
    const updated = await api.updateTask(task.id, { spent: task.spent + hours })
    upsertTask(updated)
    render(updated)
    void loadComments(updated.id)
    toast(`${hours} h ajoutée(s).`)
  } catch (error) {
    toast((error as Error).message, 'error')
  }
}

async function loadComments(taskId: string): Promise<void> {
  let comments: TaskComment[] = []
  try {
    comments = await api.loadComments(taskId)
  } catch {
    /* la fiche reste utilisable même si les commentaires ne remontent pas */
  }
  // Le tiroir a pu être fermé ou changer de tâche pendant la requête.
  if (openTaskId !== taskId) return
  const list = document.getElementById('commentList')
  if (!list) return

  list.innerHTML = comments.length
    ? comments
        .map((comment) => {
          const author = personById(comment.author_id)
          const name = author?.full_name || author?.email || 'Compte supprimé'
          return `
          <article class="comment">
            <span class="avatar">${escapeHtml(initialsOf(name))}</span>
            <div>
              <b>${escapeHtml(name)}</b>
              <p>${escapeHtml(comment.body)}</p>
              <time>${relativeTime(comment.created_at)}</time>
            </div>
          </article>`
        })
        .join('')
    : '<p class="muted" style="font-size:10px;margin:0">Aucun commentaire pour l\'instant.</p>'
}

export function initDrawer(): void {
  // Le tiroir se referme quand la tâche affichée disparaît (suppression, filtre).
  document.addEventListener('click', (event) => {
    const trigger = (event.target as HTMLElement).closest<HTMLElement>('[data-task]')
    if (trigger?.dataset.task) openTaskDetail(trigger.dataset.task)
  })
}

export function refreshOpenTask(): void {
  if (!openTaskId) return
  const task = taskById(openTaskId)
  if (!task) {
    closeDrawer()
    openTaskId = null
    return
  }
}
