'use strict'

const crypto = require('crypto')
const fs     = require('fs')
const path   = require('path')
const db     = require('./db')
const { loadSpec } = require('./attachments/attachment-analyzer')

const AI_CACHE_DIR = path.resolve(__dirname, '../data/ai-analysis')
function ensureCacheDir() { if (!fs.existsSync(AI_CACHE_DIR)) fs.mkdirSync(AI_CACHE_DIR, { recursive: true }) }

function sourceHash(bon) {
  const data = JSON.stringify({ id: bon.id, title: bon.title, officialText: bon.officialText?.substring(0, 500) || '' })
  return crypto.createHash('sha256').update(data).digest('hex').substring(0, 16)
}

function loadAiCache(bonId) {
  ensureCacheDir()
  const p = path.join(AI_CACHE_DIR, `${bonId}.json`)
  try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null } catch { return null }
}

function saveAiCache(bonId, results, hash) {
  ensureCacheDir()
  const record = { ...results, sourceHash: hash, cachedAt: new Date().toISOString(), cached: true }
  fs.writeFileSync(path.join(AI_CACHE_DIR, `${bonId}.json`), JSON.stringify(record, null, 2))
}

function getMemory() {
  return db.read('company-memory.json') || {}
}

function saveOrchestration(bonId, results) {
  const all = db.read('orchestrations.json') || []
  const idx = all.findIndex(o => o.bonId === bonId)
  const record = { bonId, ...results, savedAt: new Date().toISOString() }
  if (idx >= 0) all[idx] = record; else all.push(record)
  db.write('orchestrations.json', all)
}

function getOrchestration(bonId) {
  const all = db.read('orchestrations.json') || []
  return all.find(o => o.bonId === bonId) || null
}

/* ── Full pipeline ─────────────────────────────────────────────── */
async function orchestrate(bonId, options = {}) {
  const { forceRefresh = false } = options

  const bons = db.read('procurement-analysis.json') || []
  const bon  = bons.find(b => b.id === bonId)
  if (!bon) throw new Error(`Bon ${bonId} introuvable`)

  if (!forceRefresh) {
    const aiCache = loadAiCache(bonId)
    if (aiCache) return aiCache
    const cached = getOrchestration(bonId)
    if (cached) return cached
  }

  const log  = []
  const hash = sourceHash(bon)

  // ── Load official attachment text ─────────────────────────────
  const spec = loadSpec(bonId)
  if (spec?.hasText) {
    bon.officialText     = spec.primaryAvisText
    bon.officialTextName = spec.primaryAvisName
    bon.attachmentSpec   = spec
    log.push(`📎 Texte AVIS officiel chargé: ${spec.primaryAvisName} (${spec.textLength} chars)`)
  } else if (spec?.noAttachmentFound) {
    bon.officialText = null
    log.push(`ℹ️ Aucune pièce jointe — analyse sur métadonnées`)
  } else if (spec && !spec.hasText) {
    bon.officialText = null
    const ocrItems = (spec.attachments || []).filter(a => a.requiresOCR)
    if (ocrItems.length) log.push(`⚠️ AVIS scanné — OCR requis, analyse sur métadonnées`)
    else log.push(`ℹ️ Pièce jointe non extractible — analyse sur métadonnées`)
  } else {
    bon.officialText = null
    log.push(`ℹ️ Aucun fichier spec trouvé — lancer un scrape pour télécharger les pièces jointes`)
  }

  try {
    log.push(`🧠 Analyse Procurement Engineer (12 sections)...`)
    const master = await require('./skills/master-analysis-skill').analyze(bon)

    const isFallback = master.providerUsed === 'local-rulebased' || master.analysisType === 'fallback'
    if (isFallback) {
      log.push(`⚠️ Analyse locale (fallback): ${master.fallbackReason || 'Gemini indisponible'} — résultats limités`)
    } else {
      log.push(`✅ Analyse Gemini complète (${master.modelUsed}): ${master.materials?.length||0} matériaux, ${master.risks?.length||0} risques, ${master.bordereau?.length||0} lignes bordereau`)
    }

    const results = {
      bonId,
      ...master,
      // Top-level scores — null when fallback (do NOT fake 50/50)
      profitabilityScore: master.executive?.profitabilityScore ?? null,
      urgencyScore:       master.executive?.urgencyScore       ?? null,
      winningProbability: master.executive?.winningProbability ?? null,
      attachmentSpec:     spec || null,
      analysisSource:     bon.officialText ? 'official_attachment_only' : 'metadata_only',
      // Provider tracking (req 6)
      providerUsed:  master.providerUsed  || (isFallback ? 'local-rulebased' : 'gemini'),
      modelUsed:     master.modelUsed     || (isFallback ? 'local-rulebased' : 'gemini-2.5-flash'),
      analysisType:  master.analysisType  || (isFallback ? 'fallback' : 'full'),
      fallbackReason:master.fallbackReason|| null,
      log,
      orchestratedAt:  new Date().toISOString(),
      sourceHash:      hash,
      success:         true,
      cached:          false,
    }

    // Update bon in DB with key scores (only real scores — not fake 50/50)
    const bonIdx = bons.findIndex(b => b.id === bonId)
    if (bonIdx >= 0) {
      bons[bonIdx] = {
        ...bons[bonIdx],
        orchestrated:       true,
        orchestratedAt:     new Date().toISOString(),
        profitabilityScore: master.executive?.profitabilityScore || null,
        urgencyScore:       master.executive?.urgencyScore       || null,
        winningProbability: master.executive?.winningProbability || null,
        bidRecommendation:  master.executive?.bidRecommendation  || null,
        providerUsed:       results.providerUsed,
        analysisType:       results.analysisType,
      }
      db.write('procurement-analysis.json', bons)
    }

    saveOrchestration(bonId, results)
    saveAiCache(bonId, results, hash)
    return results
  } catch (e) {
    const results = { bonId, error: e.message, success: false, log, orchestratedAt: new Date().toISOString() }
    return results
  }
}

/* ── Quick detection only ──────────────────────────────────────── */
async function quickDetect(bon) {
  const { analyze } = require('./skills/tender-detection')
  return analyze(bon)
}

/* ── Chat with project context ─────────────────────────────────── */
async function chat(message, bonId, conversationHistory = []) {
  const bons   = db.read('procurement-analysis.json') || []
  const bon    = bons.find(b => b.id === bonId) || null
  const cached = bonId ? getOrchestration(bonId) : null
  const memory = getMemory()

  const skillResults = cached ? {
    executive:    cached.executive,
    materials:    cached.materials,
    risks:        cached.risks,
    winningStrategy: cached.winningStrategy,
    actionPlan:   cached.actionPlan,
  } : {}

  return require('./skills/procurement-copilot-skill').chat(message, bon, skillResults, conversationHistory, memory)
}

module.exports = { orchestrate, quickDetect, chat, getOrchestration, getMemory }
