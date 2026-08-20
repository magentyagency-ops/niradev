import { aiApi } from './aiApi.js'
import { api } from './api.js'
import { closeModal, confirmAction, openModal } from './modal.js'
import {
  canManage,
  currentProject,
  isManager,
  personById,
  projectTasks,
  projectTeam,
  notify,
  pushActivity,
  removeProject,
  setCurrentProject,
  state,
  upsertBrief,
  upsertProject,
  upsertSubmission,
  upsertTask,
  removeTask,
} from './store.js'
import type { AcceptanceCriterion, MemberRole, Project, Task } from './types.js'
import {
  $,
  $$,
  escapeHtml,
  formatFileSize,
  LANGUAGES,
  MEMBER_ROLES,
  PRIORITIES,
  PROJECT_COLORS,
  PROJECT_STATUSES,
  TASK_KINDS,
  TASK_STATUSES,
  toast,
  toDateInput,
  uid,
} from './ui.js'

/* --------------------------------------------------------- petits blocs */

const options = (entries: [string, string][], selected: string): string =>
  entries
    .map(([value, label]) => `<option value="${value}"${value === selected ? ' selected' : ''}>${escapeHtml(label)}</option>`)
    .join('')

const peopleOptions = (selected: string | null, projectId?: string | null): string => {
  // Sur un projet donné, on ne propose que son équipe : assigner une tâche à
  // quelqu'un qui n'y a pas accès la rendrait invisible pour lui.
  const pool = projectId ? projectTeam(projectId) : state.people
  const list = pool.length ? pool : state.people
  return `<option value="">Non assigné</option>${list
    .map(
      (person) =>
        `<option value="${person.id}"${person.id === selected ? ' selected' : ''}>${escapeHtml(
          person.full_name || person.email,
        )}</option>`,
    )
    .join('')}`
}

/** Éditeur de critères d'acceptation : une ligne = un comportement vérifiable. */
function criteriaEditor(id: string, criteria: AcceptanceCriterion[]): string {
  const row = (criterion: AcceptanceCriterion): string => `
    <div class="criteria-row">
      <input class="field" value="${escapeHtml(criterion.text)}" placeholder="Ex. : un mot de passe invalide affiche un message d'erreur">
      <button class="icon-btn" type="button" data-remove-criterion aria-label="Retirer"><i class="ri-close-line"></i></button>
    </div>`

  return `
    <div class="criteria-editor" id="${id}">${(criteria.length ? criteria : [{ id: uid(), text: '' }]).map(row).join('')}</div>
    <button class="btn ghost small" type="button" data-add-criterion="${id}"><i class="ri-add-line"></i>Ajouter un critère</button>`
}

function bindCriteria(panel: HTMLElement): void {
  panel.addEventListener('click', (event) => {
    const target = event.target as HTMLElement
    const add = target.closest<HTMLElement>('[data-add-criterion]')
    if (add) {
      const list = $(`#${add.dataset.addCriterion}`, panel)
      list.insertAdjacentHTML(
        'beforeend',
        `<div class="criteria-row">
           <input class="field" placeholder="Critère vérifiable">
           <button class="icon-btn" type="button" data-remove-criterion aria-label="Retirer"><i class="ri-close-line"></i></button>
         </div>`,
      )
      list.querySelector<HTMLInputElement>('.criteria-row:last-child input')?.focus()
    }
    if (target.closest('[data-remove-criterion]')) target.closest('.criteria-row')?.remove()
  })
}

export function readCriteria(panel: HTMLElement, id: string): AcceptanceCriterion[] {
  return $$<HTMLInputElement>(`#${id} input`, panel)
    .map((input) => input.value.trim())
    .filter(Boolean)
    .map((text) => ({ id: uid(), text, done: false }))
}

const submitting = (form: HTMLFormElement, busy: boolean): void => {
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')
  if (button) button.disabled = busy
}

/* ---------------------------------------------------------------- projet */

