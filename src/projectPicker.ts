import { colorVar, escapeHtml } from './ui.js'
import { progressOf, setCurrentProject, state, subscribe } from './store.js'
import type { Project } from './types.js'

export interface ProjectPickerOptions {
  containerId: string
  allowAll?: boolean
  allLabel?: string
  allowMine?: boolean
  mineLabel?: string
  getSelectedId?: () => string | null
  onSelect?: (projectId: string | null) => void
}

/**
 * Composant de sélection de projet réutilisable, intégré dans l'en-tête de chaque section.
 * Se met à jour automatiquement via le store et permet un changement instantané de projet.
 */
export function setupSectionProjectPicker(options: ProjectPickerOptions): () => void {
  const host = document.getElementById(options.containerId)
  if (!host) return () => {}

  let isOpen = false

  function toggle(open?: boolean): void {
    const el = document.getElementById(options.containerId)
    isOpen = open !== undefined ? open : !isOpen
    el?.classList.toggle('open', isOpen)
  }

  function render(): void {
    const el = document.getElementById(options.containerId)
    if (!el) return

    const selectedId = options.getSelectedId ? options.getSelectedId() : state.currentProjectId
    const projects = state.projects

    let currentLabel = 'Aucun projet'
    let currentDotColor = 'var(--muted)'
    let currentCode = ''

    if (selectedId === 'all') {
      currentLabel = options.allLabel ?? 'Tous les projets'
      currentDotColor = 'var(--blue)'
    } else if (selectedId === 'mine') {
      currentLabel = options.mineLabel ?? 'Mes projets / tâches'
      currentDotColor = 'var(--violet)'
    } else {
      const activeProj = projects.find((p) => p.id === selectedId)
      if (activeProj) {
        currentLabel = activeProj.name
        currentDotColor = colorVar(activeProj.color)
        currentCode = activeProj.code
      }
    }

    el.innerHTML = `
      <div class="section-picker-wrap">
        <button class="section-picker-btn" type="button" aria-expanded="${isOpen}">
          <span class="project-dot" style="background:${currentDotColor}"></span>
          <span class="picker-name" title="${escapeHtml(currentLabel)}">${escapeHtml(currentLabel)}</span>
          ${currentCode ? `<span class="picker-code">${escapeHtml(currentCode)}</span>` : ''}
          <i class="ri-arrow-down-s-line picker-arrow"></i>
        </button>
        <div class="section-picker-dropdown glass">
          <small class="picker-header">Sélectionner un projet</small>
          <div class="section-picker-list">
            ${
              options.allowAll
                ? `
              <button class="section-picker-item${selectedId === 'all' ? ' active' : ''}" type="button" data-value="all">
                <span class="project-dot" style="background:var(--blue)"></span>
                <span class="picker-item-details">
                  <b>${escapeHtml(options.allLabel ?? 'Tous les projets')}</b>
                  <small>Vue transversale</small>
                </span>
                <span class="picker-count">${projects.length}</span>
              </button>`
                : ''
            }
            ${
              options.allowMine
                ? `
              <button class="section-picker-item${selectedId === 'mine' ? ' active' : ''}" type="button" data-value="mine">
                <span class="project-dot" style="background:var(--violet)"></span>
                <span class="picker-item-details">
                  <b>${escapeHtml(options.mineLabel ?? 'Mes affectations')}</b>
                  <small>Assigné à moi</small>
                </span>
              </button>`
                : ''
            }
            ${
              projects.length
                ? projects
                    .map((p) => {
                      const prog = progressOf(p.id)
                      const isAct = p.id === selectedId
                      return `
                  <button class="section-picker-item${isAct ? ' active' : ''}" type="button" data-value="${p.id}">
                    <span class="project-dot" style="background:${colorVar(p.color)}"></span>
                    <span class="picker-item-details">
                      <b>${escapeHtml(p.name)}</b>
                      <small>${escapeHtml(p.code)}${p.client ? ` · ${escapeHtml(p.client)}` : ''}</small>
                    </span>
                    <span class="picker-progress">${prog.percent} %</span>
                  </button>`
                    })
                    .join('')
                : '<p class="muted" style="font-size:10px;padding:8px 10px;margin:0">Aucun projet accessible.</p>'
            }
          </div>
        </div>
      </div>
    `

    const btn = el.querySelector<HTMLButtonElement>('.section-picker-btn')
    btn?.addEventListener('click', (e) => {
      e.stopPropagation()
      toggle()
    })

    el.querySelectorAll<HTMLButtonElement>('.section-picker-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.stopPropagation()
        const val = item.dataset.value ?? null
        toggle(false)
        if (options.onSelect) {
          options.onSelect(val)
        } else {
          setCurrentProject(val)
        }
      })
    })
  }

  const onDocClick = (e: MouseEvent): void => {
    const el = document.getElementById(options.containerId)
    if (el && !el.contains(e.target as Node)) {
      toggle(false)
    }
  }

  document.addEventListener('click', onDocClick)
  subscribe(render)
  render()

  return () => {
    document.removeEventListener('click', onDocClick)
  }
}
