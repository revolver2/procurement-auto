'use strict'

const fs   = require('fs')
const path = require('path')
const { findAttachments }    = require('./attachment-finder')
const { downloadAttachment, ATTACHMENTS_DIR } = require('./attachment-downloader')
const { extractText }        = require('./pdf-text-extractor')

const SPECS_DIR = path.resolve(__dirname, '..', '..', 'data', 'specifications')

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }) }

/* ── Spec persistence ───────────────────────────────────────────── */
function loadSpec(bonId) {
  ensureDir(SPECS_DIR)
  const p = path.join(SPECS_DIR, `${bonId}.json`)
  try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null }
  catch { return null }
}

function saveSpec(bonId, data) {
  ensureDir(SPECS_DIR)
  fs.writeFileSync(path.join(SPECS_DIR, `${bonId}.json`), JSON.stringify(data, null, 2))
}

/* ── Entry point: from pre-captured document URLs ───────────────── */
async function processFromUrls(bon, rawDocs, context = null, opts = {}) {
  // Back-compat: opts used to be a boolean (forceRefresh)
  if (typeof opts === 'boolean') opts = { forceRefresh: opts }

  const { forceRefresh = false, forceDownload = false } = opts

  if (!forceRefresh) {
    const cached = loadSpec(bon.id)
    if (cached?.hasText) return { ...cached, fromCache: true }
  }

  const attachments = rawDocs
    .filter(d => d.url && /^https?:/.test(d.url))
    .map(d => {
      const name = (d.name || d.filename || '').trim()
      return { name, url: d.url, type: _classify(name), isAvis: /avis/i.test(name) }
    })
    .sort((a, b) => (b.isAvis ? 1 : 0) - (a.isAvis ? 1 : 0))

  return _process(bon, attachments, context, forceDownload)
}

/* ── Entry point: from live Playwright page ─────────────────────── */
async function processFromPage(bon, page, context = null, opts = {}) {
  if (typeof opts === 'boolean') opts = { forceRefresh: opts }
  const { forceRefresh = false, forceDownload = false } = opts

  if (!forceRefresh) {
    const cached = loadSpec(bon.id)
    if (cached?.hasText) return { ...cached, fromCache: true }
  }
  const found = await findAttachments(page)
  return _process(bon, found, context, forceDownload)
}

/* ── Re-extract from already-downloaded files (no HTTP needed) ───── */
async function reExtractFromCache(bon) {
  const safeId = bon.id.replace(/[^a-zA-Z0-9\-]/g, '_')
  const dir    = path.join(ATTACHMENTS_DIR, safeId)

  if (!fs.existsSync(dir)) {
    const result = _buildSpec(bon, [], null, null, 'no_files_cached')
    saveSpec(bon.id, result)
    return result
  }

  const files = fs.readdirSync(dir)
    .filter(f => /\.(zip|pdf|docx|doc|txt)$/i.test(f))
    .sort((a, b) => {
      // AVIS-named files first, then by size desc
      const aAvis = /avis/i.test(a) ? 0 : 1
      const bAvis = /avis/i.test(b) ? 0 : 1
      if (aAvis !== bAvis) return aAvis - bAvis
      try {
        return fs.statSync(path.join(dir, b)).size - fs.statSync(path.join(dir, a)).size
      } catch { return 0 }
    })

  if (!files.length) {
    const result = _buildSpec(bon, [], null, null, 'no_files_cached')
    saveSpec(bon.id, result)
    return result
  }

  const enriched  = []
  let primaryText = ''
  let primaryName = null

  for (const fname of files) {
    const fpath = path.join(dir, fname)
    const ext   = await extractText(fpath)

    enriched.push({
      name:          fname,
      url:           null,
      type:          _classify(fname),
      isAvis:        /avis/i.test(fname),
      localPath:     fpath,
      downloaded:    true,
      skipped:       true,
      textExtracted: ext.textExtracted || false,
      requiresOCR:   ext.requiresOCR   || false,
      sourceFile:    ext.sourceFile    || null,
      textLength:    ext.text?.length  || 0,
      error:         ext.error         || null,
    })

    if (!primaryText && ext.textExtracted && ext.text) {
      primaryText = ext.text
      primaryName = fname + (ext.sourceFile ? ` / ${ext.sourceFile}` : '')
    }
  }

  const result = _buildSpec(bon, enriched, primaryText, primaryName)
  saveSpec(bon.id, result)
  return result
}

/* ── Core pipeline ──────────────────────────────────────────────── */
async function _process(bon, attachments, context, forceDownload = false) {
  if (!attachments.length) {
    const result = _buildSpec(bon, [], null, null)
    saveSpec(bon.id, result)
    return result
  }

  const enriched    = []
  let primaryText   = ''
  let primaryName   = null

  for (const att of attachments) {
    const dl  = await downloadAttachment(att, bon.id, context, forceDownload)
    const ext = dl.localPath ? await extractText(dl.localPath) : { text: '', textExtracted: false }

    enriched.push({
      name:          att.name,
      url:           att.url,
      type:          att.type   || 'other',
      isAvis:        att.isAvis || false,
      localPath:     dl.localPath  || null,
      downloaded:    dl.downloaded || false,
      skipped:       dl.skipped    || false,
      textExtracted: ext.textExtracted || false,
      requiresOCR:   ext.requiresOCR  || false,
      sourceFile:    ext.sourceFile   || null,
      textLength:    ext.text?.length  || 0,
      error:         dl.error || ext.error || null,
    })

    if (!primaryText && ext.textExtracted && ext.text) {
      primaryText = ext.text
      primaryName = att.name + (ext.sourceFile ? ` / ${ext.sourceFile}` : '')
    }
  }

  const result = _buildSpec(bon, enriched, primaryText, primaryName)
  saveSpec(bon.id, result)
  return result
}

function _buildSpec(bon, attachments, text, name, extra = '') {
  return {
    bonId:             bon.id,
    bonReference:      bon.reference || '',
    attachments,
    primaryAvisText:   text || '',
    primaryAvisName:   name || null,
    hasText:           !!text,
    textLength:        text?.length || 0,
    noAttachmentFound: attachments.length === 0,
    analysisSource:    text ? 'official_attachment_only' : 'metadata_only',
    extractedAt:       new Date().toISOString(),
    extractionNote:    extra || null,
  }
}

function _classify(name) {
  if (/avis/i.test(name)) return 'avis'
  if (/cps|cahier/i.test(name)) return 'cps'
  return 'other'
}

module.exports = { processFromUrls, processFromPage, reExtractFromCache, loadSpec, SPECS_DIR }