export function openProjectForm(project?: Project): void {
  const isEdit = Boolean(project)
  const managers = state.people.filter((person) => person.dev_role !== 'dev')
  const team = project ? state.members.filter((member) => member.project_id === project.id) : []

  let uploadedPdf: { url: string; name: string; size: number } | null = project?.brief_pdf_url
    ? {
        url: project.brief_pdf_url,
        name: project.brief_pdf_name ?? 'brief.pdf',
        size: project.brief_pdf_size ?? 0,
      }
    : null
  let extractedPdfText: string | null = null

  const panel = openModal(
    `
    <form id="projectForm">
      <div class="panel-head">
        <div>
          <h2>${isEdit ? 'Modifier le projet' : 'Nouveau projet'}</h2>
          <p>Le manager désigné pourra rédiger le brief, créer les tâches et gérer l'équipe.</p>
        </div>
        <button class="icon-btn" type="button" data-close-modal aria-label="Fermer"><i class="ri-close-line"></i></button>
      </div>
      <div class="form-grid">
        <div class="field-group full"><label for="p-name">Nom du projet</label>
          <input class="field" id="p-name" name="name" required value="${escapeHtml(project?.name ?? '')}" placeholder="Refonte de l'espace client"></div>
        <div class="field-group"><label for="p-code">Code (préfixe des tâches)</label>
          <input class="field" id="p-code" name="code" maxlength="6" value="${escapeHtml(project?.code ?? '')}" placeholder="ESPC"></div>
        <div class="field-group"><label for="p-client">Client</label>
          <input class="field" id="p-client" name="client" value="${escapeHtml(project?.client ?? '')}" placeholder="Certus"></div>
        <div class="field-group full"><label for="p-summary">Résumé</label>
          <textarea class="field" id="p-summary" name="summary" style="min-height:70px" placeholder="En une ou deux phrases : ce que le projet doit produire.">${escapeHtml(project?.summary ?? '')}</textarea></div>
        <div class="field-group"><label for="p-status">Statut</label>
          <select class="field" id="p-status" name="status">${options(
            Object.entries(PROJECT_STATUSES).map(([value, meta]) => [value, meta.label]),
            project?.status ?? 'active',
          )}</select></div>
        <div class="field-group"><label for="p-manager">Manager de projet</label>
          <select class="field" id="p-manager" name="manager_id">
            ${managers
              .map(
                (person) =>
                  `<option value="${person.id}"${
                    person.id === (project?.manager_id ?? state.profile?.id) ? ' selected' : ''
                  }>${escapeHtml(person.full_name || person.email)}</option>`,
              )
              .join('')}
          </select></div>
        <div class="field-group"><label for="p-start">Début</label>
          <input class="field" id="p-start" name="start_date" type="date" value="${toDateInput(project?.start_date ?? null)}"></div>
        <div class="field-group"><label for="p-due">Échéance</label>
          <input class="field" id="p-due" name="due_date" type="date" value="${toDateInput(project?.due_date ?? null)}"></div>
        <div class="field-group"><label for="p-stack">Stack (séparée par des virgules)</label>
          <input class="field" id="p-stack" name="stack" value="${escapeHtml((project?.stack ?? []).join(', '))}" placeholder="TypeScript, React, Supabase"></div>
        <div class="field-group"><label for="p-repo">Dépôt Git</label>
          <input class="field" id="p-repo" name="repo_url" value="${escapeHtml(project?.repo_url ?? '')}" placeholder="https://github.com/…"></div>
        <div class="field-group full"><label for="p-color">Couleur</label>
          <select class="field" id="p-color" name="color">${options(
            PROJECT_COLORS.map((color) => [color, color]),
            project?.color ?? 'violet',
          )}</select></div>

        <!-- Document de brief PDF -->
        <div class="field-group full">
          <label>Document de brief (PDF)</label>
          <div class="pdf-dropzone" id="pdfDropzone">
            <input type="file" id="p-brief-file" accept="application/pdf" style="display:none">
            <div class="pdf-empty-state" id="pdfEmptyState"${uploadedPdf ? ' style="display:none"' : ''}>
              <i class="ri-file-pdf-2-line"></i>
              <div>
                <b>Attacher un brief ou cahier des charges (PDF)</b>
                <span>Glisse un document PDF ici ou clique pour parcourir tes fichiers.</span>
              </div>
              <button class="btn small" type="button" id="pdfBrowseBtn"><i class="ri-upload-2-line"></i>Choisir un PDF</button>
            </div>
            <div class="pdf-preview-state" id="pdfPreviewState"${uploadedPdf ? '' : ' style="display:none"'}>
              <div class="pdf-file-card">
                <div class="pdf-file-icon"><i class="ri-file-pdf-2-fill"></i></div>
                <div class="pdf-file-info">
                  <b id="pdfFileName">${escapeHtml(uploadedPdf?.name ?? '')}</b>
                  <span id="pdfFileSize">${uploadedPdf?.size ? formatFileSize(uploadedPdf.size) : 'Fichier PDF'}</span>
                </div>
                <div class="pdf-file-actions">
                  <a class="btn ghost small" id="pdfViewLink" href="${uploadedPdf?.url ?? '#'}" target="_blank" rel="noopener"><i class="ri-external-link-line"></i>Ouvrir</a>
                  <button class="btn danger ghost small" type="button" id="pdfRemoveBtn" title="Supprimer le document"><i class="ri-delete-bin-line"></i></button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <p class="section-title">Équipe affectée</p>
      <p class="field-hint" style="margin-bottom:8px">Seuls les comptes cochés voient le projet, son brief et ses tâches.</p>
      <div class="owner-list" id="teamPicker">
        ${state.people
          .map((person) => {
            const membership = team.find((member) => member.user_id === person.id)
            return `
            <label class="owner-option${membership ? ' active' : ''}">
              <input type="checkbox" value="${person.id}"${membership ? ' checked' : ''} style="width:15px;height:15px;accent-color:var(--blue)">
              <span>
                <b>${escapeHtml(person.full_name || person.email)}</b>
                <small>${escapeHtml(person.job_title || person.dev_role)}</small>
              </span>
              <select class="field" data-role-for="${person.id}" style="min-width:auto;font-size:10px;padding:5px 7px">
                ${options(
                  Object.entries(MEMBER_ROLES).map(([value, label]) => [value, label]),
                  membership?.role_in_project ?? 'dev',
                )}
              </select>
            </label>`
          })
          .join('')}
      </div>

      <div class="form-actions">
        ${isEdit ? '<button class="btn danger spacer" type="button" id="deleteProject"><i class="ri-delete-bin-line"></i>Supprimer</button>' : ''}
        <button class="btn" type="button" data-close-modal>Annuler</button>
        <button class="btn primary" type="submit"><i class="ri-check-line"></i>${isEdit ? 'Enregistrer' : 'Créer le projet'}</button>
      </div>
    </form>`,
    'wide',
  )

  // Gestion de l'upload du document PDF
  const dropzone = $<HTMLElement>('#pdfDropzone', panel)
  const fileInput = $<HTMLInputElement>('#p-brief-file', panel)
  const emptyState = $<HTMLElement>('#pdfEmptyState', panel)
  const previewState = $<HTMLElement>('#pdfPreviewState', panel)
  const fileNameNode = $<HTMLElement>('#pdfFileName', panel)
  const fileSizeNode = $<HTMLElement>('#pdfFileSize', panel)
  const viewLinkNode = $<HTMLAnchorElement>('#pdfViewLink', panel)
  const removeBtn = $<HTMLButtonElement>('#pdfRemoveBtn', panel)
  const browseBtn = $<HTMLButtonElement>('#pdfBrowseBtn', panel)

  const updatePdfUi = (): void => {
    if (uploadedPdf) {
      emptyState.style.display = 'none'
      previewState.style.display = 'block'
      fileNameNode.textContent = uploadedPdf.name
      fileSizeNode.textContent = formatFileSize(uploadedPdf.size)
      viewLinkNode.href = uploadedPdf.url
    } else {
      emptyState.style.display = ''
      previewState.style.display = 'none'
      fileInput.value = ''
    }
  }

  const handleFile = async (file: File): Promise<void> => {
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      toast('Seuls les fichiers PDF sont acceptés pour le brief.', 'error')
      return
    }
    toast('Analyse et lecture du fichier PDF…')
    try {
      // pdf.js pèse environ 450 ko : le charger au démarrage ralentissait
      // l'ouverture de l'application pour tout le monde, alors qu'il ne sert
      // qu'ici, au moment où un manager dépose un PDF.
      const { extractTextFromPdf } = await import('./pdfExtractor.js')
      const [res, text] = await Promise.all([
        api.uploadBriefPdf(file),
        extractTextFromPdf(file),
      ])
      uploadedPdf = res
      extractedPdfText = text
      updatePdfUi()
      if (text.length >= 30) {
        toast(`PDF analysé (${text.split(/\s+/).length} mots). Le brief structuré sera généré automatiquement.`)
      } else {
        toast('Document de brief PDF attaché.')
      }
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  browseBtn.addEventListener('click', () => fileInput.click())
  emptyState.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).tagName !== 'BUTTON') fileInput.click()
  })

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0]
    if (file) void handleFile(file)
  })

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault()
    dropzone.classList.add('dragover')
  })
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'))
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault()
    dropzone.classList.remove('dragover')
    const file = e.dataTransfer?.files?.[0]
    if (file) void handleFile(file)
  })

  removeBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    uploadedPdf = null
    extractedPdfText = null
    updatePdfUi()
    toast('Document PDF retiré.')
  })

  // La grille des membres utilise 2 colonnes : le sélecteur de rôle en ajoute une.
  $$('.owner-option', panel).forEach((node) => {
    node.style.gridTemplateColumns = '18px 1fr auto'
  })

  const form = $<HTMLFormElement>('#projectForm', panel)

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    submitting(form, true)
    const data = new FormData(form)

    const payload: Partial<Project> = {
      name: String(data.get('name') ?? ''),
      code: String(data.get('code') ?? ''),
      client: String(data.get('client') ?? ''),
      summary: String(data.get('summary') ?? ''),
      status: data.get('status') as Project['status'],
      color: String(data.get('color') ?? 'violet'),
      repo_url: String(data.get('repo_url') ?? ''),
      stack: String(data.get('stack') ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
      start_date: String(data.get('start_date') ?? '') || null,
      due_date: String(data.get('due_date') ?? '') || null,
      manager_id: String(data.get('manager_id') ?? '') || null,
      brief_pdf_url: uploadedPdf?.url || null,
      brief_pdf_name: uploadedPdf?.name || null,
      brief_pdf_size: uploadedPdf?.size || null,
    }

    try {
      const saved = project ? await api.updateProject(project.id, payload) : await api.createProject(payload)

      const entries = $$<HTMLInputElement>('#teamPicker input[type="checkbox"]', panel)
        .filter((input) => input.checked)
        .map((input) => ({
          user_id: input.value,
          role_in_project: ($<HTMLSelectElement>(`[data-role-for="${input.value}"]`, panel).value ??
            'dev') as MemberRole,
        }))
      const members = await api.setProjectTeam(saved.id, entries)

      upsertProject(saved)
      state.members = [...state.members.filter((member) => member.project_id !== saved.id), ...members]
      if (!project) setCurrentProject(saved.id)

      // Si un document PDF a été analysé, on génère et publie immédiatement le brief structuré
      if (extractedPdfText && extractedPdfText.trim().length >= 30) {
        try {
          toast("Génération du brief structuré par l'IA…")
          const { brief: aiBrief } = await aiApi.structureBrief({
            projectId: saved.id,
            raw: extractedPdfText,
          })
          const savedBrief = await api.saveBrief({ ...aiBrief, project_id: saved.id }, true)
          upsertBrief(savedBrief)
        } catch (aiErr) {
          console.warn('[nira-dev] Génération IA du brief échouée, création du brief direct', aiErr)
          const directBrief = await api.saveBrief(
            {
              project_id: saved.id,
              title: `Brief — ${saved.name}`,
              context: extractedPdfText.slice(0, 3000),
              objectives: 'Consulter le document PDF de cadrage attaché.',
              scope: 'Défini dans le document PDF attaché au projet.',
              tech_notes: (saved.stack ?? []).join(', '),
              deliverables: 'Voir spécifications du PDF.',
            },
            true,
          )
          upsertBrief(directBrief)
        }
      }

      void api
        .logActivity({
          project_id: saved.id,
          kind: 'project',
          text: project ? `Projet mis à jour : ${saved.name}.` : `Projet créé : ${saved.name}.`,
        })
        .then((entry) => entry && pushActivity(entry))

      closeModal()
      toast(project ? 'Projet mis à jour.' : 'Projet créé avec son brief.')
    } catch (error) {
      toast((error as Error).message, 'error')
      submitting(form, false)
    }
  })

  panel.querySelector('#deleteProject')?.addEventListener('click', async () => {
    if (!project) return
    const ok = await confirmAction(
      `Supprimer « ${project.name} » ?`,
      'Le brief, les tâches et les livraisons du projet seront supprimés définitivement.',
      'Supprimer le projet',
    )
    if (!ok) return
    try {
      await api.deleteProject(project.id)
      removeProject(project.id)
      closeModal()
      toast('Projet supprimé.')
    } catch (error) {
      toast((error as Error).message, 'error')
    }
  })
}

