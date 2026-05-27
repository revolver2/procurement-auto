'use strict'
require('dotenv').config()
const { chromium } = require('playwright')
const { v4: uuidv4 } = require('uuid')
const db = require('./db')

const BASE_URL = 'https://www.marchespublics.gov.ma'
const LIST_URL = `${BASE_URL}/bdc/entreprise/consultation/`

const DELAY = parseInt(process.env.SCRAPER_DELAY || '1500')
const sleep = ms => new Promise(r => setTimeout(r, ms))

/* ── Keywords ───────────────────────────────────────────────────── */
const DEFAULT_KEYWORDS = [
  'fourniture et pose',
  'aluminium', 'aluminum',
  'inox',
  'métallique', 'metallique',
  'métal', 'metal',
  'charpente métallique', 'charpente metallique',
  'menuiserie aluminium',
  'façade aluminium', 'facade aluminium',
  'habillage aluminium',
  'alucobond',
  'garde-corps', 'garde corps',
  'portes aluminium',
  'fenêtres aluminium', 'fenetres aluminium',
  'structure métallique', 'structure metallique',
  'cloison',
  'panneaux sandwich',
  'serrurerie',
  'ferronnerie',
  'vitrage',
  'construction métallique', 'construction metallique',
  'abri',
  'pergola',
  'main courante',
  'escalier métallique', 'escalier metallique',
  'rideau métallique', 'rideau metallique',
  'faux plafond métallique', 'faux plafond metallique',
]

function getKeywords() {
  const saved = db.read('settings.json')
  if (saved?.keywords?.length) return saved.keywords
  return DEFAULT_KEYWORDS
}

function norm(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
}

function bonMatchesKeywords(bon) {
  const keywords = getKeywords()
  const haystack = norm([bon.title, bon.description, bon.category, bon.buyer, bon.naturePrestation].join(' '))
  return keywords.some(kw => haystack.includes(norm(kw)))
}

/* ── Extract cards from list page using Playwright DOM ──────────── */
async function getCards(page) {
  return page.$$eval('.entreprise__card', (cards, base) =>
    cards.map(card => {
      const links    = Array.from(card.querySelectorAll('a[href]'))
      const showLink = links.find(a => a.href.includes('/show/'))
      if (!showLink) return null

      const href    = showLink.getAttribute('href') || ''
      const idMatch = href.match(/\/show\/(\d+)/)
      if (!idMatch) return null
      const id = idMatch[1]

      const clean = s => (s || '').replace(/\s+/g, ' ').trim()

      const refLink   = card.querySelector('a.font-bold')
      const refText   = clean(refLink?.textContent).replace(/^Référence\s*:\s*/i, '') || `BC-${id}`

      const objLink   = card.querySelector('a.truncate_fullWidth')
      const titleText = clean(objLink?.textContent).replace(/^Objet\s*:\s*/i, '') || `Bon ${id}`

      const allLinks  = Array.from(card.querySelectorAll('a.table__links'))
      const buyLink   = allLinks.find(a => a.textContent.includes('Acheteur'))
      const buyerText = clean(buyLink?.textContent).replace(/^Acheteur\s*:\s*/i, '') || ''

      const right      = card.querySelector('.entreprise__rightSubCard')
      const rightText  = right?.textContent || ''
      const dateMatch  = rightText.match(/(\d{2}\/\d{2}\/\d{4})/)
      const deadline   = dateMatch?.[1] || ''

      const locEl      = right?.querySelector('[data-bs-title]')
      const location   = locEl?.getAttribute('data-bs-title') || ''

      const badge      = card.querySelector('.badge')
      const status     = clean(badge?.textContent) || 'En cours'

      return {
        _id: id,
        sourceUrl: `${base}/bdc/entreprise/consultation/show/${id}`,
        reference: refText,
        title: titleText,
        buyer: buyerText,
        deadline,
        location,
        status,
      }
    }).filter(Boolean)
  , BASE_URL)
}

