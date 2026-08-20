import { $ } from './ui.js'

const modal = (): HTMLElement => $('#modal')
const modalPanel = (): HTMLElement => $('#modalPanel')
const drawer = (): HTMLElement => $('#drawer')
const drawerPanel = (): HTMLElement => $('#drawerPanel')

export function openModal(html: string, size: 'default' | 'wide' = 'default'): HTMLElement {
  const panel = modalPanel()
  panel.classList.toggle('wide', size === 'wide')
  panel.innerHTML = html
  modal().setAttribute('aria-hidden', 'false')
  panel.querySelector<HTMLElement>('input, textarea, select')?.focus()
  return panel
}

export function closeModal(): void {
  modal().setAttribute('aria-hidden', 'true')
  modalPanel().innerHTML = ''
}

export const isModalOpen = (): boolean => modal().getAttribute('aria-hidden') === 'false'

export function openDrawer(html: string): HTMLElement {
  const panel = drawerPanel()
  panel.innerHTML = html
  panel.scrollTop = 0
  drawer().setAttribute('aria-hidden', 'false')
  return panel
}

export function closeDrawer(): void {
  drawer().setAttribute('aria-hidden', 'true')
  drawerPanel().innerHTML = ''
}

export const isDrawerOpen = (): boolean => drawer().getAttribute('aria-hidden') === 'false'

/** Confirmation stylée : `confirm()` natif casse l'ambiance et bloque le thread. */
export function confirmAction(question: string, detail = '', confirmLabel = 'Confirmer'): Promise<boolean> {
  return new Promise((resolve) => {
    const panel = openModal(`
      <div class="panel-head">
        <div><h2>${question}</h2>${detail ? `<p>${detail}</p>` : ''}</div>
      </div>
      <div class="form-actions">
        <button class="btn" type="button" data-confirm="no">Annuler</button>
        <button class="btn danger solid" type="button" data-confirm="yes">${confirmLabel}</button>
      </div>`)

    panel.querySelectorAll<HTMLElement>('[data-confirm]').forEach((button) => {
      button.addEventListener('click', () => {
        closeModal()
        resolve(button.dataset.confirm === 'yes')
      })
    })
  })
}

export function initOverlays(): void {
  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement
    if (target.closest('[data-close-modal]')) closeModal()
    if (target.closest('[data-close-drawer]')) closeDrawer()
  })

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    if (isModalOpen()) closeModal()
    else if (isDrawerOpen()) closeDrawer()
  })
}