/* ----------------------------------------------------------------- tâche */

export function openTaskForm(task?: Task, defaults: Partial<Task> = {}): void {
  const projectId = task?.project_id ?? defaults.project_id ?? state.currentProjectId
  if (!projectId) {
    toast("Sélectionne d'abord un projet.", 'error')
    return
  }
  if (!canManage(projectId)) {
    toast('Seul le manager du projet peut créer ou modifier une tâche.', 'error')
    return
  }

  const isEdit = Boolean(task)
  const panel = openModal(
    `
    <form id="taskForm">
      <div class="panel-head">
        <div>
          <h2>${isEdit ? 'Modifier la tâche' : 'Nouvelle tâche'}</h2>
          <p>Les critères d'acceptation servent de référence à la revue de code automatique.</p>
        </div>
        <button class="icon-btn" type="button" data-close-modal aria-label="Fermer"><i class="ri-close-line"></i></button>
      </div>
      <div class="form-grid">
        <div class="field-group full"><label for="t-title">Titre</label>
          <input class="field" id="t-title" name="title" required value="${escapeHtml(task?.title ?? defaults.title ?? '')}" placeholder="Implémenter la connexion par email"></div>
        <div class="field-group full"><label for="t-desc">Description</label>
          <textarea class="field" id="t-desc" name="description" placeholder="Ce qu'il faut faire, les contraintes, les points d'attention.">${escapeHtml(task?.description ?? defaults.description ?? '')}</textarea></div>
        <div class="field-group"><label for="t-status">Statut</label>
          <select class="field" id="t-status" name="status">${options(
            TASK_STATUSES.map((status) => [status.id, status.label]),
            task?.status ?? defaults.status ?? 'todo',
          )}</select></div>
        <div class="field-group"><label for="t-assignee">Assigné à</label>
          <select class="field" id="t-assignee" name="assignee_id">${peopleOptions(
            task?.assignee_id ?? defaults.assignee_id ?? null,
            projectId,
          )}</select></div>
        <div class="field-group"><label for="t-priority">Priorité</label>
          <select class="field" id="t-priority" name="priority">${options(
            Object.entries(PRIORITIES).map(([value, meta]) => [value, meta.label]),
            task?.priority ?? 'medium',
          )}</select></div>
        <div class="field-group"><label for="t-kind">Type</label>
          <select class="field" id="t-kind" name="kind">${options(
            Object.entries(TASK_KINDS).map(([value, meta]) => [value, meta.label]),
            task?.kind ?? 'feature',
          )}</select></div>
        <div class="field-group"><label for="t-estimate">Estimation (heures)</label>
          <input class="field" id="t-estimate" name="estimate" type="number" min="0" step="0.5" value="${task?.estimate ?? defaults.estimate ?? 0}"></div>
        <div class="field-group"><label for="t-due">Échéance</label>
          <input class="field" id="t-due" name="due_date" type="date" value="${toDateInput(task?.due_date ?? null)}"></div>
        <div class="field-group full"><label for="t-labels">Étiquettes (séparées par des virgules)</label>
          <input class="field" id="t-labels" name="labels" value="${escapeHtml((task?.labels ?? defaults.labels ?? []).join(', '))}" placeholder="auth, api"></div>
      </div>

      <p class="section-title">Critères d'acceptation</p>
      ${criteriaEditor('taskCriteria', task?.acceptance ?? defaults.acceptance ?? [])}

      <div class="form-actions">
        ${isEdit ? '<button class="btn danger spacer" type="button" id="deleteTask"><i class="ri-delete-bin-line"></i>Supprimer</button>' : ''}
        <button class="btn" type="button" data-close-modal>Annuler</button>
        <button class="btn primary" type="submit"><i class="ri-check-line"></i>${isEdit ? 'Enregistrer' : 'Créer la tâche'}</button>
      </div>
    </form>`,
    'wide',
  )

  bindCriteria(panel)
  const form = $<HTMLFormElement>('#taskForm', panel)

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    submitting(form, true)
    const data = new FormData(form)
    const payload: Partial<Task> & { project_id: string } = {
      project_id: projectId,
      title: String(data.get('title') ?? ''),
      description: String(data.get('description') ?? ''),
      status: data.get('status') as Task['status'],
      priority: data.get('priority') as Task['priority'],
      kind: data.get('kind') as Task['kind'],
      assignee_id: String(data.get('assignee_id') ?? '') || null,
      estimate: Number(data.get('estimate')) || 0,
      due_date: String(data.get('due_date') ?? '') || null,
      labels: String(data.get('labels') ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
      acceptance: readCriteria(panel, 'taskCriteria'),
    }

    try {
      const saved = task ? await api.updateTask(task.id, payload) : await api.createTask(payload)
      upsertTask(saved)
      const project = state.projects.find((entry) => entry.id === projectId)
      void api
        .logActivity({
          project_id: projectId,
          task_id: saved.id,
          kind: 'task',
          text: task
            ? `Tâche mise à jour : [${project?.code}-${saved.seq}] ${saved.title}.`
            : `Tâche créée : [${project?.code}-${saved.seq}] ${saved.title}${
                saved.assignee_id ? ` — assignée à ${personById(saved.assignee_id)?.full_name ?? ''}` : ''
              }.`,
        })
        .then((entry) => entry && pushActivity(entry))
      closeModal()
      toast(task ? 'Tâche mise à jour.' : 'Tâche créée.')
    } catch (error) {
      toast((error as Error).message, 'error')
      submitting(form, false)
    }
  })

  panel.querySelector('#deleteTask')?.addEventListener('click', async () => {
    if (!task) return
    if (!(await confirmAction('Supprimer cette tâche ?', 'Ses commentaires seront également supprimés.', 'Supprimer')))
      return
    try {
      await api.deleteTask(task.id)
      removeTask(task.id)
      closeModal()
      toast('Tâche supprimée.')
    } catch (error) {
      toast((error as Error).message, 'error')
    }
  })
}

