'use strict'
require('dotenv').config()

const express   = require('express')
const cors      = require('cors')
const path      = require('path')
const fs        = require('fs')

const aiAnalyzer        = require('./lib/ai-analyzer')
const documentGenerator = require('./lib/document-generator')
const db                = require('./lib/db')
const scheduler         = require('./lib/scheduler')
const telegram          = require('./lib/telegram')
const orchestrator      = require('./lib/ai-orchestrator')
const githubPersist     = require('./lib/github-persist')
const { getActivities, getExclusionKeywords, bonMatchesKeywords } = require('./lib/scraper')

const docRenderers = {
  bordereau: require('./lib/document-renderers/bordereau-renderer'),
  devis:     require('./lib/document-renderers/devis-renderer'),
  rfq:       require('./lib/document-renderers/rfq-renderer'),
  plan:      require('./lib/document-renderers/execution-plan-renderer'),
  checklist: require('./lib/document-renderers/checklist-renderer'),
}

// Fire-and-forget candidature sync to GitHub (keeps data alive across Render deploys)
function syncCandidatures() {
  githubPersist.pushFile('candidatures.json')
    .then(r => { if (!r?.skipped) console.log('[GitHubSync] candidatures.json pushed') })
    .catch(e => console.error('[GitHubSync] candidatures push failed:', e.message))
}

function syncDocuments() {
  githubPersist.pushFile('rfq-generated.json')
    .then(r => { if (!r?.skipped) console.log('[GitHubSync] rfq-generated.json pushed') })
    .catch(e => console.error('[GitHubSync] rfq-generated push failed:', e.message))
}

function syncGeneratedDocs() {
  githubPersist.pushFile('generated-documents.json')
    .then(r => { if (!r?.skipped) console.log('[GitHubSync] generated-documents.json pushed') })
    .catch(e => console.error('[GitHubSync] generated-documents push failed:', e.message))
}

function readGenDocs() { return db.read('generated-documents.json') || [] }

// Returns documents as { bordereau: data, devis: data, ... } or null
function getProjectDocs(projectId) {
  const docs = readGenDocs().filter(d => d.projectId === projectId)
  if (!docs.length) return null
  const obj = {}
  docs.forEach(d => { if (d.data && Object.keys(d.data).length) obj[d.docType] = d.data })
  return Object.keys(obj).length ? obj : null
}

// Upsert a single document record; never overwrites with empty data
function upsertDoc(projectId, docType, data, source) {
  if (!data || typeof data !== 'object' || Object.keys(data).length === 0) return
  const docs = readGenDocs()
  const id   = `${projectId}_${docType}`
  const now  = new Date().toISOString()
  const titles = { bordereau: 'Bordereau de Prix', devis: 'Devis Estimatif', rfq: 'Demande de Prix Fournisseurs', plan: "Plan d'Exécution", checklist: 'Checklist de Conformité' }
  const idx  = docs.findIndex(d => d.id === id)
  const record = { id, projectId, docType, title: titles[docType] || docType, data, source: source || 'metadata_only', updatedAt: now }
  if (idx >= 0) docs[idx] = { ...docs[idx], ...record }
  else docs.push({ ...record, createdAt: now })
  db.write('generated-documents.json', docs)
  syncGeneratedDocs()
}

// On startup: hydrate persisted files from GitHub if local copies are empty
;(async () => {
  for (const [file, label] of [['candidatures.json', 'candidatures'], ['rfq-generated.json', 'documents'], ['generated-documents.json', 'generated-documents']]) {
    try {
      const local = db.read(file) || []
      if (local.length === 0) {
        const remote = await githubPersist.pullFile(file)
        if (Array.isArray(remote) && remote.length > 0) {
          db.write(file, remote)
          console.log(`[Startup] Hydrated ${remote.length} ${label} from GitHub`)
        }
      }
    } catch (e) { console.log(`[Startup] GitHub hydration skipped for ${file}:`, e.message) }
  }
})()

const app  = express()
const PORT = process.env.PORT || 3001

/* ── Middleware ─────────────────────────────────────────────────── */
app.use(cors())
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

/* ── Boot: start daily cron ────────────────────────────────────── */
scheduler.startCron()

