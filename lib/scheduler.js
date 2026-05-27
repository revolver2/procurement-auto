'use strict'
const cron    = require('node-cron')
const scraper = require('./scraper')
const db      = require('./db')

let activeScrape  = null   // promise when scraping in progress
let lastRunStatus = null   // last run result summary

/* ── Helpers ────────────────────────────────────────────────────── */
function addSyncHistory(entry) {
  const history = db.read('sync-history.json') || []
  history.unshift(entry)        // newest first
  db.write('sync-history.json', history.slice(0, 100))  // keep last 100
}

function addNotification(notif) {
  const notifs = db.read('notifications.json') || []
  notifs.unshift({ id: Date.now(), ...notif, createdAt: new Date().toISOString(), read: false })
  db.write('notifications.json', notifs.slice(0, 200))
}

/* ── Core scrape runner (shared by cron + manual trigger) ────────── */
async function runScrape(maxItems, triggeredBy = 'manual') {
  if (activeScrape) return { alreadyRunning: true }

  const startedAt = new Date().toISOString()
  const log       = []
  let result

  activeScrape = (async () => {
    try {
      const newBons  = await scraper.scrapeBons(maxItems, msg => log.push(msg))
      const existing = db.read('procurement-analysis.json') || []

      let newSaved = 0
      const merged = [...existing]
      for (const bon of newBons) {
        const isDupe = merged.find(b =>
          (bon.sourceUrl && b.sourceUrl === bon.sourceUrl) ||
          (bon.title && b.title === bon.title && b.buyer === bon.buyer)
        )
        if (!isDupe) { merged.push(bon); newSaved++ }
      }
      db.write('procurement-analysis.json', merged)

      const finishedAt = new Date().toISOString()
      result = { success: true, newSaved, total: newBons.length, log, startedAt, finishedAt, triggeredBy }
      lastRunStatus = result

      addSyncHistory({
        date:        new Date().toLocaleDateString('fr-MA'),
        heure:       new Date().toLocaleTimeString('fr-MA', { hour: '2-digit', minute: '2-digit' }),
        nouveaux:    newSaved,
        total:       merged.length,
        statut:      'Succès',
        startedAt,
        finishedAt,
        triggeredBy,
      })

      if (newSaved > 0) {
        addNotification({
          type:    'new_bons',
          title:   `${newSaved} nouveau${newSaved > 1 ? 'x' : ''} bon${newSaved > 1 ? 's' : ''} trouvé${newSaved > 1 ? 's' : ''}`,
          message: `Synchronisation ${triggeredBy === 'cron' ? 'automatique' : 'manuelle'} : ${newSaved} bon(s) correspondant à vos mots-clés.`,
          count:   newSaved,
        })
      }
    } catch (err) {
      const finishedAt = new Date().toISOString()
      result = { success: false, error: err.message, log, startedAt, finishedAt, triggeredBy }
      lastRunStatus = result

      addSyncHistory({
        date:       new Date().toLocaleDateString('fr-MA'),
        heure:      new Date().toLocaleTimeString('fr-MA', { hour: '2-digit', minute: '2-digit' }),
        nouveaux:   0,
        total:      (db.read('procurement-analysis.json') || []).length,
        statut:     'Échec',
        erreur:     err.message.substring(0, 120),
        startedAt,
        finishedAt,
        triggeredBy,
      })

      addNotification({
        type:    'error',
        title:   'Échec synchronisation',
        message: err.message.substring(0, 200),
      })
    }
  })()

  await activeScrape
  activeScrape = null
  return result
}

/* ── Daily cron ─────────────────────────────────────────────────── */
let cronJob = null

function getScheduleConfig() {
  return db.read('settings.json') || {}
}

function buildCronExpr(config) {
  // e.g. "06:00" → "0 6 * * *"
  const time = config.dailyTime || '06:00'
  const [h, m] = time.split(':').map(Number)
  return `${m || 0} ${h || 6} * * *`
}

function startCron() {
  if (cronJob) { cronJob.destroy(); cronJob = null }

  const config = getScheduleConfig()
  if (config.dailyEnabled === false) {
    console.log('[Scheduler] Daily scrape disabled in settings')
    return
  }

  const expr = buildCronExpr(config)
  const maxItems = config.maxItems || 50

  console.log(`[Scheduler] Daily scrape scheduled: ${expr} (${config.dailyTime || '06:00'}) — max ${maxItems} bons`)

  cronJob = cron.schedule(expr, async () => {
    console.log('[Scheduler] ⏰ Daily scrape triggered')
    await runScrape(maxItems, 'cron')
  }, { timezone: 'Africa/Casablanca' })
}

function stopCron() {
  if (cronJob) { cronJob.destroy(); cronJob = null }
  console.log('[Scheduler] Cron stopped')
}

function restartCron() {
  startCron()
}

function isRunning() {
  return activeScrape !== null
}

function getLastStatus() {
  return lastRunStatus
}

module.exports = { runScrape, startCron, stopCron, restartCron, isRunning, getLastStatus }
