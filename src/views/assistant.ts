import { aiApi, type ChatTurn } from '../aiApi.js'
import { api } from '../api.js'
import { openTaskDetail } from '../drawer.js'
import { confirmAction } from '../modal.js'
import { setupSectionProjectPicker } from '../projectPicker.js'
import {
  currentProject,
  latestBrief,
  removeTask,
  setCurrentProject,
  state,
  subscribe,
  taskById,
  upsertTask,
} from '../store.js'
import type { ChatMessage, ChatMessageMeta, ChatSession, Task } from '../types.js'
import { $, escapeHtml, initialsOf, renderMarkdown, toast, viewIsActive } from '../ui.js'

/**
 * Assistant technique et chef de projet IA, présenté comme un chat classique :
 * plusieurs conversations par projet, historique persistant, actions sur le board.
 *
 * Les conversations sont privées à chaque compte et rattachées au projet
 * courant : changer de projet change la liste, ce qui évite de mélanger deux cadrages.
 */

let sessions: ChatSession[] = []
let activeSession: ChatSession | null = null
let messages: ChatMessage[] = []
let loadedProjectId: string | null | undefined
let sending = false
let searchTerm = ''
let renamingId: string | null = null
/** Id du message en cours d'affichage progressif (effet « frappe »). */
let revealingId: string | null = null

const SUGGESTIONS_WITH_BRIEF = [
  { icon: 'ri-add-box-line', title: 'Créer une tâche', text: 'Ajoute une tâche "Intégration du paiement Stripe" assignée à moi en priorité haute' },
  { icon: 'ri-file-list-3-line', title: 'Comprendre le brief', text: 'Que dit le brief sur ce que je dois livrer exactement ?' },
  { icon: 'ri-team-line', title: "État de l'équipe", text: "Fais-moi un point sur l'avancement des tâches de l'équipe" },
  { icon: 'ri-git-branch-line', title: 'Découper le projet', text: 'Propose et crée les 5 prochaines tâches prioritaires à partir du brief' },
]

const SUGGESTIONS_WITHOUT_BRIEF = [
  { icon: 'ri-add-box-line', title: 'Créer une tâche', text: 'Crée une tâche "Configuration de l\'environnement de dev" sur le board' },
  { icon: 'ri-stack-line', title: 'Architecture', text: 'Comment structurer ce projet techniquement ?' },
  { icon: 'ri-bug-line', title: 'Déboguer', text: 'Explique-moi cette erreur TypeScript : ' },
  { icon: 'ri-lightbulb-line', title: 'Bonnes pratiques', text: 'Quelles bonnes pratiques pour sécuriser une API REST ?' },
]

export function initAssistant(): void {
  setupSectionProjectPicker({
    containerId: 'assistantProjectPicker',
    getSelectedId: () => state.currentProjectId,
    onSelect: (id) => {
      if (id) setCurrentProject(id)
    },
  })

  const input = $<HTMLTextAreaElement>('#chatInput')

  $<HTMLFormElement>('#chatForm').addEventListener('submit', (event) => {
    event.preventDefault()
    void send(input.value)
  })
  input.addEventListener('input', () => {
    autosize()
    updateSendButton()
  })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      void send(input.value)
    }
  })

  $('#chatNew').addEventListener('click', () => newConversation())
  $('#chatSideOpen').addEventListener('click', () => toggleSidebar(true))
  $('#chatSideClose').addEventListener('click', () => toggleSidebar(false))
  $<HTMLInputElement>('#chatSearch').addEventListener('input', (event) => {
    searchTerm = (event.target as HTMLInputElement).value.trim().toLowerCase()
    renderSessions()
  })

  $('#chatSessions').addEventListener('click', (event) => void onSessionClick(event))
  $('#chatLog').addEventListener('click', (event) => void onLogClick(event))

  // Raccourci type ChatGPT : Ctrl/Cmd + Maj + O ouvre une nouvelle conversation.
  document.addEventListener('keydown', (event) => {
    if (!viewIsActive('assistant')) return
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'o') {
      event.preventDefault()
      newConversation()
    }
  })

  subscribe(() => {
    if (!viewIsActive('assistant')) return
    // La liste suit le projet sélectionné : on ne recharge que si celui-ci change.
    if (loadedProjectId !== state.currentProjectId) void loadSessions()
    else if (!sending && !revealingId) renderHeader()
  })
}

/* ---------------------------------------------------------------- données */

