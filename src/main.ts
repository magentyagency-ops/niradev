import { api } from './api.js'
import { currentProfile, onAuthChange, sendPasswordReset, signIn, signOut, updateOwnPassword } from './auth.js'
import { initDrawer } from './drawer.js'
import { openProfileForm, openProjectForm, openSubmissionForm, openTaskForm } from './forms.js'
import { closeModal, initOverlays, openModal } from './modal.js'
import {
  hydrate,
  isAdmin,
  isManager,
  notify,
  progressOf,
  setCurrentProject,
  state,
  subscribe,
} from './store.js'
import type { Theme } from './types.js'
import { $, $$, colorVar, escapeHtml, initialsOf, toast, unchanged } from './ui.js'
import { initAdmin, loadAccounts } from './views/admin.js'
import { initAssistant } from './views/assistant.js'
import { initBoard } from './views/board.js'
import { initBrief } from './views/brief.js'
import { initDashboard } from './views/dashboard.js'
import { initProjects } from './views/projects.js'
import { initReviews } from './views/reviews.js'
import { initTasks } from './views/tasks.js'

const VIEWS = ['dashboard', 'brief', 'projects', 'board', 'tasks', 'reviews', 'assistant', 'admin']

/* ------------------------------------------------------------ navigation */

function showView(view: string): void {
  // La vue d'administration n'existe que pour les comptes admin.
  const target = view === 'admin' && !isAdmin() ? 'dashboard' : VIEWS.includes(view) ? view : 'dashboard'
  $$('.nav-btn').forEach((button) => button.classList.toggle('active', button.dataset.view === target))
  $$('.view').forEach((section) => section.classList.toggle('active', section.id === `view-${target}`))
  window.location.hash = target
  // La vue qui vient d'apparaître n'a pas été rendue pendant qu'elle était masquée.
  notify()
}

function initNavigation(): void {
  $$('.nav-btn').forEach((button) => {
    button.addEventListener('click', () => showView(button.dataset.view as string))
  })

  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement

    const go = target.closest<HTMLElement>('[data-go]')
    if (go) showView(go.dataset.go as string)

    const action = target.closest<HTMLElement>('[data-action]')?.dataset.action
    if (action === 'new-project') openProjectForm()
    if (action === 'new-task') openTaskForm()
    if (action === 'new-submission') openSubmissionForm()
  })

  window.addEventListener('hashchange', () => {
    const view = window.location.hash.replace('#', '')
    if (VIEWS.includes(view)) showView(view)
  })

  const initial = window.location.hash.replace('#', '')
  if (VIEWS.includes(initial)) showView(initial)
}

/* -------------------------------------------------- sélecteur de projet */

function initProjectSwitch(): void {
  const wrap = $('#projectSwitch')

  $('#projectSwitchToggle').addEventListener('click', (event) => {
    event.stopPropagation()
    wrap.classList.toggle('open')
  })

  document.addEventListener('click', (event) => {
    if (!wrap.contains(event.target as Node)) wrap.classList.remove('open')
  })

  subscribe(renderProjectSwitch)
}

