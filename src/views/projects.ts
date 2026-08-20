import { openProjectForm } from '../forms.js'
import {
  canManage,
  isManager,
  latestBrief,
  personName,
  progressOf,
  projectTeam,
  setCurrentProject,
  state,
  subscribe,
} from '../store.js'
import type { Project } from '../types.js'
import {
  $,
  $$,
  colorVar,
  debounce,
  emptyBlock,
  escapeHtml,
  formatDate,
  initialsOf,
  PROJECT_STATUSES,
  viewIsActive,
} from '../ui.js'

/** Portefeuille de projets accessibles au compte connecté. */

let search = ''

export function initProjects(onNavigate: (view: string) => void): void {
  navigate = onNavigate
  const runSearch = debounce((value: string) => {
    search = value
    render()
  })
  $<HTMLInputElement>('#projectSearch').addEventListener('input', (event) => {
    runSearch((event.target as HTMLInputElement).value.toLowerCase())
  })
  subscribe(render)
}

let navigate: (view: string) => void = () => {}

function render(): void {
  if (!viewIsActive('projects')) return
  const node = $('#projectGrid')

  const projects = state.projects.filter((project) => {
    if (!search) return true
    return `${project.name} ${project.code} ${project.client} ${project.stack.join(' ')}`.toLowerCase().includes(search)
  })

  if (!projects.length) {
    node.innerHTML = emptyBlock(
      'ri-folder-line',
      search ? 'Aucun résultat' : 'Aucun projet',
      isManager()
        ? 'Crée un projet, rédige son brief, puis affecte ton équipe.'
        : "Tu n'es affecté à aucun projet pour l'instant. Un manager doit t'ajouter à son équipe.",
      false,
    )
    return
  }

  node.innerHTML = `<div class="project-grid">${projects.map(card).join('')}</div>`

  $$('[data-project]', node).forEach((element) => {
    element.addEventListener('click', (event) => {
      const id = element.dataset.project as string
      if ((event.target as HTMLElement).closest('[data-act="edit"]')) {
        openProjectForm(state.projects.find((project) => project.id === id))
        return
      }
      setCurrentProject(id)
      navigate('brief')
    })
  })
}

function card(project: Project): string {
  const progress = progressOf(project.id)
  const team = projectTeam(project.id)
  const status = PROJECT_STATUSES[project.status]
  const brief = latestBrief(project.id)
  const late = project.due_date && new Date(project.due_date) < new Date() && project.status === 'active'

  return `
    <article class="project-card glass" data-project="${project.id}" style="--accent:${colorVar(project.color)}">
      <header>
        <div>
          <span class="project-code">${escapeHtml(project.code)}${project.client ? ` · ${escapeHtml(project.client)}` : ''}</span>
          <h3>${escapeHtml(project.name)}</h3>
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          <span class="chip ${status.chip}">${status.label}</span>
          ${canManage(project.id) ? '<button class="icon-btn" type="button" data-act="edit" aria-label="Modifier" style="width:28px;height:28px;font-size:13px"><i class="ri-settings-3-line"></i></button>' : ''}
        </div>
      </header>

      <p>${escapeHtml(project.summary || 'Aucun résumé pour ce projet.')}</p>

      <div class="progress-track"><div class="progress-fill" style="width:${progress.percent}%;background:${colorVar(project.color)}"></div></div>
      <div style="display:flex;justify-content:space-between;font-size:9px" class="muted">
        <span>${progress.done}/${progress.total} tâches · ${progress.percent} %</span>
        <span>${progress.blocked ? `${progress.blocked} bloquée(s)` : ''}</span>
      </div>

      <div class="submission-meta" style="margin-top:0">
        <span class="chip ${brief ? 'muted' : 'amber'}">${brief ? `Brief v${brief.version}` : 'Brief manquant'}</span>
        ${project.brief_pdf_url ? `<a class="chip violet" href="${project.brief_pdf_url}" target="_blank" rel="noopener" onclick="event.stopPropagation()" style="text-decoration:none;cursor:pointer" title="${escapeHtml(project.brief_pdf_name ?? 'PDF Brief')}"><i class="ri-file-pdf-2-line"></i>PDF Brief</a>` : ''}
        <span class="chip ${late ? 'red' : 'muted'}">${project.due_date ? formatDate(project.due_date) : 'sans échéance'}</span>
        ${project.stack.slice(0, 2).map((tech) => `<span class="chip muted">${escapeHtml(tech)}</span>`).join('')}
      </div>

      <div class="project-foot">
        <div class="avatar-stack">
          ${team
            .slice(0, 5)
            .map((person) => {
              const name = person.full_name || person.email
              return `<span class="avatar" title="${escapeHtml(name)}">${escapeHtml(initialsOf(name))}</span>`
            })
            .join('') || '<span class="muted" style="font-size:9px">Aucun membre</span>'}
          ${team.length > 5 ? `<span class="avatar muted">+${team.length - 5}</span>` : ''}
        </div>
        <span class="muted" style="font-size:9px">Manager : ${escapeHtml(personName(project.manager_id))}</span>
      </div>
    </article>`
}