async function loadSessions(): Promise<void> {
  loadedProjectId = state.currentProjectId
  activeSession = null
  messages = []
  try {
    sessions = await api.listChatSessions(state.currentProjectId)
  } catch (error) {
    sessions = []
    toast((error as Error).message, 'error')
  }
  // On rouvre la dernière conversation, comme on la retrouverait dans un chat classique.
  if (sessions[0]) await openSession(sessions[0].id)
  else renderAll()
}

async function openSession(id: string): Promise<void> {
  const session = sessions.find((entry) => entry.id === id)
  if (!session) return
  activeSession = session
  revealingId = null
  renderAll()
  try {
    messages = await api.loadChat(session.id)
  } catch (error) {
    messages = []
    toast((error as Error).message, 'error')
  }
  if (activeSession?.id === id) renderAll()
  toggleSidebar(false)
}

function newConversation(): void {
  if (sending) return
  activeSession = null
  messages = []
  revealingId = null
  renderAll()
  toggleSidebar(false)
  $<HTMLTextAreaElement>('#chatInput').focus()
}

/* ------------------------------------------------------------------ rendu */

function renderAll(): void {
  if (!viewIsActive('assistant')) return
  renderSessions()
  renderHeader()
  renderLog()
  updateSendButton()
}

function renderHeader(): void {
  const project = currentProject()
  $('#chatTitle').textContent = activeSession?.title ?? 'Nouvelle conversation'
  $('#chatSubtitle').innerHTML = project
    ? `<i class="ri-folder-3-line"></i>${escapeHtml(project.name)}${latestBrief(project.id) ? ' · brief publié' : ' · pas de brief publié'}`
    : '<i class="ri-global-line"></i>Mode général · aucun projet'
}

function dayBucket(iso: string): string {
  const date = new Date(iso)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const diff = Math.floor((today.getTime() - new Date(date).setHours(0, 0, 0, 0)) / 86_400_000)
  if (diff <= 0) return "Aujourd'hui"
  if (diff === 1) return 'Hier'
  if (diff < 7) return '7 derniers jours'
  if (diff < 30) return '30 derniers jours'
  return date.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })
}

function renderSessions(): void {
  const host = $('#chatSessions')
  const visible = sessions.filter((session) => !searchTerm || session.title.toLowerCase().includes(searchTerm))

  if (!visible.length) {
    host.innerHTML = `<p class="ai-sessions-empty">${
      searchTerm ? 'Aucune conversation trouvée.' : 'Aucune conversation pour ce projet. Lance-toi !'
    }</p>`
    return
  }

  let lastBucket = ''
  host.innerHTML = visible
    .map((session) => {
      const bucket = dayBucket(session.updated_at)
      const heading = bucket !== lastBucket ? `<p class="ai-group">${escapeHtml(bucket)}</p>` : ''
      lastBucket = bucket
      const active = session.id === activeSession?.id ? ' active' : ''
      if (session.id === renamingId) {
        return `${heading}<div class="ai-session${active} renaming">
          <input class="ai-rename" data-rename="${session.id}" value="${escapeHtml(session.title)}" maxlength="80" />
        </div>`
      }
      return `${heading}<div class="ai-session${active}" data-session="${session.id}" title="${escapeHtml(session.title)}">
        <span>${escapeHtml(session.title)}</span>
        <div class="ai-session-actions">
          <button type="button" data-rename-start="${session.id}" aria-label="Renommer"><i class="ri-pencil-line"></i></button>
          <button type="button" data-delete="${session.id}" aria-label="Supprimer"><i class="ri-delete-bin-6-line"></i></button>
        </div>
      </div>`
    })
    .join('')

  const rename = host.querySelector<HTMLInputElement>('.ai-rename')
  if (rename) {
    rename.focus()
    rename.select()
    const commit = () => void commitRename(rename.dataset.rename as string, rename.value)
    rename.addEventListener('blur', commit, { once: true })
    rename.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') rename.blur()
      if (event.key === 'Escape') {
        rename.value = sessions.find((entry) => entry.id === renamingId)?.title ?? rename.value
        rename.blur()
      }
    })
  }
}

