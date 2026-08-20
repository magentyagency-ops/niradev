import { api } from '../api.js'
import { openProjectForm } from '../forms.js'
import { setupSectionProjectPicker } from '../projectPicker.js'
import {
  canManage,
  currentProject,
  projectTeam,
  setCurrentProject,
  state,
  subscribe,
} from '../store.js'
import {
  $,
  emptyBlock,
  escapeHtml,
  formatDate,
  formatFileSize,
  initialsOf,
  invalidate,
  MEMBER_ROLES,
  PROJECT_STATUSES,
  toast,
  unchanged,
  viewIsActive,
} from '../ui.js'

/**
 * Télécharge un fichier directement dans le navigateur.
 */
async function downloadFile(url: string, filename: string): Promise<void> {
  try {
    toast('Téléchargement en cours…')
    if (url.startsWith('data:')) {
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      document.body.appendChild(link)
      link.click()
      link.remove()
      toast('Téléchargement terminé.')
      return
    }

    const res = await fetch(url)
    const blob = await res.blob()
    const blobUrl = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = blobUrl
    link.download = filename
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(blobUrl), 2000)
    toast('Téléchargement terminé.')
  } catch (err) {
    console.warn('[nira-dev] Erreur de téléchargement blob, ouverture directe', err)
    window.open(url, '_blank')
  }
}

export function initBrief(): void {
  setupSectionProjectPicker({
    containerId: 'briefProjectPicker',
    getSelectedId: () => state.currentProjectId,
    onSelect: (id) => {
      if (id) setCurrentProject(id)
    },
  })

  $('#briefDownloadBtn').addEventListener('click', () => {
    const project = currentProject()
    if (project?.brief_pdf_url) {
      const fileName =
        project.brief_pdf_name ||
        `Brief_${project.code}_${project.name.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`
      void downloadFile(project.brief_pdf_url, fileName)
    }
  })

  $('#briefUploadBtn').addEventListener('click', () => {
    const project = currentProject()
    if (project) openProjectForm(project)
  })

  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement
    if (target.closest('[data-action-edit-proj]')) {
      const proj = currentProject()
      if (proj) openProjectForm(proj)
    }
    if (target.closest('[data-action-download-pdf]')) {
      const proj = currentProject()
      if (proj?.brief_pdf_url) {
        const fileName =
          proj.brief_pdf_name ||
          `Brief_${proj.code}_${proj.name.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`
        void downloadFile(proj.brief_pdf_url, fileName)
      }
    }
  })

  subscribe(render)
}

/** Projets dont l'URL du PDF a déjà été demandée, pour ne pas la redemander. */
const pdfRequested = new Set<string>()

