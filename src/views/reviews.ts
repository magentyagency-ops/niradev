import { aiApi } from '../aiApi.js'
import { api } from '../api.js'
import { openSubmissionForm } from '../forms.js'
import { closeDrawer, confirmAction, openDrawer } from '../modal.js'
import { setupSectionProjectPicker } from '../projectPicker.js'
import {
  canManage,
  latestReview,
  personName,
  notify,
  projectById,
  setCurrentProject,
  state,
  subscribe,
  taskById,
  upsertReview,
  upsertSubmission,
  upsertTask,
} from '../store.js'
import type { Submission } from '../types.js'
import {
  $,
  $$,
  emptyBlock,
  escapeHtml,
  formatDateTime,
  relativeTime,
  SUBMISSION_STATUSES,
  toast,
  VERDICTS,
  viewIsActive,
} from '../ui.js'

/**
 * Revue de code : chaque fonctionnalité livrée est confrontée au brief et aux
 * critères d'acceptation de la tâche, et reçoit un verdict argumenté.
 */

type Scope = 'project' | 'mine' | 'all'
let scope: Scope = 'project'

/** Livraisons dont l'analyse est en cours, pour l'affichage du chargement. */
const running = new Set<string>()

export function initReviews(): void {
  setupSectionProjectPicker({
    containerId: 'reviewProjectPicker',
    allowAll: true,
    allLabel: 'Toutes les livraisons',
    allowMine: true,
    mineLabel: 'Mes livraisons',
    getSelectedId: () => {
      if (scope === 'all') return 'all'
      if (scope === 'mine') return 'mine'
      return state.currentProjectId
    },
    onSelect: (val) => {
      if (val === 'all') {
        scope = 'all'
        $<HTMLSelectElement>('#reviewScopeFilter').value = 'all'
      } else if (val === 'mine') {
        scope = 'mine'
        $<HTMLSelectElement>('#reviewScopeFilter').value = 'mine'
      } else {
        scope = 'project'
        $<HTMLSelectElement>('#reviewScopeFilter').value = 'project'
        if (val) setCurrentProject(val)
      }
      render()
    },
  })

  $<HTMLSelectElement>('#reviewScopeFilter').addEventListener('change', (event) => {
    scope = (event.target as HTMLSelectElement).value as Scope
    render()
  })
  subscribe(render)
}

function visibleSubmissions(): Submission[] {
  return state.submissions
    .filter((submission) => {
      if (scope === 'mine') return submission.author_id === state.profile?.id
      if (scope === 'project') return submission.project_id === state.currentProjectId
      return true
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
}

function render(): void {
  if (!viewIsActive('reviews')) return
  const submissions = visibleSubmissions()

  const approved = submissions.filter((submission) => submission.status === 'approved')
  const pending = submissions.filter((submission) => submission.status === 'pending' || running.has(submission.id))
  const toFix = submissions.filter(
    (submission) => submission.status === 'changes_requested' || submission.status === 'rejected',
  )
  const scored = submissions.filter((submission) => typeof submission.score === 'number')
  const average = scored.length
    ? Math.round(scored.reduce((sum, submission) => sum + (submission.score ?? 0), 0) / scored.length)
    : 0

  $('#reviewMetrics').innerHTML = `
    <article class="metric glass"><small>Livraisons</small><strong>${submissions.length}</strong>
      <span class="metric-trend">${pending.length} en attente d'analyse</span></article>
    <article class="metric glass"><small>Conformes</small><strong>${approved.length}</strong>
      <span class="metric-trend up">${submissions.length ? Math.round((approved.length / submissions.length) * 100) : 0} % du total</span></article>
    <article class="metric glass"><small>À corriger</small><strong>${toFix.length}</strong>
      <span class="metric-trend${toFix.length ? ' down' : ''}">retours en attente de reprise</span></article>
    <article class="metric glass"><small>Score moyen</small><strong>${average || '—'}</strong>
      <span class="metric-trend">conformité au brief sur 100</span></article>`

  const list = $('#submissionList')

  if (!submissions.length) {
    list.innerHTML = emptyBlock(
      'ri-code-box-line',
      'Aucune livraison',
      "Quand une fonctionnalité est terminée, livre son code : il est confronté au brief et aux critères d'acceptation de la tâche.",
      false,
    )
    return
  }

  list.innerHTML = `<div class="submission-list">${submissions.map(card).join('')}</div>`

  $$('[data-submission]', list).forEach((node) => {
    node.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).closest('[data-act]')) return
      openSubmissionDetail(node.dataset.submission as string)
    })
    node.querySelector('[data-act="rerun"]')?.addEventListener('click', (event) => {
      event.stopPropagation()
      void runReview(node.dataset.submission as string)
    })
  })
}

function scoreColor(score: number): string {
  if (score >= 80) return 'var(--green)'
  if (score >= 55) return 'var(--amber)'
  return 'var(--red)'
}