function renderProjectSwitch(): void {
  const current = state.projects.find((project) => project.id === state.currentProjectId)

  // Ce sélecteur est le seul élément redessiné hors de la vue active : il est
  // donc reconstruit à chaque mutation, alors qu'il ne change presque jamais.
  const signature = JSON.stringify([
    state.currentProjectId,
    state.projects.map((project) => [project.id, project.name, project.code, project.client, project.color]),
    state.tasks.map((task) => task.project_id + task.status),
  ])
  if (unchanged('project-switch', signature)) return

  $('#projectSwitchName').textContent = current?.name ?? 'Aucun projet'
  $('#projectSwitchMeta').textContent = current ? `${current.code} · ${progressOf(current.id).percent} %` : '—'
  $('#projectSwitchDot').style.background = current ? colorVar(current.color) : 'var(--muted)'

  const list = $('#projectSwitchList')
  list.innerHTML = state.projects.length
    ? state.projects
        .map((project) => {
          const progress = progressOf(project.id)
          return `
          <button class="switch-item${project.id === state.currentProjectId ? ' active' : ''}" type="button" data-project="${project.id}">
            <span class="project-dot" style="background:${colorVar(project.color)}"></span>
            <span><b>${escapeHtml(project.name)}</b><small>${escapeHtml(project.code)}${project.client ? ` · ${escapeHtml(project.client)}` : ''}</small></span>
            <span class="switch-progress">${progress.percent} %</span>
          </button>`
        })
        .join('')
    : '<p class="muted" style="font-size:10px;margin:0 3px 8px">Aucun projet accessible.</p>'

  $$('[data-project]', list).forEach((button) => {
    button.addEventListener('click', () => {
      setCurrentProject(button.dataset.project as string)
      $('#projectSwitch').classList.remove('open')
    })
  })
}

/* ---------------------------------------------------------------- thèmes */

function applyTheme(theme: Theme): void {
  document.body.dataset.theme = theme
  $$('.theme-option').forEach((option) => option.classList.toggle('active', option.dataset.theme === theme))
}

function initTheme(): void {
  const wrap = $('#themeWrap')

  $('#themeToggle').addEventListener('click', (event) => {
    event.stopPropagation()
    wrap.classList.toggle('open')
  })

  document.addEventListener('click', (event) => {
    if (!wrap.contains(event.target as Node)) wrap.classList.remove('open')
  })

  $$('.theme-option').forEach((option) => {
    option.addEventListener('click', () => {
      const theme = option.dataset.theme as Theme
      state.theme = theme
      applyTheme(theme)
      wrap.classList.remove('open')
      // Le thème reste appliqué localement même si l'enregistrement échoue.
      void api.saveTheme(theme)
    })
  })
}

/* ------------------------------------------------------------- raccourcis */

function initShortcuts(): void {
  document.addEventListener('keydown', (event) => {
    const editing = ['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement)?.tagName)
    if (editing || event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key === 'n' && isManager()) {
      event.preventDefault()
      openTaskForm()
    }
    if (event.key === 'l') {
      event.preventDefault()
      openSubmissionForm()
    }
    if (event.key === 'a') {
      event.preventDefault()
      showView('assistant')
    }
  })
}

/* ------------------------------------------------------------ connexion */

function showAuthScreen(message?: string): void {
  $('#authScreen').hidden = false
  $('#app').hidden = true
  const error = $('#authError')
  // Sans message explicite on laisse l'erreur en place : un rappel de l'écran de
  // connexion ne doit pas effacer la raison de l'échec précédent.
  if (message === undefined) return
  error.hidden = !message
  error.textContent = message
}

function initLogin(): void {
  const form = $<HTMLFormElement>('#loginForm')

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')
    const data = new FormData(form)
    if (submit) submit.disabled = true
    try {
      await signIn(String(data.get('email') ?? ''), String(data.get('password') ?? ''))
      $('#authError').hidden = true
      await start()
    } catch (error) {
      showAuthScreen((error as Error).message)
    } finally {
      if (submit) submit.disabled = false
    }
  })

  $('#resetPassword').addEventListener('click', async () => {
    const email = $<HTMLInputElement>('#loginEmail').value.trim()
    if (!email) {
      showAuthScreen("Saisis d'abord ton email, le lien de réinitialisation y sera envoyé.")
      return
    }
    try {
      await sendPasswordReset(email)
      toast('Email de réinitialisation envoyé.')
    } catch (error) {
      showAuthScreen((error as Error).message)
    }
  })
}

/* --------------------------------------------------------- menu du compte */