/* ── Fetch one search page ──────────────────────────────────────── */
async function fetchPage(page, keyword, pageNum, pageSize = 50) {
  // Only return BCs whose deadline is today or later (still open)
  const today = new Date()
  const pad = n => String(n).padStart(2, '0')
  const todayStr = `${pad(today.getDate())}/${pad(today.getMonth() + 1)}/${today.getFullYear()}`

  const params = new URLSearchParams({
    'search_consultation_entreprise[keyword]':         keyword || '',
    'search_consultation_entreprise[dateLimiteStart]': todayStr,
    'search_consultation_entreprise[pageSize]':        String(pageSize),
    'search_consultation_entreprise[page]':            String(pageNum),
  })
  await page.goto(`${LIST_URL}?${params}`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await sleep(1000)

  const total = await page.$eval('.content__resultat', el => {
    const m = el.textContent.match(/(\d+)/)
    return m ? parseInt(m[1]) : 0
  }).catch(() => 0)

  const cards = await getCards(page)
  return { cards, total }
}

/* ── Extract details from detail page ──────────────────────────── */
async function scrapeBonDetails(context, url) {
  const page = await context.newPage()
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 })
    await sleep(600)

    const clean = s => (s || '').replace(/\s+/g, ' ').replace(/&#039;/g, "'").trim()

    // Reference from h4
    const reference = await page.$eval('h4', el => el.textContent.replace('#', '').trim()).catch(() => '')

    // Sections using heading text
    const getSection = async label => {
      try {
        return await page.evaluate(lbl => {
          const spans = Array.from(document.querySelectorAll('span'))
          const heading = spans.find(s => s.textContent.trim().toUpperCase() === lbl.toUpperCase())
          if (!heading) return ''
          const container = heading.closest('.border')
          return container ? container.textContent.replace(lbl, '').trim() : ''
        }, label)
      } catch { return '' }
    }

    const getIconSection = async labelText => {
      try {
        return await page.evaluate(lbl => {
          const spans = Array.from(document.querySelectorAll('.font-bold, .fw-bold'))
          const heading = spans.find(s => s.textContent.trim().includes(lbl))
          if (!heading) return ''
          const sib = heading.nextElementSibling || heading.parentElement?.nextElementSibling
          return sib ? sib.textContent.trim() : ''
        }, labelText)
      } catch { return '' }
    }

    const description      = clean(await getSection('OBJET') || await getSection('Objet'))
    const buyer            = clean(await getIconSection('Acheteur public'))
    const publicationDate  = clean(await getIconSection('Date mise en ligne'))
    const deadline         = clean(await getIconSection('Date limite de réception des devis'))
    const location         = clean(await getIconSection('Lieu d\'exécution'))
    const category         = clean(await getIconSection('Catégorie principale'))
    const naturePrestation = clean(await getIconSection('Nature de prestation'))

    // Articles
    const articles = await page.$$eval('.accordion-item', items =>
      items.map((item, i) => {
        const btn  = item.querySelector('.accordion-button')
        const num  = parseInt(btn?.querySelector('.font-bold')?.textContent) || i + 1
        const desc = btn?.textContent.replace(/^#\d+/, '').trim() || ''
        const body = item.querySelector('.accordion-body')
        const cells = body ? Array.from(body.querySelectorAll('.content__article--subMiniCard')) : []
        const unite    = cells[0]?.textContent.trim() || 'U'
        const quantite = parseFloat((cells[1]?.textContent.trim() || '0').replace(',', '.')) || 0
        return { num, designation: desc, unite, quantite, prixUnitaireHT: 0, montantHT: 0 }
      }).filter(a => a.designation.length > 2)
    ).catch(() => [])

    // Documents
    const documents = await page.$$eval('a[href*="/download/"]', links =>
      links.map(a => ({ url: a.href, name: a.textContent.trim() }))
    ).catch(() => [])

    return {
      reference, description, buyer, publicationDate, deadline,
      location, category, naturePrestation,
      articles, documents,
      estimatedBudget: '', caution: '', contact: '',
      totalHT: 0, tva: 0, totalTTC: 0,
    }
  } finally {
    await page.close()
  }
}

/* ── Main scrape function ───────────────────────────────────────── */
async function scrapeBons(maxItems = 50, onProgress) {
  const log = msg => { console.log('[Scraper]', msg); onProgress?.(msg) }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  })
  const page    = await context.newPage()
  const bons    = []
  const seenIds = new Set()
  const keywords = getKeywords()

  try {
    log('📋 Accès à marchespublics.gov.ma/bdc (sans connexion)...')

    // Unique single-word search terms from keywords
    const searchTerms = [...new Set(
      keywords.map(k => k.split(' ')[0]).filter(t => t.length >= 4)
    )].slice(0, 15)

    for (const term of searchTerms) {
      if (bons.length >= maxItems) break
      log(`🔍 Recherche: "${term}"...`)

      try {
        const { cards, total } = await fetchPage(page, term, 1, 50)
        log(`   → ${total} résultats, ${cards.length} cards`)

        for (const card of cards) {
          if (bons.length >= maxItems) break
          if (seenIds.has(card._id)) continue
          seenIds.add(card._id)

          await sleep(DELAY)
          log(`[${bons.length + 1}] ${card.title.substring(0, 60)}`)

          let details = {}
          try {
            details = await scrapeBonDetails(context, card.sourceUrl)
          } catch (e) {
            log(`  ⚠️  Détail indisponible: ${e.message.substring(0, 60)}`)
          }

          const titleFinal = details.description || card.title
          const bon = {
            id:               uuidv4(),
            reference:        details.reference       || card.reference,
            title:            titleFinal,
            buyer:            details.buyer           || card.buyer,
            location:         details.location        || card.location,
            category:         details.category        || '',
            naturePrestation: details.naturePrestation || '',
            deadline:         details.deadline        || card.deadline,
            estimatedBudget:  details.estimatedBudget || '',
            description:      titleFinal,
            caution:          details.caution         || '',
            contact:          details.contact         || '',
            articles:         details.articles        || [],
            totalHT:          details.totalHT         || 0,
            tva:              details.tva              || 0,
            totalTTC:         details.totalTTC         || 0,
            documents:        details.documents        || [],
            sourceUrl:        card.sourceUrl,
            resultStatus:     card.status === 'Annulé' ? 'Annulé' : 'En cours',
            publicationDate:  details.publicationDate || new Date().toISOString().split('T')[0],
            scrapedAt:        new Date().toISOString(),
            keywords: keywords.filter(kw => {
              const h = norm(`${titleFinal} ${details.category || ''} ${details.naturePrestation || ''} ${card.buyer || ''}`)
              return h.includes(norm(kw))
            }),
          }

          // Accept: server already filtered by keyword, trust it
          bons.push(bon)
        }
      } catch (e) {
        log(`  ⚠️  Erreur "${term}": ${e.message.substring(0, 80)}`)
      }
    }

    log(`✅ Scraping terminé — ${bons.length} bons trouvés`)
    return bons
  } finally {
    await browser.close()
  }
}

module.exports = { scrapeBons, scrapeBonDetails, DEFAULT_KEYWORDS, bonMatchesKeywords }
