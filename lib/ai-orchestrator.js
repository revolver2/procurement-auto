'use strict'

const db = require('./db')

/* ── Lazy-load skills (avoids startup errors if Groq key missing) ── */
const skills = {
  get detection()    { return require('./skills/tender-detection') },
  get aluminium()    { return require('./skills/aluminium-skill') },
  get inox()         { return require('./skills/inox-skill') },
  get metal()        { return require('./skills/metal-skill') },
  get bordereau()    { return require('./skills/bordereau-skill') },
  get rfq()          { return require('./skills/rfq-skill') },
  get execution()    { return require('./skills/execution-plan-skill') },
  get profitability(){ return require('./skills/profitability-skill') },
  get risk()         { return require('./skills/risk-analysis-skill') },
  get supplier()     { return require('./skills/supplier-intelligence-skill') },
  get winning()      { return require('./skills/winning-probability-skill') },
  get copilot()      { return require('./skills/procurement-copilot-skill') },
}

/* ── Activity → skill mapping ──────────────────────────────────── */
const ACTIVITY_SKILL = {
  aluminium: 'aluminium',
  inox:      'inox',
  metal:     'metal',
  fourniture:'aluminium',  // default to aluminium for fourniture et pose
  vitrage:   'aluminium',  // vitrerie often involves aluminium frames
  panneaux:  'metal',
  cloison:   'aluminium',
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
  const { generateDocuments = false, forceRefresh = false } = options

  // Load bon
  const bons = db.read('procurement-analysis.json') || []
  const bon  = bons.find(b => b.id === bonId)
  if (!bon) throw new Error(`Bon ${bonId} introuvable`)

  // Return cached if exists and not forced
  if (!forceRefresh) {
    const cached = getOrchestration(bonId)
    if (cached) return cached
  }

  const memory  = getMemory()
  const results = { bonId, bon }
  const log     = []

  try {
    // ── STEP 1: Tender detection (fast, local) ──────────────────
    log.push('🔍 Détection activité...')
    results.detection = skills.detection.analyze(bon)
    log.push(`✅ Activité: ${results.detection.primaryLabel || 'Aucune'} (score: ${results.detection.relevanceScore})`)

    if (!results.detection.isRelevant) {
      results.warning = 'Bon peu pertinent pour les activités cibles'
    }

    // ── STEP 2: Activity-specific skill (AI) ───────────────────
    const activityId  = bon.categoryMatched || results.detection.primaryActivity
    const skillName   = ACTIVITY_SKILL[activityId] || 'aluminium'
    log.push(`🔧 Analyse ${skillName}...`)
    try {
      results.activity = await skills[skillName].analyze(bon, memory)
      log.push(`✅ Analyse ${skillName} terminée`)
    } catch (e) {
      log.push(`⚠️ ${skillName}: ${e.message}`)
      results.activity = null
    }

    // ── STEP 3: Parallel analysis skills ──────────────────────
    log.push('⚡ Analyses parallèles (rentabilité + risques + probabilité)...')
    const [profitability, risk, supplier] = await Promise.allSettled([
      skills.profitability.analyze(bon, results.activity || {}, memory),
      skills.risk.analyze(bon, results.activity || {}),
      skills.supplier.analyze(bon, results.activity || {}, memory),
    ])

    results.profitability = profitability.status === 'fulfilled' ? profitability.value : null
    results.risk          = risk.status          === 'fulfilled' ? risk.value          : null
    results.supplier      = supplier.status      === 'fulfilled' ? supplier.value      : null

    log.push(`✅ Rentabilité: ${results.profitability?.attractivenessLabel || '—'}`)
    log.push(`✅ Risque: ${results.risk?.overallRiskLevel || '—'}`)

    // ── STEP 4: Winning probability ────────────────────────────
    try {
      results.winProbability = await skills.winning.analyze(
        bon, results.activity || {}, results.profitability || {}, memory
      )
      log.push(`✅ Probabilité succès: ${results.winProbability.winProbabilityPercent}%`)
    } catch (e) {
      log.push(`⚠️ Probabilité: ${e.message}`)
      results.winProbability = null
    }

    // ── STEP 5: Documents (optional, slower) ──────────────────
    if (generateDocuments) {
      log.push('📄 Génération documents...')
      const [bordereau, rfq, execution] = await Promise.allSettled([
        skills.bordereau.generate(bon, results.activity || {}, memory),
        skills.rfq.generate(bon, results.activity || {}, memory),
        skills.execution.generate(bon, results.activity || {}),
      ])
      results.bordereau = bordereau.status === 'fulfilled' ? bordereau.value : null
      results.rfq       = rfq.status       === 'fulfilled' ? rfq.value       : null
      results.execution = execution.status === 'fulfilled' ? execution.value : null
      log.push('✅ Documents générés')
    }

    // ── STEP 6: Update bon in DB with skill insights ───────────
    const bonIdx = bons.findIndex(b => b.id === bonId)
    if (bonIdx >= 0) {
      bons[bonIdx] = {
        ...bons[bonIdx],
        orchestrated:       true,
        orchestratedAt:     new Date().toISOString(),
        relevanceScore:     results.detection.relevanceScore,
        urgencyLevel:       results.detection.urgencyLevel,
        attractivenessScore:results.profitability?.attractivenessScore || null,
        riskScore:          results.risk?.overallRiskScore || null,
        winProbability:     results.winProbability?.winProbabilityPercent || null,
        goNoGo:             results.risk?.goNoGo || null,
        recommendation:     results.winProbability?.recommendation || null,
      }
      db.write('procurement-analysis.json', bons)
    }

    results.log          = log
    results.orchestratedAt = new Date().toISOString()
    results.success      = true

    // Save full orchestration to cache
    saveOrchestration(bonId, results)

    return results
  } catch (e) {
    results.error   = e.message
    results.success = false
    results.log     = log
    return results
  }
}

/* ── Quick detection only (used after scraping) ─────────────────── */
async function quickDetect(bon) {
  const detection = skills.detection.analyze(bon)
  return detection
}

/* ── Chat with project context ─────────────────────────────────── */
async function chat(message, bonId, conversationHistory = []) {
  const bons   = db.read('procurement-analysis.json') || []
  const bon    = bons.find(b => b.id === bonId) || null
  const cached = bonId ? getOrchestration(bonId) : null
  const memory = getMemory()

  const skillResults = cached ? {
    detection:     cached.detection,
    activity:      cached.activity,
    profitability: cached.profitability,
    risk:          cached.risk,
    winProbability:cached.winProbability,
  } : {}

  return skills.copilot.chat(message, bon, skillResults, conversationHistory, memory)
}

module.exports = { orchestrate, quickDetect, chat, getOrchestration, getMemory }