function initAccountMenu(): void {
  const wrap = $('#accountWrap')

  $('#accountToggle').addEventListener('click', (event) => {
    event.stopPropagation()
    wrap.classList.toggle('open')
  })

  document.addEventListener('click', (event) => {
    if (!wrap.contains(event.target as Node)) wrap.classList.remove('open')
  })

  $('#signOut').addEventListener('click', async () => {
    await signOut()
    window.location.reload()
  })

  $('#editProfile').addEventListener('click', () => {
    wrap.classList.remove('open')
    openProfileForm()
  })

  $('#changePassword').addEventListener('click', () => {
    wrap.classList.remove('open')
    const panel = openModal(`
      <form id="passwordForm">
        <div class="panel-head">
          <div><h2>Changer mon mot de passe</h2><p>Il remplace immédiatement l'ancien.</p></div>
          <button class="icon-btn" type="button" data-close-modal aria-label="Fermer"><i class="ri-close-line"></i></button>
        </div>
        <div class="field-group"><label for="p-new">Nouveau mot de passe</label>
          <input class="field" id="p-new" name="password" type="password" required minlength="8" placeholder="8 caractères minimum"></div>
        <div class="form-actions">
          <button class="btn" type="button" data-close-modal>Annuler</button>
          <button class="btn primary" type="submit"><i class="ri-check-line"></i>Enregistrer</button>
        </div>
      </form>`)

    $<HTMLFormElement>('#passwordForm', panel).addEventListener('submit', async (event) => {
      event.preventDefault()
      try {
        await updateOwnPassword($<HTMLInputElement>('#p-new', panel).value)
        closeModal()
        toast('Mot de passe mis à jour.')
      } catch (error) {
        toast((error as Error).message, 'error')
      }
    })
  })
}

const ROLE_LABELS: Record<string, string> = {
  admin: 'Administrateur',
  manager: 'Manager de projet',
  dev: 'Développeur',
}

function renderAccount(): void {
  const profile = state.profile
  if (!profile) return
  const name = profile.full_name || profile.email
  $('#accountAvatar').textContent = initialsOf(name)
  $('#accountName').textContent = name
  $('#accountRole').textContent = ROLE_LABELS[profile.dev_role] ?? 'Développeur'
  $('#accountEmail').textContent = profile.email

  $$('.admin-only').forEach((node) => {
    node.hidden = profile.dev_role !== 'admin'
  })
  $$('.manager-only').forEach((node) => {
    node.hidden = !isManager()
  })
  // Un manager livre rarement du code lui-même : le bouton reste accessible,
  // mais ce n'est pas son action principale sur le tableau de bord.
  $$('.dev-only').forEach((node) => {
    node.hidden = isManager()
  })
}

/* -------------------------------------------------------------- démarrage */

let starting = false

async function start(): Promise<void> {
  // signIn() déclenche aussi l'événement SIGNED_IN : on évite le double chargement.
  if (starting) return
  starting = true
  try {
    await load()
  } finally {
    starting = false
  }
}

async function load(): Promise<void> {
  let profile
  try {
    profile = await currentProfile()
  } catch (error) {
    console.error('[nira-dev] démarrage interrompu', error)
    showAuthScreen((error as Error).message)
    return
  }

  if (!profile) {
    showAuthScreen(undefined)
    return
  }

  $('#authScreen').hidden = true
  $('#app').hidden = false

  try {
    const loaded = await api.loadState()
    hydrate(loaded)
    applyTheme(loaded.theme)
    renderAccount()
    if (isAdmin()) void loadAccounts()
  } catch (error) {
    console.error('[nira-dev] chargement des données', error)
    toast(`Chargement impossible : ${(error as Error).message}`, 'error')
  }
}

async function boot(): Promise<void> {
  initOverlays()
  initNavigation()
  initProjectSwitch()
  initTheme()
  initShortcuts()
  initLogin()
  initAccountMenu()
  initDrawer()
  initDashboard(showView)
  initProjects(showView)
  initBrief()
  initBoard()
  initTasks()
  initReviews()
  initAssistant()
  initAdmin(showView)

  onAuthChange(() => void start())
  await start()
}

void boot()