function welcome(): string {
  const project = currentProject()
  const firstName = (state.profile?.full_name || '').split(' ')[0]
  const suggestions = project && latestBrief(project.id) ? SUGGESTIONS_WITH_BRIEF : SUGGESTIONS_WITHOUT_BRIEF
  return `
    <div class="ai-welcome">
      <div class="ai-logo"><i class="ri-sparkling-2-fill"></i></div>
      <h2>${firstName ? `Bonjour ${escapeHtml(firstName)}, ` : ''}comment puis-je t'aider ?</h2>
      <p>${
        project
          ? `Je connais le brief, les tâches et l'équipe de <b>${escapeHtml(project.name)}</b>. Je peux aussi créer et mettre à jour des tâches directement sur le board.`
          : 'Aucun projet sélectionné : je réponds de façon générale. Choisis un projet dans la barre latérale pour que je m’appuie sur son brief et son board.'
      }</p>
      <div class="ai-suggestions">
        ${suggestions
          .map(
            (item) => `<button class="ai-suggestion" type="button" data-suggest="${escapeHtml(item.text)}">
              <i class="${item.icon}"></i><b>${escapeHtml(item.title)}</b><span>${escapeHtml(item.text)}</span>
            </button>`,
          )
          .join('')}
      </div>
    </div>`
}

function taskChip(entry: { id: string; seq: number; title: string }, verb: string, icon: string): string {
  const code = currentProject()?.code ?? 'PRJ'
  const exists = Boolean(taskById(entry.id))
  return `<button class="ai-task-chip${exists ? '' : ' gone'}" type="button" ${exists ? `data-task="${entry.id}"` : 'disabled'}>
    <i class="${icon}"></i><span class="ai-chip-verb">${verb}</span><b>${escapeHtml(code)}-${entry.seq}</b><span>${escapeHtml(entry.title)}</span>
  </button>`
}

function actionsBlock(meta?: ChatMessageMeta | null): string {
  if (!meta) return ''
  const chips = [
    ...(meta.created ?? []).map((entry) => taskChip(entry, 'Créée', 'ri-add-circle-line')),
    ...(meta.updated ?? []).map((entry) => taskChip(entry, 'Modifiée', 'ri-refresh-line')),
    ...(meta.deleted ?? []).map(
      (title) => `<span class="ai-task-chip gone"><i class="ri-delete-bin-line"></i><span class="ai-chip-verb">Supprimée</span><span>${escapeHtml(title)}</span></span>`,
    ),
  ]
  return chips.length ? `<div class="ai-task-chips">${chips.join('')}</div>` : ''
}

function messageHtml(message: ChatMessage, isLast: boolean): string {
  if (message.role === 'user') {
    const name = state.profile?.full_name || state.profile?.email || 'Moi'
    return `
      <article class="ai-msg user" data-id="${message.id}">
        <div class="ai-user-bubble">${escapeHtml(message.content).replace(/\n/g, '<br>')}</div>
        <span class="ai-avatar user">${escapeHtml(initialsOf(name))}</span>
      </article>`
  }
  const revealing = message.id === revealingId
  return `
    <article class="ai-msg assistant" data-id="${message.id}">
      <span class="ai-avatar"><i class="ri-sparkling-2-fill"></i></span>
      <div class="ai-body">
        <div class="ai-content">${revealing ? '' : renderMarkdown(message.content)}</div>
        ${revealing ? '' : actionsBlock(message.meta)}
        <div class="ai-tools${revealing ? ' hidden' : ''}">
          <button type="button" data-copy="${message.id}" title="Copier"><i class="ri-file-copy-line"></i></button>
          ${isLast ? `<button type="button" data-regenerate title="Régénérer"><i class="ri-restart-line"></i></button>` : ''}
        </div>
      </div>
    </article>`
}

function thinkingHtml(): string {
  return `
    <article class="ai-msg assistant">
      <span class="ai-avatar"><i class="ri-sparkling-2-fill"></i></span>
      <div class="ai-body"><div class="ai-thinking"><span></span><span></span><span></span><em>Nira réfléchit…</em></div></div>
    </article>`
}

function renderLog(pending = false): void {
  if (!viewIsActive('assistant')) return
  const log = $('#chatLog')
  const app = $('#aiApp')
  const empty = !messages.length && !pending
  app.classList.toggle('empty', empty)

  if (empty) {
    log.innerHTML = welcome()
    return
  }

  const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant')
  log.innerHTML = `<div class="ai-thread">${messages
    .map((message) => messageHtml(message, !pending && message.id === lastAssistant?.id && messages.at(-1)?.id === message.id))
    .join('')}${pending ? thinkingHtml() : ''}</div>`
  log.scrollTop = log.scrollHeight
}

/**
 * Affichage progressif de la réponse, pour retrouver la sensation d'un chat
 * qui « écrit ». Le texte complet est déjà là : on ne fait que le dévoiler.
 */
function reveal(message: ChatMessage): Promise<void> {
  revealingId = message.id
  renderLog()
  const log = $('#chatLog')
  const node = log.querySelector<HTMLElement>(`.ai-msg[data-id="${message.id}"] .ai-content`)
  if (!node || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    revealingId = null
    renderLog()
    return Promise.resolve()
  }
  const text = message.content
  const step = Math.max(3, Math.ceil(text.length / 160))
  let index = 0
  return new Promise((resolve) => {
    const tick = () => {
      if (revealingId !== message.id) return resolve()
      index = Math.min(text.length, index + step)
      const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80
      node.innerHTML = renderMarkdown(text.slice(0, index)) + (index < text.length ? '<span class="ai-caret"></span>' : '')
      if (nearBottom) log.scrollTop = log.scrollHeight
      if (index < text.length) requestAnimationFrame(tick)
      else {
        revealingId = null
        renderLog()
        resolve()
      }
    }
    requestAnimationFrame(tick)
  })
}

/* ------------------------------------------------------------ interactions */

function autosize(): void {
  const input = $<HTMLTextAreaElement>('#chatInput')
  input.style.height = 'auto'
  input.style.height = `${Math.min(input.scrollHeight, 220)}px`
}

function updateSendButton(): void {
  const input = $<HTMLTextAreaElement>('#chatInput')
  const button = $<HTMLButtonElement>('#chatSend')
  button.disabled = sending || !input.value.trim()
  button.classList.toggle('busy', sending)
}

function toggleSidebar(open: boolean): void {
  $('#aiApp').classList.toggle('side-open', open)
}

async function onSessionClick(event: Event): Promise<void> {
  const target = event.target as HTMLElement
  const renameStart = target.closest<HTMLElement>('[data-rename-start]')
  const remove = target.closest<HTMLElement>('[data-delete]')
  const row = target.closest<HTMLElement>('[data-session]')

  if (renameStart) {
    event.stopPropagation()
    renamingId = renameStart.dataset.renameStart as string
    renderSessions()
    return
  }
  if (remove) {
    event.stopPropagation()
    const id = remove.dataset.delete as string
    const session = sessions.find((entry) => entry.id === id)
    const ok = await confirmAction('Supprimer cette conversation ?', `« ${session?.title ?? ''} » et tous ses messages seront effacés.`, 'Supprimer')
    if (!ok) return
    try {
      await api.deleteChatSession(id)
      sessions = sessions.filter((entry) => entry.id !== id)
      if (activeSession?.id === id) newConversation()
      else renderSessions()
      toast('Conversation supprimée.')
    } catch (error) {
      toast((error as Error).message, 'error')
    }
    return
  }
  if (row && row.dataset.session !== activeSession?.id && !sending) void openSession(row.dataset.session as string)
}

async function commitRename(id: string, value: string): Promise<void> {
  renamingId = null
  const title = value.trim().slice(0, 80)
  const session = sessions.find((entry) => entry.id === id)
  if (!session || !title || title === session.title) return renderSessions()
  session.title = title
  renderSessions()
  renderHeader()
  try {
    await api.updateChatSession(id, { title })
  } catch (error) {
    toast((error as Error).message, 'error')
  }
}

async function onLogClick(event: Event): Promise<void> {
  const target = event.target as HTMLElement
  const suggestion = target.closest<HTMLElement>('[data-suggest]')
  const copy = target.closest<HTMLElement>('[data-copy]')
  const task = target.closest<HTMLElement>('[data-task]')
  const regenerate = target.closest<HTMLElement>('[data-regenerate]')

  if (suggestion) {
    const text = suggestion.dataset.suggest as string
    // Une suggestion qui se termine par « : » attend une précision de l'utilisateur.
    if (text.trimEnd().endsWith(':')) {
      const input = $<HTMLTextAreaElement>('#chatInput')
      input.value = text
      input.focus()
      autosize()
      updateSendButton()
    } else void send(text)
  } else if (copy) {
    const message = messages.find((entry) => entry.id === copy.dataset.copy)
    if (!message) return
    await navigator.clipboard.writeText(message.content).catch(() => undefined)
    copy.innerHTML = '<i class="ri-check-line"></i>'
    setTimeout(() => (copy.innerHTML = '<i class="ri-file-copy-line"></i>'), 1400)
  } else if (task) {
    openTaskDetail(task.dataset.task as string)
  } else if (regenerate) {
    await regenerateLast()
  } else {
    const codeBlock = target.closest<HTMLElement>('.code-block')
    if (codeBlock && target.closest('.code-copy')) {
      await navigator.clipboard.writeText(codeBlock.querySelector('code')?.textContent ?? '').catch(() => undefined)
      toast('Code copié.')
    }
  }
}

/** Relance la dernière question : la réponse précédente est retirée du fil. */
async function regenerateLast(): Promise<void> {
  if (sending || !activeSession) return
  const last = messages.at(-1)
  const question = [...messages].reverse().find((message) => message.role === 'user')
  if (!last || last.role !== 'assistant' || !question) return
  messages = messages.slice(0, -1)
  void api.deleteChatMessage(last.id).catch(() => undefined)
  if (!(await ask(false))) {
    messages = [...messages, last]
    renderLog()
  }
}

async function ensureSession(firstMessage: string): Promise<ChatSession> {
  if (activeSession) return activeSession
  const provisional = firstMessage.replace(/\s+/g, ' ').trim()
  const title = provisional.length > 48 ? `${provisional.slice(0, 48)}…` : provisional
  const session = await api.createChatSession(state.currentProjectId, title || 'Nouvelle conversation')
  sessions = [session, ...sessions]
  activeSession = session
  renderSessions()
  renderHeader()
  return session
}

async function send(raw: string): Promise<void> {
  const content = raw.trim()
  if (!content || sending) return

  const input = $<HTMLTextAreaElement>('#chatInput')
  input.value = ''
  autosize()

  let session: ChatSession
  try {
    session = await ensureSession(content)
  } catch (error) {
    toast((error as Error).message, 'error')
    input.value = content
    updateSendButton()
    return
  }

  // Le message part à l'écran immédiatement : l'attente de l'IA ne doit pas
  // donner l'impression que le clic n'a pas été pris en compte.
  const local: ChatMessage = {
    id: crypto.randomUUID(),
    project_id: session.project_id,
    session_id: session.id,
    user_id: state.profile?.id ?? '',
    role: 'user',
    content,
    created_at: new Date().toISOString(),
  }
  messages = [...messages, local]
  void api
    .saveChatMessage(session, 'user', content)
    .then((saved) => {
      messages = messages.map((message) => (message.id === local.id ? saved : message))
    })
    .catch(() => undefined)

  const ok = await ask(true)
  if (!ok) {
    messages = messages.filter((message) => message.id !== local.id)
    input.value = content
    autosize()
    renderLog()
  }
  updateSendButton()
}

/** Interroge l'IA avec le fil courant et ajoute sa réponse. */
async function ask(allowTitle: boolean): Promise<boolean> {
  const session = activeSession
  if (!session) return false
  sending = true
  updateSendButton()
  renderLog(true)

  const turns: ChatTurn[] = messages.map((message) => ({ role: message.role, content: message.content }))
  const wantTitle = allowTitle && messages.filter((message) => message.role === 'user').length === 1

  try {
    const res = await aiApi.chat({ projectId: session.project_id, messages: turns, wantTitle })
    const meta = syncBoard(res.created_tasks, res.updated_tasks, res.deleted_task_ids)
    meta.model = res.model

    const reply: ChatMessage = await api.saveChatMessage(session, 'assistant', res.reply, meta).catch(() => ({
      id: crypto.randomUUID(),
      project_id: session.project_id,
      session_id: session.id,
      user_id: state.profile?.id ?? '',
      role: 'assistant' as const,
      content: res.reply,
      meta,
      created_at: new Date().toISOString(),
    }))

    if (res.title && wantTitle) {
      session.title = res.title
      void api.updateChatSession(session.id, { title: res.title }).catch(() => undefined)
    }
    session.updated_at = new Date().toISOString()
    sessions = [session, ...sessions.filter((entry) => entry.id !== session.id)]
    renderSessions()
    renderHeader()

    sending = false
    if (activeSession?.id !== session.id) return true
    messages = [...messages, reply]
    await reveal(reply)
    return true
  } catch (error) {
    toast((error as Error).message, 'error')
    return false
  } finally {
    sending = false
    updateSendButton()
  }
}

/** Répercute sur le board les actions menées par l'IA et en garde la trace. */
function syncBoard(created: Task[] = [], updated: Task[] = [], deletedIds: string[] = []): ChatMessageMeta {
  const summary = (task: Task) => ({ id: task.id, seq: task.seq, title: task.title })
  const deletedTitles = deletedIds.map((id) => taskById(id)?.title ?? 'Tâche')

  created.forEach((task) => upsertTask(task))
  updated.forEach((task) => upsertTask(task))
  deletedIds.forEach((id) => removeTask(id))

  const parts = [
    created.length ? `${created.length} tâche(s) créée(s)` : '',
    updated.length ? `${updated.length} mise(s) à jour` : '',
    deletedIds.length ? `${deletedIds.length} supprimée(s)` : '',
  ].filter(Boolean)
  if (parts.length) toast(`Board : ${parts.join(', ')}.`)

  return {
    ...(created.length ? { created: created.map(summary) } : {}),
    ...(updated.length ? { updated: updated.map(summary) } : {}),
    ...(deletedIds.length ? { deleted: deletedTitles } : {}),
  }
}