/* ------------------------------------------------------- livraison de code */

export function openSubmissionForm(taskId?: string): void {
  const project = currentProject()
  if (!project) {
    toast("Sélectionne d'abord un projet.", 'error')
    return
  }

  const tasks = projectTasks(project.id).filter((task) => task.status !== 'done' || task.id === taskId)
  const preselected = taskId ?? tasks.find((task) => task.assignee_id === state.profile?.id)?.id ?? ''

  const panel = openModal(
    `
    <form id="submissionForm">
      <div class="panel-head">
        <div>
          <h2>Livrer une fonctionnalité</h2>
          <p>Le code est confronté au brief du projet et aux critères d'acceptation de la tâche.</p>
        </div>
        <button class="icon-btn" type="button" data-close-modal aria-label="Fermer"><i class="ri-close-line"></i></button>
      </div>
      <div class="form-grid">
        <div class="field-group full"><label for="s-task">Tâche livrée</label>
          <select class="field" id="s-task" name="task_id" style="width:100%">
            <option value="">Aucune tâche — évaluer au regard du brief seul</option>
            ${tasks
              .map(
                (task) =>
                  `<option value="${task.id}"${task.id === preselected ? ' selected' : ''}>[${project.code}-${task.seq}] ${escapeHtml(task.title)}</option>`,
              )
              .join('')}
          </select></div>
        <div class="field-group"><label for="s-title">Intitulé de la livraison</label>
          <input class="field" id="s-title" name="title" required placeholder="Connexion par email — v1"></div>
        <div class="field-group"><label for="s-language">Langage</label>
          <select class="field" id="s-language" name="language" style="width:100%">${options(
            LANGUAGES.map((language) => [language, language]),
            'typescript',
          )}</select></div>
        <div class="field-group"><label for="s-branch">Branche</label>
          <input class="field" id="s-branch" name="branch" placeholder="feat/login"></div>
        <div class="field-group"><label for="s-repo">Lien (PR, dépôt)</label>
          <input class="field" id="s-repo" name="repo_url" placeholder="https://github.com/…/pull/42"></div>
        <div class="field-group full"><label for="s-notes">Note pour le relecteur</label>
          <textarea class="field" id="s-notes" name="notes" style="min-height:64px" placeholder="Ce qui est fait, ce qui reste, les choix techniques discutables."></textarea></div>
        <div class="field-group full">
          <label for="s-code">Code livré</label>
          <textarea class="field code" id="s-code" name="code" required placeholder="Colle ici le code de la fonctionnalité (un ou plusieurs fichiers, séparés par un commentaire // fichier : chemin)"></textarea>
          <p class="field-hint">Tu peux aussi déposer un fichier : <input type="file" id="s-file" multiple accept=".ts,.tsx,.js,.jsx,.py,.php,.go,.rs,.java,.kt,.swift,.sql,.html,.css,.sh,.txt,.md,.vue,.json" style="font-size:10px"></p>
        </div>
      </div>
      <div class="form-actions">
        <button class="btn" type="button" data-close-modal>Annuler</button>
        <button class="btn primary" type="submit"><i class="ri-upload-cloud-2-line"></i>Envoyer et analyser</button>
      </div>
    </form>`,
    'wide',
  )

  const form = $<HTMLFormElement>('#submissionForm', panel)
  const codeField = $<HTMLTextAreaElement>('#s-code', panel)

  // Dépôt de fichiers : chaque fichier est préfixé de son nom pour que la revue
  // puisse situer les défauts qu'elle relève.
  $<HTMLInputElement>('#s-file', panel).addEventListener('change', async (event) => {
    const files = Array.from((event.target as HTMLInputElement).files ?? [])
    if (!files.length) return
    const parts = await Promise.all(
      files.map(async (file) => `// ===== fichier : ${file.name} =====\n${await file.text()}`),
    )
    codeField.value = [codeField.value.trim(), ...parts].filter(Boolean).join('\n\n')
    toast(`${files.length} fichier(s) ajouté(s).`)
  })

  // Pré-remplissage du titre à partir de la tâche choisie : un intitulé vide est
  // la première cause de livraisons illisibles dans la liste des revues.
  const taskSelect = $<HTMLSelectElement>('#s-task', panel)
  const titleField = $<HTMLInputElement>('#s-title', panel)
  const syncTitle = (): void => {
    const task = tasks.find((entry) => entry.id === taskSelect.value)
    if (task && !titleField.value.trim()) titleField.value = task.title
  }
  taskSelect.addEventListener('change', syncTitle)
  syncTitle()

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    submitting(form, true)
    const data = new FormData(form)

    try {
      const submission = await api.createSubmission({
        project_id: project.id,
        task_id: String(data.get('task_id') ?? '') || null,
        title: String(data.get('title') ?? ''),
        language: String(data.get('language') ?? 'typescript'),
        branch: String(data.get('branch') ?? ''),
        repo_url: String(data.get('repo_url') ?? ''),
        notes: String(data.get('notes') ?? ''),
        code: String(data.get('code') ?? ''),
      })
      upsertSubmission(submission)

      // La tâche passe en revue : elle n'est « terminée » qu'une fois la
      // livraison validée, pas au moment où le développeur la soumet.
      if (submission.task_id) {
        const task = state.tasks.find((entry) => entry.id === submission.task_id)
        if (task && task.status !== 'done') upsertTask(await api.updateTask(task.id, { status: 'review' }))
      }

      void api
        .logActivity({
          project_id: project.id,
          task_id: submission.task_id,
          kind: 'submission',
          text: `Livraison envoyée : ${submission.title}.`,
        })
        .then((entry) => entry && pushActivity(entry))

      closeModal()
      toast('Livraison envoyée. Analyse en cours…')

      // Import différé : la vue des revues importe ce module pour son bouton
      // « livrer une nouvelle version », les deux se référencent mutuellement.
      const { runReview } = await import('./views/reviews.js')
      await runReview(submission.id)
    } catch (error) {
      toast((error as Error).message, 'error')
      submitting(form, false)
    }
  })
}

