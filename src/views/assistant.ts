import { aiApi, type ChatTurn } from '../aiApi.js'
import { api } from '../api.js'
import { setupSectionProjectPicker } from '../projectPicker.js'
import { currentProject, latestBrief, setCurrentProject, state, subscribe } from '../store.js'
import type { ChatMessage } from '../types.js'
import { $, escapeHtml, initialsOf, renderMarkdown, toast, viewIsActive } from '../ui.js'

/**
 * Assistant technique.
 *
 * Le fil est privé à chaque compte et rattaché au projet courant : changer de
 * projet change de conversation, ce qui évite de mélanger deux cadrages.
 */

let messages: ChatMessage[] = []
let loadedProjectId: string | null | undefined
let sending = false

const SUGGESTIONS_WITH_BRIEF = [
  'Que dit le brief sur ce que je dois livrer exactement ?',
  "Quels sont les critères d'acceptation de mes tâches en cours ?",
  "Qu'est-ce qui est explicitement hors périmètre ?",
  'Par quoi devrais-je commencer aujourd’hui ?',
]

const SUGGESTIONS_WITHOUT_BRIEF = [
  'Comment structurer ce projet techniquement ?',
  'Explique-moi cette erreur TypeScript',
  'Quelle stratégie de tests pour cette stack ?',
]

export function initAssistant(): void {
  setupSectionProjectPicker({
    containerId: 'assistantProjectPicker',
    getSelectedId: () => state.currentProjectId,
    onSelect: (id) => {
      if (id) setCurrentProject(id)
    },
  })

  $<HTMLFormElement>('#chatForm').addEventListener('submit', (event) => {
    event.preventDefault()
    void send($<HTMLTextAreaElement>('#chatInput').value)
  })

  const input = $<HTMLTextAreaElement>('#chatInput')
  input.addEventListener('input', () => {
    // Le champ grandit avec le message plutôt que de le faire défiler.
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`
  })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send(input.value)
    }
  })

  $('#chatClear').addEventListener('click', () => void clear())

  subscribe(() => {
    if (!viewIsActive('assistant')) return
    // Le fil suit le projet sélectionné : on ne recharge que si celui-ci change.
    if (loadedProjectId !== state.currentProjectId) void load()
    else render()
  })
}

async function load(): Promise<void> {
  loadedProjectId = state.currentProjectId
  try {
    messages = await api.loadChat(state.currentProjectId)
  } catch (error) {
    messages = []
    toast((error as Error).message, 'error')
  }
  render()
}

function bubble(role: 'user' | 'assistant', content: string, pending = false): string {
  const name = role === 'user' ? state.profile?.full_name || state.profile?.email || 'Moi' : 'Nira'
  return `
    <article class="chat-msg ${role}">
      <span class="avatar">${role === 'user' ? escapeHtml(initialsOf(name)) : '<i class="ri-sparkling-2-line"></i>'}</span>
      <div class="chat-bubble">
        ${pending ? '<span class="chat-typing"><i class="ri-loader-4-line"></i>Lecture du brief et des tâches…</span>' : renderMarkdown(content)}
      </div>
    </article>`
}

function render(pending = false): void {
  if (!viewIsActive('assistant')) return
  const log = $('#chatLog')
  const project = currentProject()

  const intro = `
    <article class="chat-msg assistant">
      <span class="avatar"><i class="ri-sparkling-2-line"></i></span>
      <div class="chat-bubble">
        ${
          project
            ? `<p>Je suis l'assistant du projet <b>${escapeHtml(project.name)}</b>. Je connais son brief${
                latestBrief(project.id) ? '' : " (non publié pour l'instant)"
              }, ses tâches et son équipe. Pose ta question.</p>`
            : "<p>Aucun projet sélectionné : je réponds de façon générale. Choisis un projet dans le sélecteur en haut pour que je m'appuie sur son brief.</p>"
        }
      </div>
    </article>`

  log.innerHTML =
    intro + messages.map((message) => bubble(message.role, message.content)).join('') + (pending ? bubble('assistant', '', true) : '')
  log.scrollTop = log.scrollHeight

  const suggestions = project && latestBrief(project.id) ? SUGGESTIONS_WITH_BRIEF : SUGGESTIONS_WITHOUT_BRIEF
  const suggestionBar = $('#chatSuggestions')
  suggestionBar.innerHTML = messages.length
    ? ''
    : suggestions.map((text) => `<button class="suggestion" type="button">${escapeHtml(text)}</button>`).join('')
  suggestionBar.querySelectorAll('button').forEach((button) => {
    button.addEventListener('click', () => void send(button.textContent ?? ''))
  })
}

async function send(raw: string): Promise<void> {
  const content = raw.trim()
  if (!content || sending) return

  sending = true
  const input = $<HTMLTextAreaElement>('#chatInput')
  input.value = ''
  input.style.height = 'auto'
  $<HTMLButtonElement>('#chatSend').disabled = true

  // Le message part à l'écran immédiatement : l'attente de l'IA ne doit pas
  // donner l'impression que le clic n'a pas été pris en compte.
  const local: ChatMessage = {
    id: crypto.randomUUID(),
    project_id: state.currentProjectId,
    user_id: state.profile?.id ?? '',
    role: 'user',
    content,
    created_at: new Date().toISOString(),
  }
  messages = [...messages, local]
  render(true)

  const turns: ChatTurn[] = messages.map((message) => ({ role: message.role, content: message.content }))

  try {
    void api.saveChatMessage(state.currentProjectId, 'user', content).catch(() => undefined)
    const { reply } = await aiApi.chat({ projectId: state.currentProjectId, messages: turns })
    const saved = await api
      .saveChatMessage(state.currentProjectId, 'assistant', reply)
      .catch(() => ({
        id: crypto.randomUUID(),
        project_id: state.currentProjectId,
        user_id: state.profile?.id ?? '',
        role: 'assistant' as const,
        content: reply,
        created_at: new Date().toISOString(),
      }))
    messages = [...messages, saved]
  } catch (error) {
    messages = messages.filter((message) => message.id !== local.id)
    toast((error as Error).message, 'error')
    input.value = content
  } finally {
    sending = false
    $<HTMLButtonElement>('#chatSend').disabled = false
    render()
  }
}

async function clear(): Promise<void> {
  try {
    await api.clearChat(state.currentProjectId)
    messages = []
    render()
    toast('Fil effacé.')
  } catch (error) {
    toast((error as Error).message, 'error')
  }
}