function card(submission: Submission): string {
  const project = projectById(submission.project_id)
  const task = taskById(submission.task_id)
  const review = latestReview(submission.id)
  const status = SUBMISSION_STATUSES[submission.status] ?? SUBMISSION_STATUSES.pending
  const busy = running.has(submission.id) || submission.status === 'reviewing'
  const failed = review?.criteria.filter((criterion) => !criterion.met).length ?? 0

  return `
    <article class="submission-card glass" data-submission="${submission.id}">
      <div class="submission-head">
        <div>
          <h3>${escapeHtml(submission.title)}</h3>
          <p class="submission-sub">
            ${escapeHtml(project?.name ?? 'Projet supprimé')}
            ${task ? ` · [${escapeHtml(project?.code ?? '')}-${task.seq}] ${escapeHtml(task.title)}` : ''}
            · ${escapeHtml(personName(submission.author_id))} · ${relativeTime(submission.created_at)}
          </p>
        </div>
        ${
          busy
            ? '<span class="score-badge" style="--score-color:var(--blue)"><i class="ri-loader-4-line spinning"></i></span>'
            : typeof submission.score === 'number'
              ? `<span class="score-badge" style="--score-color:${scoreColor(submission.score)}">${submission.score}<small>/100</small></span>`
              : ''
        }
      </div>
      <div class="submission-meta">
        <span class="chip ${status.chip}">${busy ? 'Analyse en cours' : status.label}</span>
        <span class="chip muted">${escapeHtml(submission.language)}</span>
        ${submission.branch ? `<span class="chip muted"><i class="ri-git-branch-line"></i>${escapeHtml(submission.branch)}</span>` : ''}
        ${review ? `<span class="chip muted">${review.criteria.length - failed}/${review.criteria.length} critères remplis</span>` : ''}
        ${review && review.issues.length ? `<span class="chip amber">${review.issues.length} point(s) relevé(s)</span>` : ''}
        ${!busy ? '<button class="btn ghost small" type="button" data-act="rerun"><i class="ri-refresh-line"></i>Relancer l\'analyse</button>' : ''}
      </div>
    </article>`
}

/* ------------------------------------------------------- lancement de la revue */

export async function runReview(submissionId: string): Promise<void> {
  if (running.has(submissionId)) return
  running.add(submissionId)
  render()

  try {
    const { review } = await aiApi.review({ submissionId })
    upsertReview(review)

    // La fonction serverless a mis à jour la livraison, et parfois la tâche
    // (validée ou renvoyée au développeur) : on relit l'état réel plutôt que de
    // le deviner côté client.
    const refreshed = await api.getSubmission(submissionId)
    if (refreshed) upsertSubmission(refreshed)

    if (refreshed?.task_id) {
      const task = await api.getTask(refreshed.task_id)
      if (task) upsertTask(task)
    }

    const verdict = VERDICTS[review.verdict]
    toast(`${verdict.label} — ${review.score}/100.`, review.verdict === 'approved' ? 'info' : 'error')
    openSubmissionDetail(submissionId)
  } catch (error) {
    toast((error as Error).message, 'error')
  } finally {
    running.delete(submissionId)
    render()
  }
}

/* --------------------------------------------------------------- détail */

