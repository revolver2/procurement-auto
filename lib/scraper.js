'use strict'
require('dotenv').config()
const { chromium } = require('playwright')
const { v4: uuidv4 } = require('uuid')
const db = require('./db')

const BASE_URL  = 'https://www.marchespublics.gov.ma'
const BDC_BASE  = `${BASE_URL}/bdc`
const LIST_URL  = `${BDC_BASE}/entreprise/consultation/`

const DELAY = parseInt(process.env.SCRAPER_DELAY || '1500')
const sleep = ms => new Promise(r => setTimeout(r, ms))

/* ── Keyword list (user-configurable via settings) ─────────────── */
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

/* ── Parse list card HTML ───────────────────────────────────────── */
function parseCard(cardHtml, baseUrl) {
  const hrefMatch  = cardHtml.match(/href="(\/bdc\/entreprise\/consultation\/show\/(\d+))"/)
  if (!hrefMatch) return null
  const path    = hrefMatch[1]
  const id      = hrefMatch[2]
  const url     = `${baseUrl}${path}`

  const refMatch   = cardHtml.match(/Référence\s*:\s*([^<"]+?)(?:<|"|\s*$)/)
  const objMatch   = cardHtml.match(/Objet\s*:\s*<\/span>\s*([^<]+)/)
  const buyMatch   = cardHtml.match(/Acheteur\s*:\s*<\/span>\s*([^<]+)/)
  const dateMatch  = cardHtml.match(/fa-calendar[^>]*>\s*<\/i>\s*(\d{2}\/\d{2}\/\d{4})/)
  const locMatch   = cardHtml.match(/data-bs-title="([^"]+)"/)
  const statusMatch = cardHtml.match(/badge[^>]*>([^<]+)</)

  const clean = s => s ? s.replace(/&#039;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim() : ''

  return {
    _id:       id,
    sourceUrl: url,
    reference: clean(refMatch?.[1]) || `BC-${id}`,
    title:     clean(objMatch?.[1])  || `Bon de commande ${id}`,
    buyer:     clean(buyMatch?.[1])  || '',
    deadline:  clean(dateMatch?.[1]) || '',
    location:  clean(locMatch?.[1])  || '',
    status:    clean(statusMatch?.[1]) || 'En cours',
  }
}

/* ── Fetch one page of results ──────────────────────────────────── */
async function fetchListPage(page, keyword, pageNum, pageSize = 50) {
  const params = new URLSearchParams({
    'search_consultation_entreprise[keyword]': keyword || '',
    'search_consultation_entreprise[pageSize]': String(pageSize),
    'search_consultation_entreprise[page]': String(pageNum),
  })
  const url = `${LIST_URL}?${params}`
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await sleep(800)

  const html = await page.content()

  // Extract total count
  const totalMatch = html.match(/Nombre de résultats\s*:\s*(\d+)/)
  const total = totalMatch ? parseInt(totalMatch[1]) : 0

  // Extract all cards
  const cards = []
  const cardRegex = /<div[^>]+entreprise__card[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>\s*<\/a>\s*<\/div>/g
  let m
  while ((m = cardRegex.exec(html)) !== null) {
    const card = parseCard(m[0], BASE_URL)
    if (card) cards.push(card)
  }

  return { cards, total }
}

/* ── Extract bon details from detail page ───────────────────────── */
async function scrapeBonDetails(context, url) {
  const page = await context.newPage()
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 })
    await sleep(600)

    const html = await page.content()
    const clean = s => s ? s.replace(/&#039;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim() : ''

    // Reference from h4
    const refMatch = html.match(/<h4[^>]*>#([^<]+)<\/h4>/)
    const reference = clean(refMatch?.[1]) || ''

    // Objet (title/description)
    const objMatch = html.match(/text-uppercase">Objet<\/span>[\s\S]*?<span class="text-black">([^<]+)<\/span>/)
    const description = clean(objMatch?.[1]) || ''

    // Buyer
    const buyerMatch = html.match(/Acheteur public<\/span>\s*<span>([^<]+)<\/span>/)
    const buyer = clean(buyerMatch?.[1]) || ''

    // Dates
    const pubMatch = html.match(/Date mise en ligne[\s\S]*?data-bs-title="([^"]+)"/)
    const publicationDate = clean(pubMatch?.[1]) || ''

    const deadlineMatch = html.match(/Date limite de réception des devis[\s\S]*?<span>([^<]+)<\/span>/)
    const deadline = clean(deadlineMatch?.[1]) || ''

    // Location
    const locMatch = html.match(/Lieu d&#039;exécution[\s\S]*?data-bs-title="([^"]+)"/)
    const location = clean(locMatch?.[1]) || ''

    // Category & nature
    const catMatch = html.match(/Catégorie principale<\/span><span>([^<]+)<\/span>/)
    const category = clean(catMatch?.[1]) || ''

    const natureMatch = html.match(/Nature de prestation[\s\S]*?<span>([^<]+)<\/span>/)
    const naturePrestation = clean(natureMatch?.[1]) || ''

    // Articles
    const articles = []
    const articleRegex = /<button[^>]*accordion-button[^>]*>[\s\S]*?<span[^>]*>\s*#(\d+)\s*<\/span>([\s\S]*?)<\/button>[\s\S]*?Caractéristiques[^<]*<span[^>]*>([^<]*)<\/span>[\s\S]*?Unité de mesure[\s\S]*?content__article--subMiniCard">([\s\S]*?)<\/div>[\s\S]*?Quantité[\s\S]*?content__article--subMiniCard">([\s\S]*?)<\/div>/g
    let am
    while ((am = articleRegex.exec(html)) !== null) {
      articles.push({
        num:         parseInt(am[1]) || articles.length + 1,
        designation: clean(am[2]) + (clean(am[3]) ? ' — ' + clean(am[3]) : ''),
        unite:       clean(am[4]) || 'U',
        quantite:    parseFloat(clean(am[5]).replace(/\s/g, '').replace(',', '.')) || 0,
        prixUnitaireHT: 0,
        montantHT:   0,
      })
    }

    // Documents
    const docLinks = []
    const docRegex = /href="(\/bdc\/entreprise\/consultation\/download\/[^"]+)"[^>]*>([^<]+)<\/a>/g
    let dm
    while ((dm = docRegex.exec(html)) !== null) {
      docLinks.push({ url: `${BASE_URL}${dm[1]}`, name: clean(dm[2]) })
    }

    return {
      reference, description, buyer, publicationDate, deadline,
      location, category, naturePrestation,
      articles,
      documents: docLinks,
      totalHT: 0, tva: 0, totalTTC: 0,
      estimatedBudget: '', caution: '', contact: '',
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
  const page = await context.newPage()
  const bons = []
  const seenIds = new Set()

  try {
    log('📋 Accès à marchespublics.gov.ma/bdc (sans connexion)...')

    // Search per keyword group to get relevant results
    const keywords = getKeywords()
    // Use distinct search terms (avoid redundant ones)
    const searchTerms = [...new Set(keywords.map(k => norm(k).split(' ')[0]))].slice(0, 15)

    for (const term of searchTerms) {
      if (bons.length >= maxItems) break
      log(`🔍 Recherche: "${term}"...`)

      try {
        const { cards, total } = await fetchListPage(page, term, 1, 50)
        log(`   → ${total} résultats, ${cards.length} sur cette page`)

        for (const card of cards) {
          if (bons.length >= maxItems) break
          if (seenIds.has(card._id)) continue
          seenIds.add(card._id)

          if (!bonMatchesKeywords({ title: card.title, buyer: card.buyer, category: '', description: '' })) continue

          await sleep(DELAY)
          log(`[${bons.length + 1}] ${card.title.substring(0, 60)}`)

          let details = {}
          try {
            details = await scrapeBonDetails(context, card.sourceUrl)
          } catch (e) {
            log(`  ⚠️  Détail indisponible: ${e.message.substring(0, 60)}`)
          }

          const bon = {
            id:              uuidv4(),
            reference:       details.reference   || card.reference,
            title:           details.description || card.title,
            buyer:           details.buyer        || card.buyer,
            location:        details.location     || card.location,
            category:        details.category     || '',
            naturePrestation: details.naturePrestation || '',
            deadline:        details.deadline     || card.deadline,
            estimatedBudget: details.estimatedBudget || '',
            description:     details.description  || card.title,
            caution:         details.caution      || '',
            contact:         details.contact      || '',
            articles:        details.articles     || [],
            totalHT:         details.totalHT      || 0,
            tva:             details.tva           || 0,
            totalTTC:        details.totalTTC      || 0,
            documents:       details.documents     || [],
            sourceUrl:       card.sourceUrl,
            resultStatus:    card.status === 'Annulé' ? 'Annulé' : 'En cours',
            publicationDate: details.publicationDate || new Date().toISOString().split('T')[0],
            scrapedAt:       new Date().toISOString(),
            keywords:        keywords.filter(kw => {
              const h = norm(`${bon?.title || card.title} ${details.description || ''} ${details.category || ''} ${details.naturePrestation || ''}`)
              return h.includes(norm(kw))
            }),
          }

          if (bonMatchesKeywords(bon)) {
            bons.push(bon)
          }
        }
      } catch (e) {
        log(`  ⚠️  Erreur recherche "${term}": ${e.message.substring(0, 60)}`)
      }
    }

    log(`✅ Scraping terminé — ${bons.length} bons correspondant aux mots-clés`)
    return bons
  } finally {
    await browser.close()
  }
}

module.exports = { scrapeBons, scrapeBonDetails, DEFAULT_KEYWORDS, bonMatchesKeywords }
