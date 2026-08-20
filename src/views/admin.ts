import { adminApi, type Account } from '../adminApi.js'
import { closeModal, confirmAction, openModal } from '../modal.js'
import { isAdmin, setAssigneeFilter, subscribe } from '../store.js'
import type { DevRole } from '../types.js'
import {
  $,
  $$,
  emptyBlock,
  escapeHtml,
  formatDate,
  initialsOf,
  relativeTime,
  toast,
  viewIsActive,
} from '../ui.js'

/**
 * Administration des comptes.
 *
 * Réservée au rôle admin : lui seul crée les accès et désigne les managers de
 * projet. Un admin est manager par défaut sur tous les projets.
 */

let accounts: Account[] = []
let loading = false
let loadError = ''

const ROLE_LABELS: Record<DevRole, { label: string; chip: string; hint: string }> = {
  admin: { label: 'Admin', chip: 'violet', hint: 'gère les comptes, voit tous les projets' },
  manager: { label: 'Manager', chip: '', hint: 'crée les projets, rédige les briefs, assigne les tâches' },
  dev: { label: 'Développeur', chip: 'muted', hint: 'voit les projets sur lesquels il est affecté' },
}

export function initAdmin(onNavigate: (view: string) => void): void {
  navigate = onNavigate

  $('#refreshAccounts').addEventListener('click', () => void loadAccounts())

  document.addEventListener('click', (event) => {
    const action = (event.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action
    if (action === 'new-account') openAccountForm()
  })

  subscribe(() => {
    if (isAdmin() && !accounts.length && !loading && !loadError) void loadAccounts()
    render()
  })
}

let navigate: (view: string) => void = () => {}

export async function loadAccounts(): Promise<void> {
  if (!isAdmin()) return
  loading = true
  loadError = ''
  render()
  try {
    accounts = (await adminApi.list()).accounts
  } catch (error) {
    loadError = (error as Error).message
  } finally {
    loading = false
    render()
  }
}

function render(): void {
  if (!isAdmin() || !viewIsActive('admin')) return
  renderMetrics()
  renderList()
}

function renderMetrics(): void {
  const active = accounts.filter((account) => account.active && account.dev_access)
  const managers = accounts.filter((account) => account.dev_role !== 'dev')
  const tasks = accounts.reduce((sum, account) => sum + account.stats.tasks, 0)
  const done = accounts.reduce((sum, account) => sum + account.stats.done, 0)

  $('#adminMetrics').innerHTML = `
    <article class="metric glass"><small>Comptes</small><strong>${accounts.length}</strong>
      <span class="metric-trend">${active.length} actif(s) · ${managers.length} manager(s)</span></article>
    <article class="metric glass"><small>Tâches suivies</small><strong>${tasks}</strong>
      <span class="metric-trend">toutes équipes confondues</span></article>
    <article class="metric glass"><small>Terminées</small><strong>${done}</strong>
      <span class="metric-trend up">${tasks ? Math.round((done / tasks) * 100) : 0} % du total</span></article>
    <article class="metric glass"><small>Livraisons validées</small><strong>${accounts.reduce(
      (sum, account) => sum + account.stats.approved,
      0,
    )}</strong>
      <span class="metric-trend">code conforme au brief</span></article>`
}

function renderList(): void {
  const node = $('#accountList')

  if (loading && !accounts.length) {
    node.innerHTML = emptyBlock('ri-loader-4-line', 'Chargement des comptes…', "Interrogation de l'API d'administration.")
    return
  }

  if (loadError) {
    node.innerHTML = emptyBlock(
      'ri-error-warning-line',
      'Administration indisponible',
      `${loadError} — vérifie que SUPABASE_SERVICE_ROLE_KEY est bien défini côté serveur.`,
    )
    return
  }

  if (!accounts.length) {
    node.innerHTML = emptyBlock('ri-team-line', 'Aucun compte', 'Crée le premier accès de ton équipe.')
    return
  }

  node.innerHTML = `<div class="member-list">${accounts
    .map((account) => {
      const name = account.full_name || account.email
      const role = ROLE_LABELS[account.dev_role] ?? ROLE_LABELS.dev
      const disabled = !account.active || !account.dev_access
      return `
      <article class="member-card${disabled ? ' inactive' : ''}" data-account="${account.id}">
        <span class="avatar lg">${escapeHtml(initialsOf(name))}</span>
        <div class="member-identity">
          <b>${escapeHtml(name)}
            <span class="chip ${role.chip}">${role.label}</span>
            ${disabled ? '<span class="chip red">Accès révoqué</span>' : ''}
          </b>
          <span>${escapeHtml(account.email)}${account.job_title ? ` · ${escapeHtml(account.job_title)}` : ''} · créé le ${formatDate(account.created_at)}</span>
        </div>
        <div class="member-stats">
          <div><small>Projets</small><b>${account.stats.projects}</b></div>
          <div><small>Tâches</small><b>${account.stats.tasks} <span class="muted" style="font-size:9px;font-weight:500">(${account.stats.in_progress} en cours)</span></b></div>
          <div><small>Livraisons</small><b>${account.stats.submissions} <span class="muted" style="font-size:9px;font-weight:500">(${account.stats.approved} ok)</span></b></div>
          <div><small>Dernière activité</small><b>${account.stats.last_activity ? relativeTime(account.stats.last_activity) : '—'}</b></div>
        </div>
        <div class="member-actions">
          <button class="btn" type="button" data-act="tasks"><i class="ri-list-check-3"></i>Ses tâches</button>
          <button class="btn" type="button" data-act="edit"><i class="ri-settings-3-line"></i>Gérer</button>
        </div>
      </article>`
    })
    .join('')}</div>`

  $$('[data-account]', node).forEach((card) => {
    const account = accounts.find((entry) => entry.id === card.dataset.account)
    if (!account) return
    card.querySelector('[data-act="tasks"]')?.addEventListener('click', () => {
      setAssigneeFilter(account.id)
      navigate('board')
      toast(`Board filtré sur ${account.full_name || account.email}.`)
    })
    card.querySelector('[data-act="edit"]')?.addEventListener('click', () => openAccountForm(account))
  })
}

/* -------------------------------------------------------- création / édition */

export function openAccountForm(account?: Account): void {
  const isEdit = Boolean(account)

  const panel = openModal(`
    <form id="accountForm">
      <div class="panel-head">
        <div>
          <h2>${isEdit ? 'Gérer le compte' : 'Nouveau compte'}</h2>
          <p>${
            isEdit
              ? "Modifie le rôle, réinitialise le mot de passe ou révoque l'accès."
              : 'Le compte est créé immédiatement et peut se connecter avec ce mot de passe.'
          }</p>
        </div>
        <button class="icon-btn" type="button" data-close-modal aria-label="Fermer"><i class="ri-close-line"></i></button>
      </div>
      <div class="form-grid">
        <div class="field-group"><label for="a-name">Nom</label>
          <input class="field" id="a-name" name="full_name" value="${escapeHtml(account?.full_name ?? '')}" placeholder="Camille Durand"></div>
        <div class="field-group"><label for="a-email">Email</label>
          <input class="field" id="a-email" name="email" type="email" ${isEdit ? 'disabled' : 'required'} value="${escapeHtml(account?.email ?? '')}" placeholder="camille@nira-ia.com"></div>
        <div class="field-group"><label for="a-title">Intitulé de poste</label>
          <input class="field" id="a-title" name="job_title" value="${escapeHtml(account?.job_title ?? '')}" placeholder="Développeuse back-end"></div>
        <div class="field-group"><label for="a-role">Rôle</label>
          <select class="field" id="a-role" name="dev_role" style="width:100%">
            ${(Object.keys(ROLE_LABELS) as DevRole[])
              .map(
                (role) =>
                  `<option value="${role}"${(account?.dev_role ?? 'dev') === role ? ' selected' : ''}>${ROLE_LABELS[role].label} — ${ROLE_LABELS[role].hint}</option>`,
              )
              .join('')}
          </select></div>
        <div class="field-group"><label for="a-password">${isEdit ? 'Nouveau mot de passe (optionnel)' : 'Mot de passe'}</label>
          <input class="field" id="a-password" name="password" type="text" ${isEdit ? '' : 'required'} minlength="8" placeholder="8 caractères minimum"></div>
        ${
          isEdit
            ? `<div class="field-group"><label for="a-access">Accès</label>
                 <select class="field" id="a-access" name="dev_access" style="width:100%">
                   <option value="true"${account?.dev_access ? ' selected' : ''}>Actif</option>
                   <option value="false"${account?.dev_access ? '' : ' selected'}>Révoqué — connexion refusée</option>
                 </select></div>`
            : ''
        }
      </div>
      <div class="form-actions">
        ${isEdit ? '<button class="btn danger spacer" type="button" id="deleteAccount"><i class="ri-delete-bin-line"></i>Supprimer le compte</button>' : ''}
        <button class="btn" type="button" data-close-modal>Annuler</button>
        <button class="btn primary" type="submit"><i class="ri-check-line"></i>${isEdit ? 'Enregistrer' : 'Créer le compte'}</button>
      </div>
    </form>`)

  const form = $<HTMLFormElement>('#accountForm', panel)

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const data = new FormData(form)
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')
    if (submit) submit.disabled = true

    try {
      if (account) {
        await adminApi.update({
          id: account.id,
          full_name: String(data.get('full_name') ?? '').trim(),
          job_title: String(data.get('job_title') ?? '').trim(),
          dev_role: data.get('dev_role') as DevRole,
          dev_access: String(data.get('dev_access') ?? 'true') === 'true',
          password: String(data.get('password') ?? '') || undefined,
        })
        toast('Compte mis à jour.')
      } else {
        await adminApi.create({
          email: String(data.get('email') ?? ''),
          password: String(data.get('password') ?? ''),
          full_name: String(data.get('full_name') ?? '').trim(),
          job_title: String(data.get('job_title') ?? '').trim(),
          dev_role: data.get('dev_role') as DevRole,
        })
        toast('Compte créé.')
      }
      closeModal()
      await loadAccounts()
    } catch (error) {
      toast((error as Error).message, 'error')
      if (submit) submit.disabled = false
    }
  })

  panel.querySelector('#deleteAccount')?.addEventListener('click', async () => {
    if (!account) return
    const ok = await confirmAction(
      `Supprimer le compte ${account.full_name || account.email} ?`,
      `Ses ${account.stats.tasks} tâche(s) et les projets qu'il gère seront transférés à ton compte administrateur.`,
      'Supprimer le compte',
    )
    if (!ok) return
    try {
      await adminApi.remove({ id: account.id })
      closeModal()
      toast('Compte supprimé, son travail a été transféré.')
      await loadAccounts()
    } catch (error) {
      toast((error as Error).message, 'error')
    }
  })
}
