'use strict'

const fs   = require('fs')
const path = require('path')

async function extractText(localPath) {
  if (!localPath || !fs.existsSync(localPath)) {
    return { text: '', textExtracted: false, error: 'Fichier introuvable', requiresOCR: false }
  }

  const lower = localPath.toLowerCase()

  if (lower.endsWith('.zip')) return extractZip(localPath)
  if (lower.endsWith('.pdf')) return extractPDF(localPath)
  if (lower.endsWith('.txt')) {
    const text = fs.readFileSync(localPath, 'utf8').replace(/\s+/g, ' ').trim()
    return { text, textExtracted: !!text, requiresOCR: false, charCount: text.length }
  }

  return { text: '', textExtracted: false, error: 'Format non supporté pour extraction', requiresOCR: false }
}

/* ── ZIP: extract → find PDF/text inside ───────────────────────── */
async function extractZip(zipPath) {
  let AdmZip
  try { AdmZip = require('adm-zip') }
  catch { return { text: '', textExtracted: false, error: 'adm-zip non installé', requiresOCR: false } }

  try {
    const zip     = new AdmZip(zipPath)
    const entries = zip.getEntries()

    const dir     = zipPath + '_extracted'
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

    let bestResult = { text: '', textExtracted: false, error: 'Aucun fichier exploitable dans le ZIP', requiresOCR: false }

    // Sort: AVIS PDFs first, then other PDFs, then text files
    const sorted = [...entries].sort((a, b) => {
      const an = a.entryName.toLowerCase()
      const bn = b.entryName.toLowerCase()
      const aScore = /avis/.test(an) ? 0 : /\.pdf$/.test(an) ? 1 : /\.txt$/.test(an) ? 2 : 9
      const bScore = /avis/.test(bn) ? 0 : /\.pdf$/.test(bn) ? 1 : /\.txt$/.test(bn) ? 2 : 9
      return aScore - bScore
    })

    for (const entry of sorted) {
      if (entry.isDirectory) continue
      const name  = entry.entryName
      const lower = name.toLowerCase()
      if (!lower.endsWith('.pdf') && !lower.endsWith('.txt')) continue

      const outPath = path.join(dir, path.basename(name))
      zip.extractEntryTo(entry, dir, false, true)

      const result = lower.endsWith('.pdf') ? await extractPDF(outPath) : (() => {
        const text = fs.readFileSync(outPath, 'utf8').replace(/\s+/g, ' ').trim()
        return { text, textExtracted: !!text, requiresOCR: false, charCount: text.length, sourceFile: name }
      })()

      result.sourceFile = name

      if (result.textExtracted) {
        // Prefer AVIS files
        if (!bestResult.textExtracted || /avis/i.test(name)) {
          bestResult = result
        }
        if (/avis/i.test(name)) break
      } else if (!bestResult.textExtracted && result.requiresOCR) {
        bestResult = result
      }
    }

    return bestResult
  } catch (e) {
    return { text: '', textExtracted: false, error: `Erreur ZIP: ${e.message}`, requiresOCR: false }
  }
}

/* ── PDF: use pdf-parse ─────────────────────────────────────────── */
async function extractPDF(filePath) {
  let pdfParse
  try { pdfParse = require('pdf-parse') }
  catch { return { text: '', textExtracted: false, error: 'pdf-parse non installé (npm install pdf-parse)', requiresOCR: false } }

  try {
    const buffer = fs.readFileSync(filePath)
    const data   = await pdfParse(buffer, { max: 0 })
    const raw    = (data.text || '').replace(/\s+/g, ' ').trim()

    if (!raw || raw.length < 30) {
      return {
        text: '', textExtracted: false, requiresOCR: true,
        pageCount: data.numpages || 0,
        error: 'PDF scanné ou vide — OCR requis pour extraction du texte',
      }
    }

    return {
      text:       raw,
      textExtracted: true,
      requiresOCR:   false,
      pageCount:  data.numpages || 0,
      charCount:  raw.length,
    }
  } catch (e) {
    return {
      text: '', textExtracted: false, requiresOCR: true,
      error: `Extraction PDF échouée: ${e.message}`,
    }
  }
}

module.exports = { extractText, extractPDF, extractZip }