export function openSubmissionDetail(submissionId: string): void {
  const submission = state.submissions.find((entry) => entry.id === submissionId)
  if (!submission) return

  // Le code n'est pas chargé avec la liste (des fichiers entiers, par livraison) :
  // on le récupère à l'ouverture de la fiche, puis on la redessine.
  if (submission.code === undefined) {
    void api.getSubmission(submissionId).then((full) => {
      if (!full) return
      submission.code = full.code ?? ''
      // La fiche a pu être fermée ou remplacée entre-temps.
      if (state.submissions.find((entry) => entry.id === submissionId)) openSubmissionDetail(submissionId)
    })
  }

  const project = projectById(submission.project_id)
  const task = taskById(submission.task_id)
  const review = latestReview(submission.id)
  const verdict = review ? VERDICTS[review.verdict] : null
  const mine = submission.author_id === state.profile?.id
  const manager = canManage(submission.project_id)

  const severityColor = (severity: string): string =>
    severity === 'critical' ? 'var(--red)' : severity === 'major' ? 'var(--amber)' : 'var(--muted)'

  const panel = openDrawer(`
    <div class="panel-head">
      <div>
        <p class="eyebrow">${escapeHtml(project?.name ?? '')}${task ? ` · ${escapeHtml(project?.code ?? '')}-${task.seq}` : ''}</p>
        <h2>${escapeHtml(submission.title)}</h2>
        <p>${escapeHtml(personName(submission.author_id))} · ${formatDateTime(submission.created_at)}</p>
      </div>
      <button class="icon-btn" type="button" data-close-drawer aria-label="Fermer"><i class="ri-close-line"></i></button>
    </div>

    <div class="submission-meta" style="margin-bottom:16px">
      <span class="chip ${(SUBMISSION_STATUSES[submission.status] ?? SUBMISSION_STATUSES.pending).chip}">${
        (SUBMISSION_STATUSES[submission.status] ?? SUBMISSION_STATUSES.pending).label
      }</span>
      <span class="chip muted">${escapeHtml(submission.language)}</span>
      ${submission.branch ? `<span class="chip muted"><i class="ri-git-branch-line"></i>${escapeHtml(submission.branch)}</span>` : ''}
      ${
        submission.repo_url
          ? `<a class="chip" href="${escapeHtml(submission.repo_url)}" target="_blank" rel="noopener"><i class="ri-external-link-line"></i>Voir la PR</a>`
          : ''
      }
    </div>

    ${
      submission.notes
        ? `<p class="section-title">Note du développeur</p><p class="selectable" style="font-size:11.5px;line-height:1.7;margin:0 0 6px">${escapeHtml(submission.notes)}</p>`
        : ''
    }

    ${
      review && verdict
        ? `<div class="review-block">
             <div class="review-verdict">
               <i class="${verdict.icon}" style="color:var(--${verdict.chip === '' ? 'blue' : verdict.chip})"></i>
               <div>
                 <b>${verdict.label}</b>
                 <span class="muted" style="display:block;font-size:10px">Score de conformité ${review.score}/100 · ${escapeHtml(review.model)} · ${relativeTime(review.created_at)}</span>
               </div>
             </div>
             <p class="review-summary selectable">${escapeHtml(review.summary)}</p>

             ${
               review.criteria.length
                 ? `<p class="section-title" style="margin-top:0">Critères d'acceptation</p>
                    <div class="criteria-list">
                      ${review.criteria
                        .map(
                          (criterion) => `
                        <div class="criterion ${criterion.met ? 'done' : 'failed'}">
                          <i class="${criterion.met ? 'ri-checkbox-circle-fill' : 'ri-close-circle-fill'}"></i>
                          <div>
                            <span>${escapeHtml(criterion.criterion)}</span>
                            ${criterion.comment ? `<small>${escapeHtml(criterion.comment)}</small>` : ''}
                          </div>
                        </div>`,
                        )
                        .join('')}
                    </div>`
                 : ''
             }

             ${
               review.issues.length
                 ? `<p class="section-title">Points relevés</p>
                    <div class="issue-list">
                      ${review.issues
                        .map(
                          (issue) => `
                        <div class="issue" style="--issue-color:${severityColor(issue.severity)}">
                          <b>${escapeHtml(issue.title)}</b>
                          <p>${escapeHtml(issue.detail)}</p>
                          ${issue.location ? `<span class="issue-loc">${escapeHtml(issue.location)}</span>` : ''}
                        </div>`,
                        )
                        .join('')}
                    </div>`
                 : ''
             }

             ${
               review.suggestions.length
                 ? `<p class="section-title">Pistes d'amélioration</p>
                    <ul class="suggestion-list">${review.suggestions.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
                 : ''
             }
           </div>`
        : `<div class="empty compact"><div><i class="ri-scan-line"></i><b>Pas encore analysée</b><span>Lance la revue pour confronter ce code au brief.</span></div></div>`
    }

    <div class="form-actions" style="justify-content:flex-start">
      <button class="btn primary" type="button" id="rerunReview"><i class="ri-refresh-line"></i>${review ? 'Relancer l\'analyse' : 'Lancer l\'analyse'}</button>
      ${mine ? '<button class="btn" type="button" id="resubmit"><i class="ri-upload-cloud-2-line"></i>Livrer une nouvelle version</button>' : ''}
      ${mine || manager ? '<button class="btn danger" type="button" id="deleteSubmission"><i class="ri-delete-bin-line"></i>Supprimer</button>' : ''}
    </div>

    <p class="section-title">Code livré</p>
    <pre class="code-block selectable"><code>${
      submission.code === undefined ? 'Chargement du code…' : escapeHtml(submission.code)
    }</code></pre>`)

  $('#rerunReview', panel).addEventListener('click', () => {
    closeDrawer()
    void runReview(submission.id)
  })

  panel.querySelector('#resubmit')?.addEventListener('click', () => {
    closeDrawer()
    openSubmissionForm(submission.task_id ?? undefined)
  })

  panel.querySelector('#deleteSubmission')?.addEventListener('click', async () => {
    if (!(await confirmAction('Supprimer cette livraison ?', 'La revue associée sera également supprimée.', 'Supprimer')))
      return
    try {
      await api.deleteSubmission(submission.id)
      state.submissions = state.submissions.filter((entry) => entry.id !== submission.id)
      state.reviews = state.reviews.filter((entry) => entry.submission_id !== submission.id)
      closeDrawer()
      notify()
      toast('Livraison supprimée.')
    } catch (error) {
      toast((error as Error).message, 'error')
    }
  })
}
