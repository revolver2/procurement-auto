'use strict'

const fs   = require('fs')
const path = require('path')

async function extractText(localPath) {
  if (!localPath || !fs.existsSync(localPath)) {
    return { text: '', textExtracted: false, error: 'Fichier introuvable', requiresOCR: false }
  }

  const lower = localPath.toLowerCase()

  if (lower.endsWith('.zip'))  return extractZip(localPath)
  if (lower.endsWith('.pdf'))  return extractPDF(localPath)
  if (lower.endsWith('.docx')) return extractDOCX(localPath)
  if (lower.endsWith('.doc'))  return extractDOCX(localPath)  // best-effort via adm-zip
  if (lower.endsWith('.txt'))  {
    const text = fs.readFileSync(localPath, 'utf8').replace(/\s+/g, ' ').trim()
    return { text, textExtracted: !!text, requiresOCR: false, charCount: text.length }
  }

  return { text: '', textExtracted: false, error: 'Format non supporté', requiresOCR: false }
}

/* ── PDF ──────────────────────────────────────────────────────── */
async function extractPDF(filePath) {
  let pdfParse
  try { pdfParse = require('pdf-parse') }
  catch { return { text: '', textExtracted: false, error: 'pdf-parse non installé', requiresOCR: false } }

  try {
    const buffer = fs.readFileSync(filePath)
    const data   = await pdfParse(buffer, { max: 0 })
    const raw    = (data.text || '').replace(/\s+/g, ' ').trim()

    if (!raw || raw.length < 30) {
      return {
        text: '', textExtracted: false, requiresOCR: true,
        pageCount: data.numpages || 0,
        error: 'PDF scanné ou vide — OCR requis',
      }
    }

    return { text: raw, textExtracted: true, requiresOCR: false, pageCount: data.numpages || 0, charCount: raw.length }
  } catch (e) {
    // Only flag requiresOCR when the file is a structurally valid PDF (starts with %PDF-)
    // macOS resource forks and corrupt files should not be flagged as OCR-required
    let isPdfStructure = false
    try {
      const magic = fs.readFileSync(filePath, { flag: 'r' }).slice(0, 5).toString('ascii')
      isPdfStructure = magic.startsWith('%PDF-')
    } catch {}
    return { text: '', textExtracted: false, requiresOCR: isPdfStructure, error: `PDF invalide: ${e.message}` }
  }
}

/* ── DOCX / DOC (XML-based .docx) ────────────────────────────── */
async function extractDOCX(filePath) {
  let AdmZip
  try { AdmZip = require('adm-zip') } catch {
    return { text: '', textExtracted: false, error: 'adm-zip non installé', requiresOCR: false }
  }

  try {
    const zip = new AdmZip(filePath)
    // DOCX stores content in word/document.xml
    const xmlEntry = zip.getEntries().find(e =>
      e.entryName === 'word/document.xml' || e.entryName.endsWith('/word/document.xml')
    )
    if (!xmlEntry) {
      return { text: '', textExtracted: false, error: 'word/document.xml introuvable dans DOCX', requiresOCR: false }
    }

    const xml  = zip.readAsText(xmlEntry, 'utf8')
    // Strip XML tags, preserve paragraph breaks
    const text = xml
      .replace(/<w:p[ >]/g, '\n<w:p ')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .replace(/\n\s+/g, '\n')
      .trim()

    if (!text || text.length < 20) {
      return { text: '', textExtracted: false, error: 'DOCX vide ou non lisible', requiresOCR: false }
    }

    return { text, textExtracted: true, requiresOCR: false, charCount: text.length }
  } catch (e) {
    return { text: '', textExtracted: false, error: `DOCX échoué: ${e.message}`, requiresOCR: false }
  }
}

/* ── ZIP: recursive search — find all exploitable files ──────── */
async function extractZip(zipPath) {
  let AdmZip
  try { AdmZip = require('adm-zip') } catch {
    return { text: '', textExtracted: false, error: 'adm-zip non installé', requiresOCR: false }
  }

  try {
    const zip     = new AdmZip(zipPath)
    const entries = zip.getEntries()
    const dir     = zipPath + '_extracted'
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

    // Score each entry: lower = higher priority
    const scored = entries
      .filter(en => !en.isDirectory)
      // Skip macOS resource forks (__MACOSX/ dirs and ._prefixed files)
      .filter(en => !en.entryName.startsWith('__MACOSX/') && !path.basename(en.entryName).startsWith('._'))
      .map(en => {
        const n = en.entryName.toLowerCase()
        let score = 99
        if (/avis/i.test(n) && n.endsWith('.pdf'))    score = 0
        else if (/avis/i.test(n))                     score = 1
        else if (/consultation/i.test(n) && n.endsWith('.pdf')) score = 2
        else if (/bon.*commande/i.test(n))            score = 3
        else if (n.endsWith('.pdf'))                   score = 4
        else if (n.endsWith('.docx'))                  score = 5
        else if (n.endsWith('.doc'))                   score = 6
        else if (n.endsWith('.txt'))                   score = 7
        return { entry: en, score }
      })
      .sort((a, b) => a.score - b.score)

    let bestResult = { text: '', textExtracted: false, error: 'Aucun fichier exploitable dans le ZIP', requiresOCR: false }

    for (const { entry } of scored) {
      const name    = entry.entryName
      const lower   = name.toLowerCase()
      const outName = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_')
      const outPath = path.join(dir, outName)

      try {
        // Use extractEntryTo for any depth — gets the raw entry regardless of directory
        const buf = entry.getData()
        fs.writeFileSync(outPath, buf)
      } catch { continue }

      let result
      if (lower.endsWith('.pdf'))        result = await extractPDF(outPath)
      else if (lower.endsWith('.docx') || lower.endsWith('.doc')) result = await extractDOCX(outPath)
      else if (lower.endsWith('.txt'))   {
        const text = fs.readFileSync(outPath, 'utf8').replace(/\s+/g, ' ').trim()
        result = { text, textExtracted: !!text, requiresOCR: false, charCount: text.length }
      }
      else continue

      result.sourceFile = name

      if (result.textExtracted && result.text) {
        // Always prefer AVIS files; otherwise take first success
        if (!bestResult.textExtracted || /avis/i.test(name)) {
          bestResult = result
        }
        if (/avis/i.test(name)) break  // perfect match — stop
      } else if (!bestResult.textExtracted && result.requiresOCR) {
        bestResult = result  // keep OCR flag even if no text
      }
    }

    return bestResult
  } catch (e) {
    return { text: '', textExtracted: false, error: `Erreur ZIP: ${e.message}`, requiresOCR: false }
  }
}

module.exports = { extractText, extractPDF, extractZip, extractDOCX }