/* ------------------------------------- découpage du brief en tâches (IA) */

export async function openTaskPlanner(): Promise<void> {
  const project = currentProject()
  if (!project || !canManage(project.id)) {
    toast('Réservé au manager du projet.', 'error')
    return
  }

  const panel = openModal(
    `
    <div class="panel-head">
      <div><h2>Découper le brief en tâches</h2><p>Analyse du brief publié en cours…</p></div>
      <button class="icon-btn" type="button" data-close-modal aria-label="Fermer"><i class="ri-close-line"></i></button>
    </div>
    <div class="empty compact"><div><i class="ri-loader-4-line spinning"></i><b>Lecture du brief</b><span>Le plan proposé restera modifiable avant création.</span></div></div>`,
    'wide',
  )

  let proposals: Partial<Task>[]
  try {
    proposals = (await aiApi.planTasks({ projectId: project.id, count: 12 })).tasks
  } catch (error) {
    closeModal()
    toast((error as Error).message, 'error')
    return
  }

  if (!proposals.length) {
    closeModal()
    toast("L'analyse n'a produit aucune tâche exploitable.", 'error')
    return
  }

  panel.innerHTML = `
    <div class="panel-head">
      <div><h2>${proposals.length} tâches proposées</h2><p>Décoche ce que tu ne veux pas, puis crée les tâches retenues.</p></div>
      <button class="icon-btn" type="button" data-close-modal aria-label="Fermer"><i class="ri-close-line"></i></button>
    </div>
    <div class="proposal-list" id="proposalList">
      ${proposals
        .map(
          (task, index) => `
        <label class="proposal checked" data-index="${index}">
          <input type="checkbox" checked>
          <span>
            <b>${escapeHtml(task.title ?? '')}</b>
            <p>${escapeHtml(task.description ?? '')}</p>
            <span class="proposal-meta">
              <span class="chip muted">${escapeHtml(TASK_KINDS[(task.kind ?? 'feature') as keyof typeof TASK_KINDS].label)}</span>
              <span class="chip ${PRIORITIES[(task.priority ?? 'medium') as keyof typeof PRIORITIES].chip}">${PRIORITIES[(task.priority ?? 'medium') as keyof typeof PRIORITIES].label}</span>
              <span class="chip muted">${task.estimate ?? 0} h</span>
              <span class="chip muted">${(task.acceptance ?? []).length} critère(s)</span>
            </span>
          </span>
        </label>`,
        )
        .join('')}
    </div>
    <div class="form-actions">
      <button class="btn" type="button" data-close-modal>Annuler</button>
      <button class="btn primary" type="button" id="createProposals"><i class="ri-check-line"></i>Créer les tâches retenues</button>
    </div>`

  $$('.proposal', panel).forEach((node) => {
    const input = node.querySelector<HTMLInputElement>('input')
    input?.addEventListener('change', () => node.classList.toggle('checked', input.checked))
  })

  $('#createProposals', panel).addEventListener('click', async (event) => {
    const button = event.currentTarget as HTMLButtonElement
    button.disabled = true
    const selected = $$('.proposal', panel)
      .filter((node) => node.querySelector<HTMLInputElement>('input')?.checked)
      .map((node) => proposals[Number(node.dataset.index)])

    try {
      for (const [index, proposal] of selected.entries()) {
        const created = await api.createTask({
          ...proposal,
          project_id: project.id,
          status: 'backlog',
          order_index: Date.now() + index,
        })
        upsertTask(created)
      }
      void api
        .logActivity({
          project_id: project.id,
          kind: 'task',
          text: `${selected.length} tâche(s) créées depuis le brief.`,
        })
        .then((entry) => entry && pushActivity(entry))
      closeModal()
      toast(`${selected.length} tâche(s) créées dans le backlog.`)
    } catch (error) {
      toast((error as Error).message, 'error')
      button.disabled = false
    }
  })
}