function render(): void {
  if (!viewIsActive('brief')) return
  const project = currentProject()
  const body = $('#briefBody')

  // L'URL du PDF n'est pas chargée avec la liste des projets : on la demande la
  // première fois que le brief est affiché, puis on redessine.
  if (project?.brief_pdf_name && project.brief_pdf_url === undefined && !pdfRequested.has(project.id)) {
    pdfRequested.add(project.id)
    void api.loadProjectPdf(project.id).then((url) => {
      project.brief_pdf_url = url
      invalidate('brief')
      render()
    })
  }

  // Sans cette garde, la moindre mutation de l'état (une tâche déplacée, un
  // message de l'assistant) reconstruirait l'`iframe` et rechargerait le PDF
  // entier — la page paraissait alors se figer sans raison.
  const signature = JSON.stringify([
    project?.id,
    project?.name,
    project?.client,
    project?.status,
    project?.due_date,
    project?.repo_url,
    project?.stack,
    project?.brief_pdf_url,
    project?.brief_pdf_name,
    project?.brief_pdf_size,
    project ? projectTeam(project.id).map((person) => person.id + person.full_name) : null,
    project ? canManage(project.id) : false,
  ])
  if (unchanged('brief', signature)) return
  const downloadBtn = $<HTMLButtonElement>('#briefDownloadBtn')
  const uploadBtn = $<HTMLButtonElement>('#briefUploadBtn')

  $('#briefProjectName').textContent = project ? `Brief — ${project.name}` : 'Brief projet'
  const editable = Boolean(project && canManage(project.id))

  if (downloadBtn) downloadBtn.hidden = !project?.brief_pdf_url
  if (uploadBtn) uploadBtn.hidden = !editable

  if (!project) {
    body.innerHTML = emptyBlock(
      'ri-folder-open-line',
      'Aucun projet sélectionné',
      'Choisis un projet dans le sélecteur en haut de page.',
      false,
    )
    return
  }

  const team = projectTeam(project.id)

  if (!project.brief_pdf_url) {
    body.innerHTML = `
      <div class="brief-shell">
        <article class="brief-doc glass" style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:520px;text-align:center;padding:40px 20px">
          <div class="pdf-file-icon" style="width:68px;height:68px;border-radius:20px;font-size:34px;margin-bottom:16px">
            <i class="ri-file-pdf-2-line"></i>
          </div>
          <h2 style="font-size:20px;margin:0 0 6px">Aucun brief PDF attaché</h2>
          <p class="muted" style="max-width:420px;margin:0 0 22px;font-size:12px;line-height:1.6">
            ${
              editable
                ? 'Attache le document PDF du brief ou cahier des charges de ce projet. Il sera prévisualisé et téléchargeable directement par toute l\'équipe.'
                : 'Le manager n\'a pas encore déposé de document PDF de brief pour ce projet.'
            }
          </p>
          ${
            editable
              ? `<button class="btn primary" type="button" data-action-edit-proj><i class="ri-upload-2-line"></i>Attacher le PDF du brief</button>`
              : ''
          }
        </article>

        <aside class="brief-aside">
          <section class="aside-card glass">
            <h3>Le projet</h3>
            <div class="fact-list">
              <div class="fact"><small>Client</small><b>${escapeHtml(project.client || '—')}</b></div>
              <div class="fact"><small>Statut</small><b>${PROJECT_STATUSES[project.status].label}</b></div>
              <div class="fact"><small>Échéance</small><b>${formatDate(project.due_date)}</b></div>
              ${project.stack.length ? `<div class="fact"><small>Stack</small><b>${escapeHtml(project.stack.join(' · '))}</b></div>` : ''}
              ${
                project.repo_url
                  ? `<div class="fact"><small>Dépôt</small><b><a href="${escapeHtml(project.repo_url)}" target="_blank" rel="noopener" style="color:var(--blue)">Ouvrir le dépôt</a></b></div>`
                  : ''
              }
            </div>
          </section>

          <section class="aside-card glass">
            <h3>Équipe</h3>
            <div class="team-list">
              ${
                team
                  .map((person) => {
                    const membership = state.members.find(
                      (member) => member.project_id === project.id && member.user_id === person.id,
                    )
                    const name = person.full_name || person.email
                    const role =
                      person.id === project.manager_id
                        ? 'Manager de projet'
                        : MEMBER_ROLES[membership?.role_in_project ?? 'dev']
                    return `
                    <div class="team-row">
                      <span class="avatar">${escapeHtml(initialsOf(name))}</span>
                      <span><b>${escapeHtml(name)}</b><small>${escapeHtml(person.job_title || '')}</small></span>
                      <span class="chip muted">${escapeHtml(role)}</span>
                    </div>`
                  })
                  .join('') || '<p class="muted" style="font-size:10px;margin:0">Aucun membre affecté.</p>'
              }
            </div>
          </section>
        </aside>
      </div>`
    return
  }

  const fileName = project.brief_pdf_name || `Brief_${project.code}.pdf`
  const fileSize = project.brief_pdf_size ? formatFileSize(project.brief_pdf_size) : 'Document PDF'

  body.innerHTML = `
    <div class="brief-shell">
      <article class="brief-doc glass" style="padding:0;overflow:hidden;display:flex;flex-direction:column;min-height:800px">
        <div class="brief-preview-head" style="padding:14px 20px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--hair);background:color-mix(in srgb, var(--surface) 85%, transparent);flex-wrap:wrap;gap:10px">
          <div style="display:flex;align-items:center;gap:12px;min-width:0">
            <div class="pdf-file-icon" style="width:38px;height:38px;font-size:22px;border-radius:10px"><i class="ri-file-pdf-2-fill"></i></div>
            <div style="min-width:0">
              <b style="font-size:13px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(fileName)}</b>
              <span class="muted" style="font:500 9px var(--mono)">${fileSize} · Document de cadrage officiel</span>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            <a class="btn ghost small" href="${project.brief_pdf_url}" target="_blank" rel="noopener" title="Ouvrir dans un nouvel onglet"><i class="ri-external-link-line"></i>Plein écran</a>
            <button class="btn primary small" type="button" data-action-download-pdf><i class="ri-download-2-line"></i>Télécharger le brief</button>
          </div>
        </div>

        <div class="pdf-preview-container" style="flex:1;min-height:720px;background:#181926;position:relative;display:flex;flex-direction:column">
          <iframe 
            src="${project.brief_pdf_url}#toolbar=1" 
            class="pdf-preview-frame" 
            title="Prévisualisation du brief PDF"
            style="width:100%;height:100%;min-height:720px;border:0;flex:1;display:block"
          ></iframe>
        </div>
      </article>

      <aside class="brief-aside">
        <section class="aside-card glass">
          <h3>Téléchargement</h3>
          <div class="fact-list">
            <button class="btn primary" type="button" data-action-download-pdf style="width:100%;justify-content:center">
              <i class="ri-download-2-line"></i>Télécharger le brief
            </button>
            <a class="btn ghost" href="${project.brief_pdf_url}" target="_blank" rel="noopener" style="width:100%;justify-content:center">
              <i class="ri-external-link-line"></i>Ouvrir dans un onglet
            </a>
          </div>
        </section>

        <section class="aside-card glass">
          <h3>Le projet</h3>
          <div class="fact-list">
            <div class="fact"><small>Client</small><b>${escapeHtml(project.client || '—')}</b></div>
            <div class="fact"><small>Statut</small><b>${PROJECT_STATUSES[project.status].label}</b></div>
            <div class="fact"><small>Échéance</small><b>${formatDate(project.due_date)}</b></div>
            ${project.stack.length ? `<div class="fact"><small>Stack</small><b>${escapeHtml(project.stack.join(' · '))}</b></div>` : ''}
            ${
              project.repo_url
                ? `<div class="fact"><small>Dépôt</small><b><a href="${escapeHtml(project.repo_url)}" target="_blank" rel="noopener" style="color:var(--blue)">Ouvrir le dépôt</a></b></div>`
                : ''
            }
          </div>
        </section>

        <section class="aside-card glass">
          <h3>Équipe</h3>
          <div class="team-list">
            ${
              team
                .map((person) => {
                  const membership = state.members.find(
                    (member) => member.project_id === project.id && member.user_id === person.id,
                  )
                  const name = person.full_name || person.email
                  const role =
                    person.id === project.manager_id
                      ? 'Manager de projet'
                      : MEMBER_ROLES[membership?.role_in_project ?? 'dev']
                  return `
                  <div class="team-row">
                    <span class="avatar">${escapeHtml(initialsOf(name))}</span>
                    <span><b>${escapeHtml(name)}</b><small>${escapeHtml(person.job_title || '')}</small></span>
                    <span class="chip muted">${escapeHtml(role)}</span>
                  </div>`
                })
                .join('') || '<p class="muted" style="font-size:10px;margin:0">Aucun membre affecté.</p>'
            }
          </div>
        </section>
      </aside>
    </div>`
}