/* ═══════════════════════════════════════════════════════════════
   STATS
══════════════════════════════════════════════════════════════════ */
app.get('/api/stats', (req, res) => {
  try {
    const allBons        = db.read('procurement-analysis.json') || []
    const analyses       = db.read('specifications.json')       || []
    const genDocs        = readGenDocs()
    const documents      = db.read('rfq-generated.json')        || []
    const candidatures   = db.read('candidatures.json')         || []
    const notifications  = db.read('notifications.json')        || []
    const cities       = new Set(allBons.map(b => b.location).filter(Boolean)).size
    const unreadNotifs = notifications.filter(n => !n.read).length

    const today     = new Date().toISOString().split('T')[0]
    const bonsToday = allBons.filter(b => (b.scrapedAt || '').startsWith(today)).length

    // Urgent = deadline within 5 days
    const nowMs = Date.now()
    const urgent = allBons.filter(b => {
      if (!b.deadline) return false
      const [d, m, y] = b.deadline.includes('/') ? b.deadline.split('/') : [null, null, null]
      const dl = y ? new Date(`${y}-${m}-${d}`) : new Date(b.deadline)
      const diff = (dl - nowMs) / 86400000
      return diff >= 0 && diff <= 5
    }).length

    const byActivity = {}
    allBons.forEach(b => { const a = b.categoryMatched || b.activityMatched || 'Autre'; byActivity[a] = (byActivity[a] || 0) + 1 })

    const cInProgress = candidatures.filter(c => !['Gagné','Perdu','Abandonné'].includes(c.status)).length
    const won         = candidatures.filter(c => c.status === 'Gagné').length
    const lost        = candidatures.filter(c => c.status === 'Perdu').length
    const successRate = (won + lost) > 0 ? Math.round((won / (won + lost)) * 100) : 0

    const totalEstimated = allBons.reduce((s, b) => {
      const v = parseFloat((b.estimatedAmount || b.estimatedBudget || '0').replace(/[^\d.]/g, ''))
      return s + (isNaN(v) ? 0 : v)
    }, 0)

    res.json({
      totalBons:          allBons.length,
      bonsToday,
      urgent,
      byActivity,
      analyzed:           analyses.length,
      documentsGenerated: new Set(genDocs.map(d => d.projectId)).size || documents.length,
      candidatures:       candidatures.length,
      candidaturesInProgress: cInProgress,
      offresSubmises:     candidatures.filter(c => ['Offre soumise','En attente résultat'].includes(c.status)).length,
      won, lost, successRate,
      totalEstimated,
      cities,
      unreadNotifs,
      lastScrape:         allBons[0]?.scrapedAt || null,
      scraperRunning:     scheduler.isRunning(),
    })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

/* ═══════════════════════════════════════════════════════════════
   PROJECTS (Bons de commande)
══════════════════════════════════════════════════════════════════ */
app.get('/api/projects', (req, res) => {
  try {
    const page     = parseInt(req.query.page)  || 1
    const limit    = parseInt(req.query.limit) || 1000
    const search   = (req.query.search   || '').toLowerCase()
    const location = (req.query.location || '').toLowerCase()
    const category = (req.query.category || '').toLowerCase()
    const status   = (req.query.status   || '').toLowerCase()

    let bons = db.read('procurement-analysis.json') || []

    if (search)   bons = bons.filter(b =>
      [b.title, b.buyer, b.location, b.reference, b.description].some(s => (s||'').toLowerCase().includes(search)))
    if (location) bons = bons.filter(b => (b.location||'').toLowerCase().includes(location))
    if (category) bons = bons.filter(b => (b.category||'').toLowerCase().includes(category))
    if (status)   bons = bons.filter(b => (b.resultStatus||'').toLowerCase().includes(status))

    // Sort newest first
    bons.sort((a, b) => new Date(b.scrapedAt) - new Date(a.scrapedAt))

    const total    = bons.length
    const start    = (page - 1) * limit
    const projects = bons.slice(start, start + limit)

    // Enrich with candidature status
    const cands = db.read('candidatures.json') || []
    const enriched = projects.map(p => ({
      ...p,
      candidatureStatus: cands.find(c => c.bonId === p.id)?.status || null,
    }))

    res.json({ projects: enriched, total, page, limit, pages: Math.ceil(total / limit) })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.get('/api/projects/:id', (req, res) => {
  const bons   = db.read('procurement-analysis.json') || []
  const bon    = bons.find(b => b.id === req.params.id)
  if (!bon) return res.status(404).json({ error: 'Bon introuvable' })

  // Documents and candidature — read from new per-doc store, fall back to legacy
  const cands      = db.read('candidatures.json')  || []
  let docs = getProjectDocs(bon.id)
  if (!docs) {
    const rfqs = db.read('rfq-generated.json') || []
    docs = rfqs.find(d => d.bonId === bon.id)?.documents || null
  }
  bon.documents    = docs
  bon.candidature  = cands.find(c => c.bonId === bon.id) || null

  // Legacy Skills-IA analysis (specifications.json)
  const analyses   = db.read('specifications.json') || []
  bon.analysis     = analyses.find(a => a.bonId === bon.id)?.analysis || null

  // CrewAI analysis from per-project cache file
  const aiPath = path.resolve(__dirname, 'data/ai-analysis', `${bon.id}.json`)
  if (fs.existsSync(aiPath)) {
    try { bon.crewaiAnalysis = JSON.parse(fs.readFileSync(aiPath, 'utf8')) }
    catch { bon.crewaiAnalysis = null }
  } else {
    bon.crewaiAnalysis = null
  }

  // Attachment spec (primaryAvisName, hasText, etc.)
  const specPath = path.resolve(__dirname, 'data/specifications', `${bon.id}.json`)
  if (fs.existsSync(specPath)) {
    try {
      const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'))
      bon.attachments     = spec.attachments      || bon.attachments      || []
      bon.attachmentHasText = spec.hasText        || bon.attachmentHasText|| false
      bon.avisDocument    = bon.avisDocument      || { selectedPdf: spec.primaryAvisName, textLength: spec.textLength }
    } catch {}
  }

  res.json(bon)
})

/* All data for a project in one call — avoids multiple round-trips */
app.get('/api/projects/:id/full', (req, res) => {
  const bons = db.read('procurement-analysis.json') || []
  const bon  = bons.find(b => b.id === req.params.id)
  if (!bon) return res.status(404).json({ error: 'Bon introuvable' })

  const cands = db.read('candidatures.json')  || []
  const specs = db.read('specifications.json') || []

  // Read from new per-doc store; fall back to legacy rfq-generated.json
  let documents = getProjectDocs(bon.id)
  if (!documents) {
    const rfqs = db.read('rfq-generated.json') || []
    documents  = rfqs.find(d => d.bonId === bon.id)?.documents || null
  }
  const candidature = cands.find(c => c.bonId === bon.id)                   || null
  const analysis    = specs.find(a => a.bonId === bon.id)?.analysis         || null

  let crewaiAnalysis = null
  const aiPath = path.resolve(__dirname, 'data/ai-analysis', `${bon.id}.json`)
  if (fs.existsSync(aiPath)) {
    try { crewaiAnalysis = JSON.parse(fs.readFileSync(aiPath, 'utf8')) } catch {}
  }

  let attachmentSpec = null
  const specPath = path.resolve(__dirname, 'data/specifications', `${bon.id}.json`)
  if (fs.existsSync(specPath)) {
    try { attachmentSpec = JSON.parse(fs.readFileSync(specPath, 'utf8')) } catch {}
  }

  res.json({
    ...bon,
    documents,
    candidature,
    analysis,
    crewaiAnalysis,
    attachmentSpec,
    attachments:      attachmentSpec?.attachments     || bon.attachments     || [],
    attachmentHasText: attachmentSpec?.hasText        || bon.attachmentHasText || false,
    avisDocument:     bon.avisDocument                || { selectedPdf: attachmentSpec?.primaryAvisName, textLength: attachmentSpec?.textLength },
  })
})

/* ═══════════════════════════════════════════════════════════════
   SCRAPE (manual trigger)
══════════════════════════════════════════════════════════════════ */
app.post('/api/scrape', async (req, res) => {
  const { maxItems = 50 } = req.body

  // Production: trigger GitHub Actions workflow (scraping + data commit)
  if (process.env.NODE_ENV === 'production') {
    const token = process.env.GITHUB_TOKEN
    const repo  = process.env.GITHUB_REPO || 'revolver2/procurement-auto'
    if (!token) return res.json({ success: false, error: 'GITHUB_TOKEN non configuré sur Render.' })
    try {
      const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/daily-scrape.yml/dispatches`, {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
        body:    JSON.stringify({ ref: 'main', inputs: { max_items: String(maxItems) } }),
      })
      if (!r.ok) throw new Error(`GitHub API ${r.status}: ${await r.text()}`)
      return res.json({ success: true, queued: true, message: `Scraping déclenché — résultats disponibles dans ~5 minutes.` })
    } catch (e) {
      return res.json({ success: false, error: e.message })
    }
  }

  // Local dev: run Playwright directly
  if (scheduler.isRunning()) return res.json({ success: false, error: 'Scraping déjà en cours.' })
  try {
    const result = await scheduler.runScrape(maxItems, 'manual')
    res.json(result)
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

app.get('/api/scrape/status', (req, res) => {
  res.json({
    running: scheduler.isRunning(),
    lastStatus: scheduler.getLastStatus(),
  })
})

/* ═══════════════════════════════════════════════════════════════
   SYNC HISTORY
══════════════════════════════════════════════════════════════════ */
app.get('/api/sync-history', (req, res) => {
  const history = db.read('sync-history.json') || []
  res.json(history.slice(0, 20))
})

/* ═══════════════════════════════════════════════════════════════
   AI ANALYSIS
══════════════════════════════════════════════════════════════════ */
app.get('/api/analyze', (req, res) => {
  const { projectId } = req.query
  if (!projectId) return res.status(400).json({ error: 'projectId requis' })
  const analyses = db.read('specifications.json') || []
  const found    = analyses.find(a => a.bonId === projectId)
  if (!found) return res.status(404).json({ error: 'Aucune analyse pour ce projet' })
  res.json({ analysis: found.analysis, analyzedAt: found.analyzedAt })
})

app.post('/api/analyze', async (req, res) => {
  const { projectId } = req.body
  if (!projectId) return res.status(400).json({ error: 'projectId requis' })
  const bons = db.read('procurement-analysis.json') || []
  const bon  = bons.find(b => b.id === projectId)
  if (!bon) return res.status(404).json({ error: 'Bon introuvable' })

  try {
    const analysis  = await aiAnalyzer.analyzeProcurement(bon)
    const analyses  = db.read('specifications.json') || []
    const idx       = analyses.findIndex(a => a.bonId === projectId)
    const record    = { bonId: projectId, analysis, analyzedAt: new Date().toISOString() }
    if (idx >= 0) analyses[idx] = record; else analyses.push(record)
    db.write('specifications.json', analyses)
    res.json({ success: true, analysis })
  } catch (e) { res.status(500).json({ success: false, error: e.message }) }
})

/* ═══════════════════════════════════════════════════════════════
   DOCUMENT GENERATION
══════════════════════════════════════════════════════════════════ */

// Per-project document retrieval (RESTful alias)
app.get('/api/projects/:id/documents', (req, res) => {
  const projectId = req.params.id
  let documents = getProjectDocs(projectId)
  let generatedAt = null
  if (documents) {
    const latest = readGenDocs().filter(d => d.projectId === projectId).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0]
    generatedAt  = latest?.updatedAt || null
  } else {
    const rfqs  = db.read('rfq-generated.json') || []
    const found = rfqs.find(d => d.bonId === projectId)
    documents   = found?.documents || null
    generatedAt = found?.generatedAt || null
  }
  res.json({ documents, generatedAt })
})

app.get('/api/generate', (req, res) => {
  const { projectId } = req.query
  if (!projectId) return res.status(400).json({ error: 'projectId requis' })
  let documents = getProjectDocs(projectId)
  if (!documents) {
    const all  = db.read('rfq-generated.json') || []
    documents  = all.find(d => d.bonId === projectId)?.documents || null
  }
  if (!documents) return res.status(404).json({ error: 'Aucun document pour ce projet' })
  res.json({ documents })
})

async function handleGenerateDocs(req, res) {
  const projectId    = req.params?.id || req.body?.projectId
  const documentType = req.body?.documentType || req.body?.docType || 'all'
  if (!projectId) return res.status(400).json({ error: 'projectId requis' })

  const bons     = db.read('procurement-analysis.json') || []
  const bon      = bons.find(b => b.id === projectId)
  if (!bon) return res.status(404).json({ error: 'Bon introuvable' })

  const analyses = db.read('specifications.json') || []
  const analysis = analyses.find(a => a.bonId === projectId)?.analysis || null

  try {
    let documents
    if (documentType === 'all') {
      documents = await documentGenerator.generateAll(bon, analysis)
    } else {
      // Merge new doc into existing docs so we don't lose others
      const existing = getProjectDocs(projectId) || {}
      const result   = await documentGenerator.generate(bon, analysis, documentType)
      documents      = { ...existing, [documentType]: result.data }
    }

    // Determine source from attachment spec
    const spec   = loadSpec(projectId)
    const source = spec?.hasText ? 'official_avis_attachment_only' : 'metadata_only'

    // Persist each doc to generated-documents.json (primary store)
    Object.entries(documents).forEach(([t, data]) => upsertDoc(projectId, t, data, source))

    // Keep rfq-generated.json in sync for legacy HTML renderer
    const all    = db.read('rfq-generated.json') || []
    const idx    = all.findIndex(d => d.bonId === projectId)
    const record = { bonId: projectId, documents, generatedAt: new Date().toISOString() }
    if (idx >= 0) all[idx] = record; else all.push(record)
    db.write('rfq-generated.json', all)
    syncDocuments()

    res.json({ success: true, documents })
  } catch (e) { res.status(500).json({ success: false, error: e.message }) }
}

app.post('/api/generate', handleGenerateDocs)
app.post('/api/projects/:id/documents', handleGenerateDocs)

/* ═══════════════════════════════════════════════════════════════
   CANDIDATURES
══════════════════════════════════════════════════════════════════ */
// Raw endpoint used by GitHub Actions backup — returns persisted array as-is
app.get('/api/candidatures/raw', (req, res) => {
  res.json(db.read('candidatures.json') || [])
})

app.get('/api/candidatures', (req, res) => {
  const cands = db.read('candidatures.json') || []
  // Enrich with bon title
  const bons  = db.read('procurement-analysis.json') || []
  const enriched = cands.map(c => ({
    ...c,
    bonTitle:    bons.find(b => b.id === c.bonId)?.title    || c.bonTitle || '—',
    bonBuyer:    bons.find(b => b.id === c.bonId)?.buyer    || c.bonBuyer || '—',
    bonDeadline: bons.find(b => b.id === c.bonId)?.deadline || c.bonDeadline || '—',
  }))
  res.json(enriched)
})

app.post('/api/candidatures', (req, res) => {
  const { bonId, notes } = req.body
  if (!bonId) return res.status(400).json({ error: 'bonId requis' })

  const bons    = db.read('procurement-analysis.json') || []
  const bon     = bons.find(b => b.id === bonId)
  if (!bon) return res.status(404).json({ error: 'Bon introuvable' })

  const cands   = db.read('candidatures.json') || []
  const exists  = cands.find(c => c.bonId === bonId)
  if (exists) return res.status(409).json({ error: 'Candidature déjà créée pour ce bon' })

  const cand = {
    id:          `CAND-${Date.now()}`,
    bonId,
    bonTitle:    bon.title,
    bonBuyer:    bon.buyer,
    bonDeadline: bon.deadline,
    bonReference: bon.reference,
    status:      'En préparation',
    notes:       notes || '',
    createdAt:   new Date().toISOString(),
    updatedAt:   new Date().toISOString(),
    history:     [{ status: 'En préparation', date: new Date().toISOString(), note: 'Candidature créée' }],
  }
  cands.push(cand)
  db.write('candidatures.json', cands)
  syncCandidatures()

  // Notification
  const notifs = db.read('notifications.json') || []
  notifs.unshift({
    id: Date.now(), read: false, createdAt: new Date().toISOString(),
    type: 'candidature', title: 'Nouvelle candidature',
    message: `Candidature créée pour: ${bon.title.substring(0, 80)}`,
  })
  db.write('notifications.json', notifs)

  res.json({ success: true, candidature: cand })
})

app.patch('/api/candidatures/:id', (req, res) => {
  const { status, notes } = req.body
  const cands  = db.read('candidatures.json') || []
  const idx    = cands.findIndex(c => c.id === req.params.id)
  if (idx < 0) return res.status(404).json({ error: 'Candidature introuvable' })

  const prev = cands[idx]
  cands[idx] = {
    ...prev,
    status:    status   || prev.status,
    notes:     notes    !== undefined ? notes : prev.notes,
    updatedAt: new Date().toISOString(),
    history:   [...(prev.history || []), {
      status: status || prev.status,
      date:   new Date().toISOString(),
      note:   notes || '',
    }],
  }
  db.write('candidatures.json', cands)
  syncCandidatures()
  res.json({ success: true, candidature: cands[idx] })
})

app.delete('/api/candidatures/:id', (req, res) => {
  const cands = db.read('candidatures.json') || []
  const idx   = cands.findIndex(c => c.id === req.params.id)
  if (idx < 0) return res.status(404).json({ error: 'Candidature introuvable' })
  cands.splice(idx, 1)
  db.write('candidatures.json', cands)
  syncCandidatures()
  res.json({ success: true })
})

/* ═══════════════════════════════════════════════════════════════
   NOTIFICATIONS
══════════════════════════════════════════════════════════════════ */
app.get('/api/notifications', (req, res) => {
  const notifs = db.read('notifications.json') || []
  res.json(notifs.slice(0, 50))
})

app.patch('/api/notifications/:id/read', (req, res) => {
  const notifs = db.read('notifications.json') || []
  const n      = notifs.find(n => String(n.id) === req.params.id)
  if (n) n.read = true
  db.write('notifications.json', notifs)
  res.json({ success: true })
})

app.post('/api/notifications/read-all', (req, res) => {
  const notifs = db.read('notifications.json') || []
  notifs.forEach(n => { n.read = true })
  db.write('notifications.json', notifs)
  res.json({ success: true })
})

/* ═══════════════════════════════════════════════════════════════
   COPILOTE IA — handled above in orchestrator section
══════════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════
   SETTINGS
══════════════════════════════════════════════════════════════════ */
app.get('/api/settings', (req, res) => {
  const saved = db.read('settings.json') || {}
  res.json({
    username:       process.env.MARCHESPUBLICS_USERNAME ? '***configured***' : '',
    password:       process.env.MARCHESPUBLICS_PASSWORD ? '***configured***' : '',
    geminiApiKey:   process.env.GEMINI_API_KEY ? '***configured***' : '',
    groqApiKey:     process.env.GROQ_API_KEY   ? '***configured***' : '',
    openaiApiKey:   process.env.OPENAI_API_KEY ? '***configured***' : '',
    scraperDelay:   process.env.SCRAPER_DELAY  || '2000',
    hasCredentials: !!(process.env.MARCHESPUBLICS_USERNAME && process.env.MARCHESPUBLICS_PASSWORD),
    hasGemini:      !!process.env.GEMINI_API_KEY,
    hasAI:          !!(process.env.GEMINI_API_KEY || process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY),
    aiProvider:     process.env.GEMINI_API_KEY ? 'gemini' : 'local-rulebased',
    // Schedule config
    dailyEnabled:  saved.dailyEnabled  !== false,
    dailyTime:     saved.dailyTime     || '06:00',
    maxItems:      saved.maxItems      || 50,
    // Keywords
    activities:         saved.activities         || getActivities(),
    exclusionKeywords:  saved.exclusionKeywords  || getExclusionKeywords(),
    cities:             saved.cities             || [],
    telegramBotToken:   process.env.TELEGRAM_BOT_TOKEN ? '***configured***' : '',
    telegramChatId:     process.env.TELEGRAM_CHAT_ID   ? '***configured***' : '',
    telegramEnabled:    saved.telegramEnabled !== false,
  })
})

app.post('/api/settings', (req, res) => {
  const { username, password, groqApiKey, openaiApiKey, scraperDelay,
          dailyEnabled, dailyTime, maxItems, keywords,
          activities, exclusionKeywords, cities, telegramEnabled,
          telegramBotToken, telegramChatId } = req.body
  try {
    const envPath = path.join(__dirname, '.env')
    let content   = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : ''

    const setEnv = (key, val) => {
      if (val === undefined || val === null) return
      process.env[key] = String(val)
      const re = new RegExp(`^${key}=.*$`, 'm')
      content  = re.test(content) ? content.replace(re, `${key}=${val}`) : content + `\n${key}=${val}`
    }

    const { geminiApiKey } = req.body
    setEnv('MARCHESPUBLICS_USERNAME', username)
    setEnv('MARCHESPUBLICS_PASSWORD', password)
    setEnv('GEMINI_API_KEY',          geminiApiKey)
    setEnv('GROQ_API_KEY',            groqApiKey)
    setEnv('OPENAI_API_KEY',          openaiApiKey)
    setEnv('SCRAPER_DELAY',           scraperDelay)
    setEnv('TELEGRAM_BOT_TOKEN',      telegramBotToken)
    setEnv('TELEGRAM_CHAT_ID',        telegramChatId)

    fs.writeFileSync(envPath, content.trim() + '\n', 'utf-8')

    // Save schedule + keyword config to settings.json
    const saved = db.read('settings.json') || {}
    if (dailyEnabled       !== undefined) saved.dailyEnabled       = dailyEnabled
    if (dailyTime          !== undefined) saved.dailyTime          = dailyTime
    if (maxItems           !== undefined) saved.maxItems           = parseInt(maxItems)
    if (keywords           !== undefined) saved.keywords           = keywords
    if (activities         !== undefined) saved.activities         = activities
    if (exclusionKeywords  !== undefined) saved.exclusionKeywords  = exclusionKeywords
    if (cities             !== undefined) saved.cities             = cities
    if (telegramEnabled    !== undefined) saved.telegramEnabled    = telegramEnabled

    db.write('settings.json', saved)

    // Restart cron with new schedule
    scheduler.restartCron()

    res.json({ status: 'ok', message: 'Paramètres sauvegardés.' })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

/* ═══════════════════════════════════════════════════════════════
   ANALYTICS
══════════════════════════════════════════════════════════════════ */
app.get('/api/analytics', (req, res) => {
  try {
    const bons  = db.read('procurement-analysis.json') || []
    const cands = db.read('candidatures.json')         || []

    // By city
    const byCity = {}
    bons.forEach(b => { const c = b.location || 'Inconnu'; byCity[c] = (byCity[c] || 0) + 1 })

    // By category
    const byCategory = {}
    bons.forEach(b => { const c = b.category || 'Autre'; byCategory[c] = (byCategory[c] || 0) + 1 })

    // By keyword match
    const byKeyword = {}
    bons.forEach(b => (b.keywords || []).forEach(kw => { byKeyword[kw] = (byKeyword[kw] || 0) + 1 }))

    // Monthly
    const byMonth = {}
    bons.forEach(b => {
      const m = (b.scrapedAt || b.publicationDate || '').substring(0, 7)
      if (m) byMonth[m] = (byMonth[m] || 0) + 1
    })

    // Candidature stats
    const candsByStatus = {}
    cands.forEach(c => { candsByStatus[c.status] = (candsByStatus[c.status] || 0) + 1 })

    // Budget estimates
    const withBudget = bons.filter(b => b.estimatedBudget && parseFloat(b.estimatedBudget.replace(/[^\d.]/g, '')) > 0)
    const totalBudget = withBudget.reduce((s, b) => s + parseFloat(b.estimatedBudget.replace(/[^\d.]/g, '') || '0'), 0)

    res.json({
      totalBons:    bons.length,
      totalCands:   cands.length,
      byCity:       Object.entries(byCity).sort((a,b) => b[1]-a[1]).slice(0, 10),
      byCategory:   Object.entries(byCategory).sort((a,b) => b[1]-a[1]).slice(0, 10),
      byKeyword:    Object.entries(byKeyword).sort((a,b) => b[1]-a[1]).slice(0, 15),
      byMonth:      Object.entries(byMonth).sort(),
      candsByStatus: Object.entries(candsByStatus),
      totalBudgetEstimate: totalBudget,
    })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

/* ═══════════════════════════════════════════════════════════════
   AI ORCHESTRATOR
══════════════════════════════════════════════════════════════════ */

// Run full AI pipeline for a bon
app.post('/api/orchestrate/:id', async (req, res) => {
  const { generateDocuments = false, forceRefresh = false } = req.body || {}
  try {
    const result = await orchestrator.orchestrate(req.params.id, { generateDocuments, forceRefresh })
    res.json(result)
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// Get cached orchestration result
app.get('/api/orchestrate/:id', (req, res) => {
  const result = orchestrator.getOrchestration(req.params.id)
  if (!result) return res.status(404).json({ error: 'Pas d\'analyse orchestrée pour ce bon' })
  res.json(result)
})

// Company memory
app.get('/api/company-memory', (req, res) => {
  res.json(orchestrator.getMemory())
})

app.put('/api/company-memory', (req, res) => {
  try {
    const current = orchestrator.getMemory()
    const updated = deepMerge(current, req.body)
    updated.lastUpdated = new Date().toISOString()
    db.write('company-memory.json', updated)
    res.json({ success: true, memory: updated })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

/* ═══════════════════════════════════════════════════════════════
   ATTACHMENT PIPELINE
══════════════════════════════════════════════════════════════════ */
const { processFromUrls, reExtractFromCache, loadSpec, saveSpec, ATTACHMENTS_DIR } = require('./lib/attachments/attachment-analyzer')
const { extractText: extractPdfText } = require('./lib/attachments/pdf-text-extractor')

// Get specification (extracted attachment text)
app.get('/api/specifications/:id', (req, res) => {
  const spec = loadSpec(req.params.id)
  if (!spec) return res.status(404).json({ error: 'Aucune spécification extraite pour ce bon' })
  res.json(spec)
})

// Re-run attachment pipeline on existing BC (re-download + re-extract)
app.post('/api/attachments/:id/process', async (req, res) => {
  try {
    const { forceRefresh = true } = req.body || {}
    const bons = db.read('procurement-analysis.json') || []
    const bon  = bons.find(b => b.id === req.params.id)
    if (!bon) return res.status(404).json({ success: false, error: 'BC introuvable' })

    const rawDocs = bon.attachments?.length
      ? bon.attachments.map(a => ({ url: a.url, name: a.name }))
      : (bon.documents || [])

    if (!rawDocs.length) return res.json({ success: false, error: 'Aucun lien de pièce jointe connu pour ce BC' })

    const spec = await processFromUrls(bon, rawDocs, null, forceRefresh)

    // Update bon in DB
    const idx = bons.findIndex(b => b.id === req.params.id)
    if (idx >= 0) {
      bons[idx].attachmentHasText          = spec.hasText
      bons[idx].attachmentFound            = !spec.noAttachmentFound
      bons[idx].officialAttachmentTextPath = spec.hasText ? `data/specifications/${bon.id}.json` : null
      bons[idx].analysisSource             = spec.analysisSource
      bons[idx].attachments                = spec.attachments
      db.write('procurement-analysis.json', bons)
    }

    res.json({ success: true, spec })
  } catch (e) { res.status(500).json({ success: false, error: e.message }) }
})

// AI Chat (upgraded — uses orchestrator context)
app.post('/api/chat', async (req, res) => {
  const { message, messages = [], projectId } = req.body
  const userMessage = message || messages[messages.length - 1]?.content
  if (!userMessage) return res.status(400).json({ error: 'message requis' })

  try {
    const history = messages.slice(0, -1).map(m => ({ role: m.role, content: m.content }))
    const { reply } = await orchestrator.chat(userMessage, projectId, history)
    res.json({ reply, response: reply })
  } catch (e) { res.json({ reply: `Erreur IA: ${e.message}` }) }
})

/* ═══════════════════════════════════════════════════════════════
   PROJECT STATUS (Tender Project Manager)
══════════════════════════════════════════════════════════════════ */
const PROJECT_STATUSES = [
  'Nouveau', 'À analyser', 'Analyse IA terminée',
  'Demande de prix fournisseurs', 'Bordereau préparé', 'Devis préparé',
  'Offre soumise', 'En attente résultat', 'Gagné', 'Perdu', 'Abandonné',
]

app.patch('/api/projects/:id/status', (req, res) => {
  const { status, note } = req.body
  if (!status) return res.status(400).json({ error: 'status requis' })
  if (!PROJECT_STATUSES.includes(status)) return res.status(400).json({ error: 'statut invalide', valid: PROJECT_STATUSES })

  const bons = db.read('procurement-analysis.json') || []
  const idx  = bons.findIndex(b => b.id === req.params.id)
  if (idx < 0) return res.status(404).json({ error: 'Bon introuvable' })

  bons[idx] = {
    ...bons[idx],
    projectStatus: status,
    updatedAt:     new Date().toISOString(),
    statusHistory: [...(bons[idx].statusHistory || []), { status, note: note || '', date: new Date().toISOString() }],
  }
  try {
    db.write('procurement-analysis.json', bons)
    res.json({ success: true, bon: bons[idx] })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/project-statuses', (_req, res) => res.json(PROJECT_STATUSES))

/* ═══════════════════════════════════════════════════════════════
   KEYWORD TEST
══════════════════════════════════════════════════════════════════ */
app.post('/api/settings/keywords/test', (req, res) => {
  const { text } = req.body
  if (!text) return res.status(400).json({ error: 'text requis' })

  const activities      = getActivities()
  const exclusionKws    = getExclusionKeywords()
  const norm            = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  const h               = norm(text)

  const matched   = []
  const excluded  = []
  for (const a of activities) {
    for (const kw of (a.keywords || [])) {
      if (h.includes(norm(kw))) matched.push({ keyword: kw, activity: a.name, activityId: a.id })
    }
  }
  for (const kw of exclusionKws) {
    if (h.includes(norm(kw))) excluded.push(kw)
  }

  res.json({ matched, excluded, wouldKeep: matched.length > 0 && excluded.length === 0 })
})

/* ═══════════════════════════════════════════════════════════════
   PROJECT ATTACHMENT SHORTCUTS
══════════════════════════════════════════════════════════════════ */
app.post('/api/projects/:id/extract-avis', async (req, res) => {
  try {
    const { forceDownload = false } = req.body || {}
    const bons = db.read('procurement-analysis.json') || []
    const bon  = bons.find(b => b.id === req.params.id)
    if (!bon) return res.status(404).json({ success: false, error: 'BC introuvable' })

    let spec
    if (forceDownload) {
      // Re-download from URLs (requires auth for some portals — may fail)
      const rawDocs = bon.attachments?.length
        ? bon.attachments.map(a => ({ url: a.url, name: a.name }))
        : (bon.documents || [])
      if (!rawDocs.length) return res.json({ success: false, error: 'Aucun lien de pièce jointe connu', hint: 'Lancez un scrape complet pour capturer les pièces jointes.' })
      spec = await processFromUrls(bon, rawDocs, null, { forceRefresh: true, forceDownload: true })
    } else {
      // Re-extract from already-downloaded files (no HTTP needed, works offline)
      spec = await reExtractFromCache(bon)
      // If no cached files found, fall back to downloading
      if (spec.noAttachmentFound && !spec.hasText) {
        const rawDocs = bon.attachments?.length
          ? bon.attachments.map(a => ({ url: a.url, name: a.name }))
          : (bon.documents || [])
        if (rawDocs.length) {
          spec = await processFromUrls(bon, rawDocs, null, { forceRefresh: true, forceDownload: false })
        }
      }
    }

    const idx = bons.findIndex(b => b.id === req.params.id)
    if (idx >= 0) {
      bons[idx].attachmentHasText = spec.hasText
      bons[idx].attachmentFound   = !spec.noAttachmentFound
      if (spec.attachments?.length) bons[idx].attachments = spec.attachments
      db.write('procurement-analysis.json', bons)
    }

    // Include files-on-disk listing in response for UI debug
    const safeId2 = req.params.id.replace(/[^a-zA-Z0-9\-]/g, '_')
    const dir = path.join(ATTACHMENTS_DIR, safeId2)
    let filesOnDisk = []
    if (fs.existsSync(dir)) {
      try { filesOnDisk = fs.readdirSync(dir).map(f => ({ name: f, size: fs.statSync(path.join(dir,f)).size })) } catch {}
    }

    res.json({ success: true, spec, filesOnDisk, dirExists: fs.existsSync(dir) })
  } catch (e) { res.status(500).json({ success: false, error: e.message }) }
})

/* ── Validate any readable PDF and unlock CrewAI ───────────────── */
app.post('/api/projects/:id/validate-avis-pdf', async (req, res) => {
  const bonId  = req.params.id
  const safeId = bonId.replace(/[^a-zA-Z0-9\-]/g, '_')
  const dir    = path.join(ATTACHMENTS_DIR, safeId)

  const bons = db.read('procurement-analysis.json') || []
  const bon  = bons.find(b => b.id === bonId)
  if (!bon) return res.status(404).json({ success: false, error: 'BC introuvable' })

  if (!fs.existsSync(dir)) {
    return res.json({ success: false, error: 'Aucun fichier téléchargé — utilisez Force téléchargement', crewaiUnlocked: false, pdfsFound: 0 })
  }

  /* recursive scan: returns every file > 1 KB, skipping macOS resource forks */
  function scanAllFiles(d, depth = 0) {
    const out = []
    if (depth > 4) return out
    try {
      for (const f of fs.readdirSync(d)) {
        if (f === '__MACOSX' || f.startsWith('._')) continue  // skip macOS metadata
        const fp = path.join(d, f)
        try {
          const st = fs.statSync(fp)
          if (st.isDirectory()) out.push(...scanAllFiles(fp, depth + 1))
          else out.push({ path: fp, name: f, size: st.size, ext: path.extname(f).toLowerCase() })
        } catch {}
      }
    } catch {}
    return out
  }

  const allFiles = scanAllFiles(dir)

  /* score: lower = higher priority */
  function score(name) {
    const n = name.toLowerCase()
    if (/avis/i.test(n)         && n.endsWith('.pdf'))  return 0
    if (/consultation/i.test(n) && n.endsWith('.pdf'))  return 1
    if (/bon.*commande/i.test(n)&& n.endsWith('.pdf'))  return 2
    if (n.endsWith('.pdf'))                              return 3
    if (n.endsWith('.docx') || n.endsWith('.doc'))      return 4
    if (n.endsWith('.txt'))                              return 5
    return 99
  }

  /* select candidates: PDFs + DOCX + TXT with size > 1 KB */
  const candidates = allFiles
    .filter(f => ['.pdf','.docx','.doc','.txt'].includes(f.ext) && f.size > 1024)
    .sort((a, b) => {
      const sa = score(a.name), sb = score(b.name)
      if (sa !== sb) return sa - sb
      return b.size - a.size
    })

  /* also try top-level ZIPs (extractText handles recursion internally) */
  const zips = allFiles.filter(f => f.ext === '.zip' && f.size > 1024)

  if (!candidates.length && !zips.length) {
    return res.json({ success: false, error: 'Aucun fichier valide trouvé dans le cache', crewaiUnlocked: false, pdfsFound: 0, filesFound: allFiles.length })
  }

  let bestText = '', bestName = null, bestSourceZip = null, bestOcrUsed = false
  let bestExtractionMethod = null, requiresOCR = false

  /* try scored candidates first */
  for (const cand of candidates) {
    let result
    try { result = await extractPdfText(cand.path) } catch { continue }
    if (result.requiresOCR) requiresOCR = true
    if (result.textExtracted && result.text && result.text.length >= 50) {
      if (!bestText || result.text.length > bestText.length) {
        bestText             = result.text
        bestName             = result.sourceFile || cand.name
        bestSourceZip        = result.sourceZip  || null
        bestOcrUsed          = result.ocrUsed    || false
        bestExtractionMethod = result.ocrUsed ? 'gemini-ocr' : 'pdf-parse'
      }
      if (score(cand.name) <= 2) break  // AVIS/consultation found — stop
    }
  }

  /* fallback: try ZIPs if no text yet */
  if (!bestText) {
    for (const z of zips) {
      let result
      try { result = await extractPdfText(z.path) } catch { continue }
      if (result.requiresOCR) requiresOCR = true
      if (result.textExtracted && result.text && result.text.length >= 50) {
        bestText             = result.text
        bestName             = result.sourceFile || z.name
        bestSourceZip        = result.sourceZip  || z.name
        bestOcrUsed          = result.ocrUsed    || false
        bestExtractionMethod = result.ocrUsed ? 'gemini-ocr' : 'pdf-parse'
        break
      }
    }
  }

  if (!bestText) {
    const ocrAvail = !!process.env.GEMINI_API_KEY
    return res.json({
      success: false,
      error:   requiresOCR
        ? ocrAvail
          ? 'PDF scanné — Gemini OCR tenté mais échoué'
          : 'PDF scanné — ajoutez GEMINI_API_KEY dans Render pour activer l\'OCR'
        : 'Aucun texte extractible dans les fichiers téléchargés',
      requiresOCR,
      ocrAvailable: ocrAvail,
      crewaiUnlocked: false,
      pdfsFound: candidates.filter(c=>c.ext==='.pdf').length,
      filesFound: allFiles.length,
    })
  }

  /* ── Success: save spec + update bon ── */
  const spec = {
    bonId,
    bonReference:    bon.reference || '',
    attachments:     candidates.map(c => ({
      name:          c.name,
      type:          /avis/i.test(c.name) ? 'avis' : 'other',
      downloaded:    true,
      textExtracted: bestName === c.name || bestSourceZip === c.name,
      textLength:    (bestName === c.name || bestSourceZip === c.name) ? bestText.length : 0,
      sourceFile:    bestSourceZip === c.name ? bestName : null,
      sourceZip:     bestSourceZip === c.name ? bestSourceZip : null,
      ocrUsed:       (bestName === c.name || bestSourceZip === c.name) ? bestOcrUsed : false,
      localPath:     c.path,
    })),
    primaryAvisText:   bestText,
    primaryAvisName:   bestName,
    primarySourceZip:  bestSourceZip,
    hasText:           true,
    textLength:        bestText.length,
    extractionMethod:  bestExtractionMethod,
    noAttachmentFound: false,
    analysisSource:    'official_attachment_only',
    extractedAt:       new Date().toISOString(),
  }
  saveSpec(bonId, spec)

  const idx = bons.findIndex(b => b.id === bonId)
  if (idx >= 0) {
    bons[idx].attachmentHasText = true
    bons[idx].attachmentFound   = true
    bons[idx].avisDocument = {
      selectedPdf:      bestName,
      sourceZip:        bestSourceZip,
      textLength:       bestText.length,
      textExtracted:    true,
      extractionMethod: bestExtractionMethod,
      ocrUsed:          bestOcrUsed,
      validated:        true,
      validatedAt:      new Date().toISOString(),
    }
    db.write('procurement-analysis.json', bons)
  }

  res.json({
    success:           true,
    selectedPdf:       bestName,
    sourceZip:         bestSourceZip,
    textLength:        bestText.length,
    extractionMethod:  bestExtractionMethod,
    ocrUsed:           bestOcrUsed,
    attachmentHasText: true,
    crewaiUnlocked:    true,
    pdfsFound:         candidates.filter(c=>c.ext==='.pdf').length,
  })
})

/* ── AI/OCR diagnostic endpoint ─────────────────────────────── */
app.get('/api/diagnostics/ai', (req, res) => {
  const geminiKey    = !!process.env.GEMINI_API_KEY
  const crewaiUrl    = !!(process.env.CREWAI_SERVICE_URL || process.env.CREWAI_URL)
  res.json({
    geminiKeyConfigured:  geminiKey,
    crewaiUrlConfigured:  crewaiUrl,
    ocrAvailable:         geminiKey,
    ocrProvider:          geminiKey ? 'gemini-2.5-flash' : null,
  })
})

/* ── Upload AVIS PDF directly (drag-and-drop from browser) ── */
app.post('/api/projects/:id/upload-avis',
  express.raw({ type: '*/*', limit: '50mb' }),
  async (req, res) => {
    const bonId    = req.params.id
    const safeId   = bonId.replace(/[^a-zA-Z0-9\-]/g, '_')
    const rawName  = (req.query.filename || req.headers['x-filename'] || 'upload.pdf')
      .replace(/[^a-zA-Z0-9._\- ]/g, '_').trim() || 'upload.pdf'

    const bons = db.read('procurement-analysis.json') || []
    const bon  = bons.find(b => b.id === bonId)
    if (!bon) return res.status(404).json({ success: false, error: 'BC introuvable' })

    if (!req.body || !req.body.length) {
      return res.status(400).json({ success: false, error: 'Corps de requête vide' })
    }

    // Validate PDF magic bytes
    const magic = req.body.slice(0, 5).toString('ascii')
    if (!magic.startsWith('%PDF-')) {
      return res.status(400).json({ success: false, error: 'Le fichier ne semble pas être un PDF valide' })
    }

    const dir      = path.join(ATTACHMENTS_DIR, safeId)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

    const savePath = path.join(dir, rawName)
    fs.writeFileSync(savePath, req.body)

    let result
    try { result = await extractPdfText(savePath) }
    catch (e) { result = { textExtracted: false, error: e.message, requiresOCR: false } }

    if (!result.textExtracted || !result.text || result.text.length < 50) {
      return res.json({
        success: false,
        savedAs: rawName,
        requiresOCR: result.requiresOCR || false,
        error: result.error || 'Aucun texte extractible — essayez un PDF avec une couche texte',
        crewaiUnlocked: false,
      })
    }

    const bestText = result.text
    const bestName = rawName + (result.sourceFile ? ` / ${result.sourceFile}` : '')
    const ocrUsed  = result.ocrUsed || false

    const spec = {
      bonId,
      bonReference:    bon.reference || '',
      attachments: [{
        name:          rawName,
        type:          /avis/i.test(rawName) ? 'avis' : 'uploaded',
        downloaded:    true,
        textExtracted: true,
        textLength:    bestText.length,
        localPath:     savePath,
        ocrUsed,
      }],
      primaryAvisText:   bestText,
      primaryAvisName:   bestName,
      hasText:           true,
      textLength:        bestText.length,
      noAttachmentFound: false,
      analysisSource:    'uploaded_pdf',
      extractedAt:       new Date().toISOString(),
    }
    saveSpec(bonId, spec)

    const idx = bons.findIndex(b => b.id === bonId)
    if (idx >= 0) {
      bons[idx].attachmentHasText = true
      bons[idx].attachmentFound   = true
      bons[idx].avisDocument = {
        selectedPdf:   bestName,
        textLength:    bestText.length,
        textExtracted: true,
        validated:     true,
        uploadedAt:    new Date().toISOString(),
        ocrUsed,
      }
      db.write('procurement-analysis.json', bons)
    }

    res.json({
      success:          true,
      savedAs:          rawName,
      selectedPdf:      bestName,
      textLength:       bestText.length,
      ocrUsed,
      attachmentHasText: true,
      crewaiUnlocked:   true,
    })
  }
)

app.post('/api/projects/:id/analyze-from-avis', async (req, res) => {
  const bonId = req.params.id
  const { forceRefresh = false } = req.body || {}

  // Load bon
  const bons = db.read('procurement-analysis.json') || []
  const bon  = bons.find(b => b.id === bonId)
  if (!bon) return res.status(404).json({ success: false, error: 'BC introuvable' })

  // Load AVIS text — loadSpec is in scope from module-level require (line ~574)
  const spec     = loadSpec(bonId)
  const avisText = spec?.primaryAvisText || null

  // Block if no AVIS text extracted
  if (!avisText || avisText.trim().length < 50) {
    return res.status(400).json({
      success: false,
      error:   'Analyse bloquée: AVIS officiel non extrait. Allez dans "Pièces Jointes" et cliquez "Re-télécharger".',
      blocked: true,
    })
  }

  const crewaiUrl = process.env.CREWAI_SERVICE_URL

  // No CrewAI service configured → fall back to Gemini orchestrator silently
  if (!crewaiUrl) {
    try {
      const result = await orchestrator.orchestrate(bonId, { generateDocuments: false, forceRefresh: true })
      return res.json(result)
    } catch (e) { return res.status(500).json({ success: false, error: e.message }) }
  }

  // Check Node-side AI cache (avoids calling AI twice for same AVIS)
  const crypto       = require('crypto')
  const sourceHash   = crypto.createHash('sha256').update(`${bonId}:${avisText.substring(0, 2000)}`).digest('hex').substring(0, 16)
  const AI_CACHE_DIR = path.resolve(__dirname, 'data/ai-analysis')
  const cachePath    = path.join(AI_CACHE_DIR, `${bonId}.json`)

  if (!forceRefresh && fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
      if (cached.sourceHash === sourceHash) {
        return res.json({ success: true, cached: true, ...cached })
      }
    } catch {}
  }

  // Build request payload for Python service
  const payload = {
    projectId:    bonId,
    projectTitle: bon.title    || '',
    buyer:        bon.buyer    || '',
    city:         bon.location || bon.city || '',
    deadline:     bon.deadline || '',
    officialUrl:  bon.sourceUrl || '',
    avisText,
  }

  let analysis = null

  // Call CrewAI microservice
  try {
    const crewRes = await fetch(`${crewaiUrl}/analyze-tender`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
      signal:  AbortSignal.timeout(150000),
    })
    if (!crewRes.ok) {
      const errBody = await crewRes.text()
      let detail = errBody
      try { detail = JSON.parse(errBody)?.detail || errBody } catch {}
      // 400 from Python = AVIS blocked — propagate directly
      if (crewRes.status === 400) return res.status(400).json({ success: false, error: detail, blocked: true })
      throw new Error(`CrewAI HTTP ${crewRes.status}: ${String(detail).substring(0, 200)}`)
    }
    analysis = await crewRes.json()
  } catch (e) {
    // Network error (service down) → fall back to Gemini orchestrator, no crash
    console.warn(`[CrewAI] Service unreachable (${e.message}), falling back to orchestrator`)
    try {
      const result = await orchestrator.orchestrate(bonId, { generateDocuments: false, forceRefresh: true })
      return res.json({ ...result, crewAiFallback: true, crewAiError: e.message })
    } catch (e2) {
      return res.status(500).json({ success: false, error: `CrewAI unreachable + orchestrator failed: ${e2.message}` })
    }
  }

  // Enrich sourceTraceability with attachment name known only by Node (Python doesn't have it)
  if (analysis.sourceTraceability) {
    analysis.sourceTraceability.attachmentAnalyzed = spec?.primaryAvisName || 'AVIS officiel'
  }

  // Persist to ai-analysis cache
  if (!fs.existsSync(AI_CACHE_DIR)) fs.mkdirSync(AI_CACHE_DIR, { recursive: true })
  fs.writeFileSync(cachePath, JSON.stringify({ ...analysis, cachedAt: new Date().toISOString() }, null, 2))

  // Update bon metadata in DB
  const bonIdx = bons.findIndex(b => b.id === bonId)
  if (bonIdx >= 0) {
    bons[bonIdx] = {
      ...bons[bonIdx],
      analysisSource: 'official_avis_attachment_only',
      aiEngine:       'crewai',
      analyzedAt:     new Date().toISOString(),
    }
    db.write('procurement-analysis.json', bons)
  }

  // Telegram notification (fire-and-forget — never blocks the response)
  const settings = db.read('settings.json') || {}
  if (settings.telegramEnabled !== false) {
    const tgMsg = telegram.formatCrewAiSummary(bon, analysis)
    telegram.sendMessage(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID, tgMsg)
      .catch(e => console.warn('[Telegram] CrewAI notify failed:', e.message))
  }

  return res.json({ success: true, ...analysis })
})

app.get('/api/projects/:id/crewai-analysis', (req, res) => {
  const p = path.resolve(__dirname, 'data/ai-analysis', `${req.params.id}.json`)
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'Aucune analyse CrewAI pour ce bon' })
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'))
    res.json({ success: true, ...data })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

/* ── Rendered document HTML ────────────────────────────────────── */
app.get('/api/documents/:bonId/:type/html', (req, res) => {
  const { bonId, type } = req.params
  const renderer = docRenderers[type]
  if (!renderer) return res.status(400).send(`<h3>Type non supporté: ${type}</h3>`)

  const bons = db.read('procurement-analysis.json') || []
  const bon  = bons.find(b => b.id === bonId)
  if (!bon) return res.status(404).send('<h3>Bon introuvable</h3>')

  // Read from new per-doc store; fall back to legacy rfq-generated.json
  const projectDocs = getProjectDocs(bonId)
  let docData = projectDocs?.[type] || null
  if (!docData) {
    const rfqs = db.read('rfq-generated.json') || []
    docData    = rfqs.find(d => d.bonId === bonId)?.documents?.[type] || null
  }
  if (!docData) return res.status(404).send(`<h3>Document "${type}" non encore généré pour ce BC.</h3>`)

  try {
    const spec = loadSpec(bonId)
    const html = renderer.render(bon, docData, { attachmentAnalyzed: spec?.primaryAvisName })
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.send(html)
  } catch (e) { res.status(500).send(`<h3>Erreur rendu: ${e.message}</h3>`) }
})

/* ── AVIS extracted text ───────────────────────────────────────── */
app.get('/api/projects/:id/avis-text', (req, res) => {
  const spec = loadSpec(req.params.id)
  if (!spec) return res.status(404).json({ hasText: false, error: 'Aucune spec pour ce bon' })
  res.json({
    hasText:         spec.hasText     || false,
    textLength:      spec.textLength  || 0,
    primaryAvisName: spec.primaryAvisName || null,
    text:            spec.primaryAvisText || '',
    attachments:     spec.attachments     || [],
    extractedAt:     spec.extractedAt     || null,
    noAttachmentFound: spec.noAttachmentFound || false,
  })
})

app.get('/api/projects/:id/attachments', (req, res) => {
  const spec = loadSpec(req.params.id)
  if (!spec) return res.status(404).json({ error: 'Aucune spec pour ce bon' })
  res.json(spec)
})

/* ── Files actually on disk for this project ───────────────────── */
app.get('/api/projects/:id/files-on-disk', (req, res) => {
  const safeId = req.params.id.replace(/[^a-zA-Z0-9\-]/g, '_')
  const dir    = path.join(ATTACHMENTS_DIR, safeId)

  if (!fs.existsSync(dir)) return res.json({ dirExists: false, files: [], dir })

  function scanDir(d, depth = 0) {
    const items = []
    if (depth > 3) return items
    try {
      for (const f of fs.readdirSync(d)) {
        if (f === '__MACOSX' || f.startsWith('._')) continue
        const fp = path.join(d, f)
        try {
          const st = fs.statSync(fp)
          if (st.isDirectory()) {
            items.push(...scanDir(fp, depth + 1))
          } else {
            items.push({ name: path.relative(dir, fp).replace(/\\/g, '/'), size: st.size, ext: path.extname(f).toLowerCase() })
          }
        } catch {}
      }
    } catch {}
    return items
  }

  const files = scanDir(dir)
  res.json({ dirExists: true, files, dir })
})

/* ── Save / update document edits ─────────────────────────────── */
app.patch('/api/documents/:bonId/:type', (req, res) => {
  const { bonId, type } = req.params
  if (!['bordereau','devis','rfq','plan','checklist'].includes(type))
    return res.status(400).json({ error: 'Type invalide' })

  const data = req.body
  if (!data || typeof data !== 'object' || Object.keys(data).length === 0)
    return res.status(400).json({ error: 'Données vides — aucune modification sauvegardée' })

  // Primary store: per-doc record
  upsertDoc(bonId, type, data, 'edited')

  // Keep rfq-generated.json in sync for HTML renderer
  const rfqs = db.read('rfq-generated.json') || []
  const idx  = rfqs.findIndex(d => d.bonId === bonId)
  if (idx >= 0) {
    rfqs[idx].documents       = rfqs[idx].documents || {}
    rfqs[idx].documents[type] = data
    rfqs[idx].updatedAt       = new Date().toISOString()
  } else {
    rfqs.push({ bonId, documents: { [type]: data }, generatedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
  }
  db.write('rfq-generated.json', rfqs)
  syncDocuments()

  res.json({ success: true })
})

/* ═══════════════════════════════════════════════════════════════
   AI PROVIDER TEST
══════════════════════════════════════════════════════════════════ */
app.post('/api/ai/test', async (req, res) => {
  try {
    const { complete } = require('./lib/ai-providers/gemini')
    const text = await complete({
      messages: [{ role: 'user', content: 'Réponds uniquement: {"ok":true,"provider":"gemini"}' }],
      temperature: 0,
      maxTokens: 50,
    })
    const cleaned = text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim()
    try {
      const parsed = JSON.parse(cleaned)
      res.json({ success: true, provider: 'gemini', response: parsed })
    } catch {
      res.json({ success: true, provider: 'gemini', response: cleaned })
    }
  } catch (e) {
    res.json({ success: false, provider: process.env.GEMINI_API_KEY ? 'gemini' : 'local-rulebased', error: e.message })
  }
})

/* ═══════════════════════════════════════════════════════════════
   SPA fallback
══════════════════════════════════════════════════════════════════ */
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'))
})

/* ─────────────────────────────────────────────────────────────── */
function deepMerge(target, source) {
  const out = { ...target }
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      out[key] = deepMerge(target[key] || {}, source[key])
    } else {
      out[key] = source[key]
    }
  }
  return out
}

app.listen(PORT, () => {
  console.log(`\n🚀 Procurement Intelligence Server`)
  console.log(`   http://localhost:${PORT}`)
  console.log(`   Credentials: ${process.env.MARCHESPUBLICS_USERNAME ? '✅' : '❌ non configurés'}`)
  console.log(`   AI engine:   ${process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY ? '✅' : '⚠️  non configuré'}`)
  console.log(`   Daily cron:  ✅ actif`)
  console.log()
})