/* ------------------------------------------------------------ mon profil */

export function openProfileForm(): void {
  const profile = state.profile
  if (!profile) return

  const panel = openModal(`
    <form id="profileForm">
      <div class="panel-head">
        <div><h2>Mon profil</h2><p>Visible par le reste de l'équipe sur les projets partagés.</p></div>
        <button class="icon-btn" type="button" data-close-modal aria-label="Fermer"><i class="ri-close-line"></i></button>
      </div>
      <div class="field-group"><label for="me-name">Nom complet</label>
        <input class="field" id="me-name" name="full_name" value="${escapeHtml(profile.full_name)}" placeholder="Camille Durand"></div>
      <div class="field-group"><label for="me-title">Intitulé de poste</label>
        <input class="field" id="me-title" name="job_title" value="${escapeHtml(profile.job_title)}" placeholder="Développeuse back-end"></div>
      <div class="field-group"><label for="me-skills">Compétences (séparées par des virgules)</label>
        <input class="field" id="me-skills" name="skills" value="${escapeHtml(profile.skills.join(', '))}" placeholder="TypeScript, PostgreSQL, Docker"></div>
      <div class="form-actions">
        <button class="btn" type="button" data-close-modal>Annuler</button>
        <button class="btn primary" type="submit"><i class="ri-check-line"></i>Enregistrer</button>
      </div>
    </form>`)

  const form = $<HTMLFormElement>('#profileForm', panel)
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    submitting(form, true)
    const data = new FormData(form)
    try {
      const updated = await api.updateOwnProfile({
        full_name: String(data.get('full_name') ?? ''),
        job_title: String(data.get('job_title') ?? ''),
        skills: String(data.get('skills') ?? '')
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean),
      })
      state.profile = updated
      state.people = state.people.map((person) => (person.id === updated.id ? updated : person))
      closeModal()
      notify()
      toast('Profil mis à jour.')
    } catch (error) {
      toast((error as Error).message, 'error')
      submitting(form, false)
    }
  })
}

export const canCreateProject = (): boolean => isManager()
