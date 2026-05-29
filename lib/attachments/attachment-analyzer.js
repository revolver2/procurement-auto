'use strict'

const fs   = require('fs')
const path = require('path')
const { findAttachments }    = require('./attachment-finder')
const { downloadAttachment, ATTACHMENTS_DIR } = require('./attachment-downloader')
const { extractText }        = require('./pdf-text-extractor')

const SPECS_DIR  = path.resolve(__dirname, '..', '..', 'data', 'specifications')
const AGG_FILE   = path.resolve(__dirname, '..', '..', 'data', 'attachment-specs.json')

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }) }

/* ── Aggregate spec store (single file → survives on GitHub) ─────── */
function loadAggregateSpecs() {
  try { return fs.existsSync(AGG_FILE) ? JSON.parse(fs.readFileSync(AGG_FILE, 'utf8')) : {} }
  catch { return {} }
}

function saveAggregateSpec(bonId, data) {
  const agg = loadAggregateSpecs()
  agg[bonId] = data
  try { fs.writeFileSync(AGG_FILE, JSON.stringify(agg)) }
  catch (e) { console.warn('[AttachmentSpec] Aggregate write failed:', e.message) }
}

/* ── Per-project spec persistence ───────────────────────────────── */
function loadSpec(bonId) {
  ensureDir(SPECS_DIR)
  // Try per-file first (fastest, preserves until restart)
  const p = path.join(SPECS_DIR, `${bonId}.json`)
  if (fs.existsSync(p)) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch {}
  }
  // Fall back to aggregate (survives across Render restarts via GitHub sync)
  const agg = loadAggregateSpecs()
  return agg[bonId] || null
}

function saveSpec(bonId, data) {
  ensureDir(SPECS_DIR)
  fs.writeFileSync(path.join(SPECS_DIR, `${bonId}.json`), JSON.stringify(data, null, 2))
  // Also write to aggregate so it's included in the GitHub-synced file
  saveAggregateSpec(bonId, data)
}

/* ── Hydrate per-file specs from aggregate (call on startup) ─────── */
function hydrateSpecsFromAggregate() {
  ensureDir(SPECS_DIR)
  const agg = loadAggregateSpecs()
  let restored = 0
  for (const [bonId, data] of Object.entries(agg)) {
    const p = path.join(SPECS_DIR, `${bonId}.json`)
    if (!fs.existsSync(p)) {
      try { fs.writeFileSync(p, JSON.stringify(data, null, 2)); restored++ }
      catch {}
    }
  }
  if (restored) console.log(`[AttachmentSpec] Restored ${restored} spec files from aggregate`)
  return restored
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
      ocrUsed:       ext.ocrUsed       || false,
      sourceFile:    ext.sourceFile    || null,
      sourceZip:     ext.sourceZip     || null,
      extractedPath: ext.extractedPath || null,
      textLength:    ext.text?.length  || 0,
      error:         ext.error         || null,
    })

    if (!primaryText && ext.textExtracted && ext.text) {
      primaryText = ext.text
      primaryName = (ext.sourceFile || fname) + (ext.sourceZip ? ` (depuis ${ext.sourceZip})` : '')
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
      ocrUsed:       ext.ocrUsed      || false,
      sourceFile:    ext.sourceFile   || null,  // PDF name inside ZIP
      sourceZip:     ext.sourceZip    || null,  // ZIP filename (when applicable)
      extractedPath: ext.extractedPath|| null,
      textLength:    ext.text?.length  || 0,
      error:         dl.error || ext.error || null,
    })

    if (!primaryText && ext.textExtracted && ext.text) {
      primaryText = ext.text
      primaryName = (ext.sourceFile || att.name) + (ext.sourceZip ? ` (depuis ${ext.sourceZip})` : '')
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

module.exports = { processFromUrls, processFromPage, reExtractFromCache, loadSpec, saveSpec, hydrateSpecsFromAggregate, SPECS_DIR, ATTACHMENTS_DIR, AGG_FILE }
