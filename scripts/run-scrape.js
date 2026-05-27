'use strict'
require('dotenv').config()
const scraper  = require('../lib/scraper')
const db       = require('../lib/db')
const telegram = require('../lib/telegram')

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
    const addedBons = []

    for (const bon of newBons) {
      const isDupe = merged.find(b =>
        (bon.officialUrl && b.officialUrl === bon.officialUrl) ||
        (bon.sourceUrl   && b.sourceUrl   === bon.sourceUrl)   ||
        (bon.title && b.title === bon.title && b.buyer === bon.buyer)
      )
      if (!isDupe) {
        // Set initial project status for new bons
        bon.projectStatus = 'Nouveau'
        bon.statusHistory = [{ status: 'Nouveau', date: new Date().toISOString(), note: 'Scraping automatique' }]
        merged.push(bon)
        addedBons.push(bon)
        newSaved++
      }
    }

    db.write('procurement-analysis.json', merged)

    const finishedAt = new Date().toISOString()

    // Sync history
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

    // In-app notifications
    if (newSaved > 0) {
      const notifs = db.read('notifications.json') || []
      notifs.unshift({
        id: Date.now(), read: false, createdAt: new Date().toISOString(),
        type: 'new_bons',
        title: `${newSaved} nouveau${newSaved > 1 ? 'x' : ''} bon${newSaved > 1 ? 's' : ''} trouvé${newSaved > 1 ? 's' : ''}`,
        message: `Scraping automatique : ${newSaved} bon(s) correspondant aux activités cibles.`,
        count: newSaved,
      })
      db.write('notifications.json', notifs.slice(0, 200))
    }

    // Telegram notifications for each new bon
    const botToken = process.env.TELEGRAM_BOT_TOKEN
    const chatId   = process.env.TELEGRAM_CHAT_ID
    if (botToken && chatId && addedBons.length > 0) {
      console.log(`\n📱 Envoi Telegram: ${addedBons.length} message(s)...`)
      for (const bon of addedBons.slice(0, 10)) { // cap at 10 to avoid spam
        try {
          await telegram.sendMessage(botToken, chatId, telegram.formatBon(bon))
          await new Promise(r => setTimeout(r, 300))
        } catch (e) {
          console.warn('[Telegram] Failed for bon:', e.message)
        }
      }
      if (addedBons.length > 10) {
        await telegram.sendMessage(botToken, chatId,
          `📊 <b>Résumé scraping</b>\n${addedBons.length} nouveaux bons trouvés (${addedBons.length - 10} supplémentaires non affichés).`
        )
      }
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

    // Telegram error notification
    const botToken = process.env.TELEGRAM_BOT_TOKEN
    const chatId   = process.env.TELEGRAM_CHAT_ID
    if (botToken && chatId) {
      await telegram.sendMessage(botToken, chatId,
        `❌ <b>Erreur scraping</b>\n${e.message.substring(0, 200)}`
      ).catch(() => {})
    }

    process.exit(1)
  }
})()
