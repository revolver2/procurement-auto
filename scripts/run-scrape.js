'use strict'
require('dotenv').config()
const scraper = require('../lib/scraper')
const db      = require('../lib/db')

const maxItems = parseInt(process.env.MAX_ITEMS || process.argv[2] || '50')

;(async () => {
  console.log(`\n🚀 Scraping started — max ${maxItems} bons\n`)
  const startedAt = new Date().toISOString()
  const log = []

  try {
    const newBons  = await scraper.scrapeBons(maxItems, msg => { console.log(msg); log.push(msg) })
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

    // Append to sync history
    const history = db.read('sync-history.json') || []
    history.unshift({
      date:        new Date().toLocaleDateString('fr-MA'),
      heure:       new Date().toLocaleTimeString('fr-MA', { hour: '2-digit', minute: '2-digit' }),
      nouveaux:    newSaved,
      total:       merged.length,
      statut:      'Succès',
      startedAt,
      finishedAt,
      triggeredBy: 'github-actions',
    })
    db.write('sync-history.json', history.slice(0, 100))

    // Add notification if new bons found
    if (newSaved > 0) {
      const notifs = db.read('notifications.json') || []
      notifs.unshift({
        id: Date.now(), read: false, createdAt: new Date().toISOString(),
        type: 'new_bons',
        title: `${newSaved} nouveau${newSaved > 1 ? 'x' : ''} bon${newSaved > 1 ? 's' : ''} trouvé${newSaved > 1 ? 's' : ''}`,
        message: `Scraping automatique GitHub Actions : ${newSaved} bon(s) correspondant à vos mots-clés.`,
        count: newSaved,
      })
      db.write('notifications.json', notifs.slice(0, 200))
    }

    console.log(`\n✅ Done — ${newSaved} new bons saved (total: ${merged.length})`)
    process.exit(0)
  } catch (e) {
    console.error('\n❌ Scrape failed:', e.message)

    const history = db.read('sync-history.json') || []
    history.unshift({
      date:     new Date().toLocaleDateString('fr-MA'),
      heure:    new Date().toLocaleTimeString('fr-MA', { hour: '2-digit', minute: '2-digit' }),
      nouveaux: 0,
      total:    (db.read('procurement-analysis.json') || []).length,
      statut:   'Échec',
      erreur:   e.message.substring(0, 120),
      startedAt,
      finishedAt: new Date().toISOString(),
      triggeredBy: 'github-actions',
    })
    db.write('sync-history.json', history.slice(0, 100))

    process.exit(1)
  }
})()
