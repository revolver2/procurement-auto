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
const { DEFAULT_KEYWORDS } = require('./lib/scraper')

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
    const documents      = db.read('rfq-generated.json')        || []
    const candidatures   = db.read('candidatures.json')         || []
    const notifications  = db.read('notifications.json')        || []
    const cities         = new Set(allBons.map(b => b.location).filter(Boolean)).size
    const unreadNotifs   = notifications.filter(n => !n.read).length

    res.json({
      totalBons:          allBons.length,
      analyzed:           analyses.length,
      documentsGenerated: documents.length,
      candidatures:       candidatures.length,
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

  // Attach analysis + documents + candidature if available
  const analyses   = db.read('specifications.json')   || []
  const rfqs       = db.read('rfq-generated.json')    || []
  const cands      = db.read('candidatures.json')     || []
  bon.analysis     = analyses.find(a => a.bonId === bon.id)?.analysis     || null
  bon.documents    = rfqs.find(d => d.bonId === bon.id)?.documents        || null
  bon.candidature  = cands.find(c => c.bonId === bon.id)                  || null
  res.json(bon)
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
app.get('/api/generate', (req, res) => {
  const { projectId } = req.query
  if (!projectId) return res.status(400).json({ error: 'projectId requis' })
  const all   = db.read('rfq-generated.json') || []
  const found = all.find(d => d.bonId === projectId)
  if (!found) return res.status(404).json({ error: 'Aucun document pour ce projet' })
  res.json({ documents: found.documents })
})

app.post('/api/generate', async (req, res) => {
  const { projectId, documentType = 'all' } = req.body
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
      const result = await documentGenerator.generate(bon, analysis, documentType)
      const all    = db.read('rfq-generated.json') || []
      const found  = all.find(d => d.bonId === projectId)
      documents    = found?.documents || {}
      documents[documentType] = result.data
    }

    const all    = db.read('rfq-generated.json') || []
    const idx    = all.findIndex(d => d.bonId === projectId)
    const record = { bonId: projectId, documents, generatedAt: new Date().toISOString() }
    if (idx >= 0) all[idx] = record; else all.push(record)
    db.write('rfq-generated.json', all)

    res.json({ success: true, documents })
  } catch (e) { res.status(500).json({ success: false, error: e.message }) }
})

/* ═══════════════════════════════════════════════════════════════
   CANDIDATURES
══════════════════════════════════════════════════════════════════ */
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
  res.json({ success: true, candidature: cands[idx] })
})

app.delete('/api/candidatures/:id', (req, res) => {
  const cands = db.read('candidatures.json') || []
  const idx   = cands.findIndex(c => c.id === req.params.id)
  if (idx < 0) return res.status(404).json({ error: 'Candidature introuvable' })
  cands.splice(idx, 1)
  db.write('candidatures.json', cands)
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
   COPILOTE IA (chat)
══════════════════════════════════════════════════════════════════ */
app.post('/api/chat', async (req, res) => {
  const { message, messages = [], projectId } = req.body
  const userMessage = message || messages[messages.length - 1]?.content
  if (!userMessage) return res.status(400).json({ error: 'message requis' })

  let context = ''
  if (projectId) {
    const bons = db.read('procurement-analysis.json') || []
    const bon  = bons.find(b => b.id === projectId)
    if (bon) context = `\nCONTEXTE PROJET:\nTitre: ${bon.title}\nAcheteur: ${bon.buyer}\nLieu: ${bon.location}\nEstimation: ${bon.estimatedBudget}\nDescription: ${(bon.description||'').substring(0, 300)}`
  }

  try {
    const history = messages.slice(0, -1).map(m => ({ role: m.role, content: m.content }))
    const reply   = await aiAnalyzer.chatWithCopilot(userMessage, history, context)
    res.json({ reply, response: reply })
  } catch (e) { res.json({ reply: `Erreur IA: ${e.message}` }) }
})

/* ═══════════════════════════════════════════════════════════════
   SETTINGS
══════════════════════════════════════════════════════════════════ */
app.get('/api/settings', (req, res) => {
  const saved = db.read('settings.json') || {}
  res.json({
    username:     process.env.MARCHESPUBLICS_USERNAME ? '***configured***' : '',
    password:     process.env.MARCHESPUBLICS_PASSWORD ? '***configured***' : '',
    groqApiKey:   process.env.GROQ_API_KEY   ? '***configured***' : '',
    openaiApiKey: process.env.OPENAI_API_KEY ? '***configured***' : '',
    scraperDelay: process.env.SCRAPER_DELAY  || '2000',
    hasCredentials: !!(process.env.MARCHESPUBLICS_USERNAME && process.env.MARCHESPUBLICS_PASSWORD),
    hasAI:          !!(process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY),
    // Schedule config
    dailyEnabled:  saved.dailyEnabled  !== false,
    dailyTime:     saved.dailyTime     || '06:00',
    maxItems:      saved.maxItems      || 50,
    // Keywords
    keywords:      saved.keywords      || null,  // null = use defaults
    defaultKeywords: require('./lib/scraper').DEFAULT_KEYWORDS,
  })
})

app.post('/api/settings', (req, res) => {
  const { username, password, groqApiKey, openaiApiKey, scraperDelay,
          dailyEnabled, dailyTime, maxItems, keywords } = req.body
  try {
    const envPath = path.join(__dirname, '.env')
    let content   = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : ''

    const setEnv = (key, val) => {
      if (val === undefined || val === null) return
      process.env[key] = String(val)
      const re = new RegExp(`^${key}=.*$`, 'm')
      content  = re.test(content) ? content.replace(re, `${key}=${val}`) : content + `\n${key}=${val}`
    }

    setEnv('MARCHESPUBLICS_USERNAME', username)
    setEnv('MARCHESPUBLICS_PASSWORD', password)
    setEnv('GROQ_API_KEY',            groqApiKey)
    setEnv('OPENAI_API_KEY',          openaiApiKey)
    setEnv('SCRAPER_DELAY',           scraperDelay)

    fs.writeFileSync(envPath, content.trim() + '\n', 'utf-8')

    // Save schedule + keyword config to settings.json
    const saved = db.read('settings.json') || {}
    if (dailyEnabled  !== undefined) saved.dailyEnabled  = dailyEnabled
    if (dailyTime     !== undefined) saved.dailyTime     = dailyTime
    if (maxItems      !== undefined) saved.maxItems      = parseInt(maxItems)
    if (keywords      !== undefined) saved.keywords      = keywords

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
   SPA fallback
══════════════════════════════════════════════════════════════════ */
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'))
})

/* ─────────────────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`\n🚀 Procurement Intelligence Server`)
  console.log(`   http://localhost:${PORT}`)
  console.log(`   Credentials: ${process.env.MARCHESPUBLICS_USERNAME ? '✅' : '❌ non configurés'}`)
  console.log(`   AI engine:   ${process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY ? '✅' : '⚠️  non configuré'}`)
  console.log(`   Daily cron:  ✅ actif`)
  console.log()
})
