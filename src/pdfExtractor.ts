import * as pdfjsLib from 'pdfjs-dist'

// Configuration du worker pour pdfjs
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`

/**
 * Extrait l'intégralité du texte d'un fichier PDF directement dans le navigateur.
 */
export async function extractTextFromPdf(file: File): Promise<string> {
  try {
    const arrayBuffer = await file.arrayBuffer()
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(arrayBuffer),
      useWorkerFetch: false,
      useSystemFonts: true,
    })

    const pdf = await loadingTask.promise
    const pagesText: string[] = []

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum)
      const textContent = await page.getTextContent()
      const pageStrings = textContent.items
        .map((item) => ('str' in item ? (item as { str: string }).str : ''))
        .filter(Boolean)
      pagesText.push(pageStrings.join(' '))
    }

    const fullText = pagesText.join('\n\n').trim()
    if (fullText.length > 0) {
      return fullText
    }
  } catch (error) {
    console.warn('[nira-dev] extraction pdfjs échouée, essai de repli textuel', error)
  }

  // Repli basique si le PDF contient du texte brut sans compression complexe
  try {
    const text = await file.text()
    const matches = text.match(/\(([^()]+)\)T[jJ]/g)
    if (matches && matches.length) {
      return matches.map((m) => m.slice(1, -3)).join(' ')
    }
  } catch {}

  return ''
}
