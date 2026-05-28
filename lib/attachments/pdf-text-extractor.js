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
  if (lower.endsWith('.doc'))  return extractDOCX(localPath)
  if (lower.endsWith('.txt'))  {
    const text = fs.readFileSync(localPath, 'utf8').replace(/\s+/g, ' ').trim()
    return { text, textExtracted: !!text, requiresOCR: false, charCount: text.length }
  }

  return { text: '', textExtracted: false, error: 'Format non supporté', requiresOCR: false }
}

/* ── Gemini vision OCR (fallback for scanned PDFs) ──────────── */
async function _ocrWithGemini(filePath) {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return null

  try {
    const stat = fs.statSync(filePath)
    if (stat.size > 20 * 1024 * 1024) return null  // >20 MB — skip inline

    const base64 = fs.readFileSync(filePath).toString('base64')
    const url    = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`

    const body = JSON.stringify({
      contents: [{
        parts: [
          { inline_data: { mime_type: 'application/pdf', data: base64 } },
          { text: `Tu es un extracteur de texte précis. Extrais TOUT le texte visible de ce document PDF exactement tel qu'il apparaît. Ne reformule pas, ne résume pas, ne traduis pas. Retourne uniquement le texte brut du document en préservant la structure (titres, sections, tableaux ligne par ligne). Si le document contient des tableaux, retourne le contenu des cellules séparées par des tabulations.` },
        ],
      }],
      generationConfig: { temperature: 0, maxOutputTokens: 8192 },
    })

    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal:  AbortSignal.timeout(120000),
    })

    const data = await res.json()
    if (!res.ok) {
      console.warn('[OCR] Gemini error:', data?.error?.message || res.status)
      return null
    }

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || ''
    if (!text || text.length < 50) return null

    return text.trim()
  } catch (e) {
    console.warn('[OCR] Gemini OCR failed:', e.message)
    return null
  }
}

/* ── PDF ─────────────────────────────────────────────────────── */
async function extractPDF(filePath) {
  let pdfParse
  try { pdfParse = require('pdf-parse') }
  catch { return _pdfFallback(filePath, 'pdf-parse non installé', 0) }

  let pageCount = 0
  try {
    const buffer = fs.readFileSync(filePath)
    const data   = await pdfParse(buffer, { max: 0 })
    pageCount    = data.numpages || 0
    const raw    = (data.text || '').replace(/\s+/g, ' ').trim()

    if (raw && raw.length >= 30) {
      return { text: raw, textExtracted: true, requiresOCR: false, pageCount, charCount: raw.length }
    }

    // Scanned PDF — no text layer — try Gemini OCR
    return _pdfFallback(filePath, 'PDF scanné — aucun texte extractible', pageCount)
  } catch (e) {
    // Only attempt OCR for structurally valid PDFs
    let isPdf = false
    try {
      const magic = fs.readFileSync(filePath).slice(0, 5).toString('ascii')
      isPdf = magic.startsWith('%PDF-')
    } catch {}

    if (!isPdf) return { text: '', textExtracted: false, requiresOCR: false, error: 'Fichier non-PDF invalide' }
    return _pdfFallback(filePath, `pdf-parse échoué: ${e.message}`, pageCount)
  }
}

async function _pdfFallback(filePath, reason, pageCount) {
  // Try Gemini vision OCR
  const ocrText = await _ocrWithGemini(filePath)
  if (ocrText) {
    return {
      text:          ocrText,
      textExtracted: true,
      requiresOCR:   false,
      ocrUsed:       true,
      ocrEngine:     'gemini',
      pageCount,
      charCount:     ocrText.length,
    }
  }
  // OCR not available or failed
  return {
    text:          '',
    textExtracted: false,
    requiresOCR:   true,
    pageCount,
    error:         reason + (process.env.GEMINI_API_KEY ? ' (Gemini OCR échoué)' : ' — OCR non disponible'),
  }
}

/* ── DOCX / DOC ──────────────────────────────────────────────── */
async function extractDOCX(filePath) {
  let AdmZip
  try { AdmZip = require('adm-zip') } catch {
    return { text: '', textExtracted: false, error: 'adm-zip non installé', requiresOCR: false }
  }

  try {
    const zip      = new AdmZip(filePath)
    const xmlEntry = zip.getEntries().find(e =>
      e.entryName === 'word/document.xml' || e.entryName.endsWith('/word/document.xml')
    )
    if (!xmlEntry) {
      return { text: '', textExtracted: false, error: 'word/document.xml introuvable dans DOCX', requiresOCR: false }
    }

    const xml  = zip.readAsText(xmlEntry, 'utf8')
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

/* ── ZIP ─────────────────────────────────────────────────────── */
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

    const scored = entries
      .filter(en => !en.isDirectory)
      .filter(en => !en.entryName.startsWith('__MACOSX/') && !path.basename(en.entryName).startsWith('._'))
      .map(en => {
        const n = en.entryName.toLowerCase()
        let score = 99
        if (/avis/i.test(n)         && n.endsWith('.pdf'))  score = 0
        else if (/avis/i.test(n))                           score = 1
        else if (/consultation/i.test(n) && n.endsWith('.pdf')) score = 2
        else if (/bon.*commande/i.test(n))                  score = 3
        else if (n.endsWith('.pdf'))                         score = 4
        else if (n.endsWith('.docx'))                        score = 5
        else if (n.endsWith('.doc'))                         score = 6
        else if (n.endsWith('.txt'))                         score = 7
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
        const buf = entry.getData()
        fs.writeFileSync(outPath, buf)
      } catch { continue }

      let result
      if      (lower.endsWith('.pdf'))                       result = await extractPDF(outPath)
      else if (lower.endsWith('.docx') || lower.endsWith('.doc')) result = await extractDOCX(outPath)
      else if (lower.endsWith('.txt')) {
        const text = fs.readFileSync(outPath, 'utf8').replace(/\s+/g, ' ').trim()
        result = { text, textExtracted: !!text, requiresOCR: false, charCount: text.length }
      }
      else continue

      result.sourceFile = name

      if (result.textExtracted && result.text) {
        if (!bestResult.textExtracted || /avis/i.test(name)) bestResult = result
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

module.exports = { extractText, extractPDF, extractZip, extractDOCX }
