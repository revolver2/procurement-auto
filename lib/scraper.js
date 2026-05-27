'use strict'
require('dotenv').config()
const { chromium } = require('playwright')
const { v4: uuidv4 } = require('uuid')
const db = require('./db')

const BASE_URL = 'https://www.marchespublics.gov.ma'
const LIST_URL = `${BASE_URL}/bdc/entreprise/consultation/`

const DELAY = parseInt(process.env.SCRAPER_DELAY || '1500')
const sleep = ms => new Promise(r => setTimeout(r, ms))

/* ── Settings helpers ───────────────────────────────────────────── */
function getSettings() {
  return db.read('settings.json') || {}
}

function getActivities() {
  const s = getSettings()
  if (s.activities?.length) return s.activities.filter(a => a.enabled !== false)
  // Fallback defaults
  return [
    { id: 'A', name: 'Aluminium / Menuiserie aluminium', enabled: true,
      keywords: ['aluminium', 'aluminum', 'menuiserie aluminium', 'facade aluminium', 'alucobond', 'portes aluminium', 'garde-corps', 'main courante'] },
    { id: 'B', name: 'Inox', enabled: true,
      keywords: ['inox', 'acier inoxydable'] },
    { id: 'C', name: 'Métal / Métallique', enabled: true,
      keywords: ['metallique', 'metal', 'charpente metallique', 'structure metallique', 'escalier metallique', 'ferronnerie', 'serrurerie'] },
    { id: 'D', name: 'Fourniture et pose', enabled: true,
      keywords: ['fourniture et pose', 'fourniture et installation'] },
    { id: 'E', name: 'Travaux connexes', enabled: true,
      keywords: ['cloison', 'panneaux sandwich', 'vitrage', 'abri', 'pergola'] },
  ]
}

function getExclusionKeywords() {
  const s = getSettings()
  return s.exclusionKeywords || [
    'informatique', 'logiciel', 'software', 'hardware', 'ordinateur',
    'assurance', 'formation professionnelle', 'nettoyage', 'gardiennage',
    'restauration', 'transport scolaire', 'fourniture de bureau', 'mobilier de bureau',
    'materiel medical', 'consommables medicaux', 'papeterie', 'telephonie', 'audiovisuel',
  ]
}

function getCities() {
  const s = getSettings()
  return s.cities || [
    'Casablanca', 'Rabat', 'Kenitra', 'El Jadida', 'Settat',
    'Mohammedia', 'Temara', 'Sale', 'Marrakech',
  ]
}

/* ── Text normalization ─────────────────────────────────────────── */
function norm(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
}

/* ── Activity detection ─────────────────────────────────────────── */
function detectActivity(haystack) {
  const activities = getActivities()
  const h = norm(haystack)
  for (const activity of activities) {
    for (const kw of (activity.keywords || [])) {
      if (h.includes(norm(kw))) {
        return { activityId: activity.id, activityName: activity.name, matchedKeyword: kw }
      }
    }
  }
  return null
}

/* ── Exclusion check ────────────────────────────────────────────── */
function getExclusionMatch(haystack) {
  const exclusions = getExclusionKeywords()
  const h = norm(haystack)
  return exclusions.find(kw => h.includes(norm(kw))) || null
}

/* ── City detection ─────────────────────────────────────────────── */
function detectCity(text) {
  const cities = getCities()
  const t = norm(text || '')
  return cities.find(c => t.includes(norm(c))) || ''
}

/* ── Keyword match check (all active keywords) ──────────────────── */
function bonMatchesKeywords(bon) {
  const activities = getActivities()
  const haystack = norm([bon.title, bon.description, bon.category, bon.buyer, bon.naturePrestation, bon.destination, bon.specifications].join(' '))
  return activities.some(a =>
    (a.keywords || []).some(kw => haystack.includes(norm(kw)))
  )
}

/* ── Get all search terms from activities ───────────────────────── */
function buildSearchTerms() {
  const activities = getActivities()
  const terms = new Set()
  // Add all keywords from all activities, prefer shorter specific ones for search
  for (const a of activities) {
    for (const kw of (a.keywords || [])) {
      // Use the keyword directly — server will fuzzy match
      const normalized = norm(kw)
      if (normalized.length >= 4) terms.add(normalized)
    }
  }
  return [...terms].slice(0, 25)
}

/* ── Extract cards from list page ───────────────────────────────── */
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

      return { _id: id, sourceUrl: `${base}/bdc/entreprise/consultation/show/${id}`, reference: refText, title: titleText, buyer: buyerText, deadline, location, status }
    }).filter(Boolean)
  , BASE_URL)
}

/* ── Fetch one search page ──────────────────────────────────────── */
async function fetchPage(page, keyword, pageNum, pageSize = 50) {
  const today  = new Date()
  const pad    = n => String(n).padStart(2, '0')
  const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`

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

    const reference = await page.$eval('h4', el => el.textContent.replace('#', '').trim()).catch(() => '')

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

    // Try to find montant estimé / budget / caution
    const getAmountSection = async (...labels) => {
      for (const lbl of labels) {
        const val = clean(await getIconSection(lbl))
        if (val && /\d/.test(val)) return val
      }
      return ''
    }

    const description      = clean(await getSection('OBJET') || await getSection('Objet'))
    const buyer            = clean(await getIconSection('Acheteur public'))
    const publicationDate  = clean(await getIconSection('Date mise en ligne'))
    const deadline         = clean(await getIconSection('Date limite de réception des devis'))
    const location         = clean(await getIconSection('Lieu d\'exécution'))
    const destination      = clean(await getIconSection('Destination') || await getIconSection('Lieu de livraison') || await getIconSection("Lieu d'exécution"))
    const category         = clean(await getIconSection('Catégorie principale'))
    const naturePrestation = clean(await getIconSection('Nature de prestation'))
    const estimatedAmount  = await getAmountSection('Montant estimé', 'Budget prévisionnel', 'Estimation', 'Montant')
    const caution          = await getAmountSection('Caution provisoire', 'Garantie provisoire', 'Caution')

    // Specifications: grab all text from the OBJET/description section
    const specifications = clean(await getSection('SPECIFICATION') || await getSection('Spécifications') || await getSection('Caractéristiques') || '')

    // Capture raw text snapshot (first 600 chars)
    const rawTextSnapshot = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').substring(0, 600)).catch(() => '')

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
      location, destination, specifications, category, naturePrestation,
      estimatedAmount, caution, articles, documents, rawTextSnapshot,
      estimatedBudget: estimatedAmount,
      caution: caution,
      contact: '',
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

  try {
    log('📋 Accès à marchespublics.gov.ma/bdc...')

    const searchTerms = buildSearchTerms()
    log(`🔑 Termes de recherche: ${searchTerms.join(', ')}`)

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

          // Quick exclusion check on card title
          const exclusionHit = getExclusionMatch([card.title, card.buyer].join(' '))
          if (exclusionHit) {
            log(`  🚫 Exclusion (${exclusionHit}): ${card.title.substring(0, 50)}`)
            continue
          }

          // Quick activity match on card before fetching details
          const quickActivity = detectActivity([card.title, card.buyer].join(' '))
          if (!quickActivity) continue

          await sleep(DELAY)
          log(`[${bons.length + 1}] ${card.title.substring(0, 60)}`)

          let details = {}
          try {
            details = await scrapeBonDetails(context, card.sourceUrl)
          } catch (e) {
            log(`  ⚠️  Détail indisponible: ${e.message.substring(0, 60)}`)
          }

          const titleFinal = details.description || card.title

          // Full text for activity detection and exclusion check
          const fullText = [titleFinal, details.category || '', details.naturePrestation || '', details.buyer || card.buyer, details.destination || '', details.specifications || ''].join(' ')

          // Final exclusion check with all details
          const finalExclusion = getExclusionMatch(fullText)
          if (finalExclusion) {
            log(`  🚫 Exclusion (${finalExclusion}): ${titleFinal.substring(0, 50)}`)
            continue
          }

          // Detect activity
          const activityMatch = detectActivity(fullText)
          if (!activityMatch) {
            log(`  ⛔ Hors activités: ${titleFinal.substring(0, 50)}`)
            continue
          }

          // Collect matched keywords
          const activities = getActivities()
          const h = norm(fullText)
          const keywordsMatched = activities.flatMap(a =>
            (a.keywords || []).filter(kw => h.includes(norm(kw)))
          )

          // Detect city
          const city = detectCity([details.location || card.location, details.destination || '', titleFinal].join(' '))

          const bon = {
            id:               uuidv4(),
            source:           'marchespublics.gov.ma',
            officialUrl:      card.sourceUrl,
            sourceUrl:        card.sourceUrl,
            reference:        details.reference       || card.reference,
            title:            titleFinal,
            buyer:            details.buyer           || card.buyer,
            city,
            location:         details.location        || card.location,
            destination:      details.destination     || card.location || '',
            specifications:   details.specifications  || '',
            category:         details.category        || '',
            naturePrestation: details.naturePrestation || '',
            deadline:         details.deadline        || card.deadline,
            publishDate:      details.publicationDate || new Date().toISOString().split('T')[0],
            publicationDate:  details.publicationDate || new Date().toISOString().split('T')[0],
            estimatedAmount:  details.estimatedAmount || '',
            estimatedBudget:  details.estimatedAmount || '',
            caution:          details.caution         || '',
            contact:          details.contact         || '',
            categoryMatched:  activityMatch.activityId,
            activityMatched:  activityMatch.activityName,
            keywordsMatched,
            exclusionMatched: null,
            description:      titleFinal,
            articles:         details.articles        || [],
            documents:        details.documents       || [],
            totalHT:          details.totalHT         || 0,
            tva:              details.tva              || 0,
            totalTTC:         details.totalTTC         || 0,
            resultStatus:     card.status === 'Annulé' ? 'Annulé' : 'En cours',
            rawTextSnapshot:  details.rawTextSnapshot || '',
            scrapedAt:        new Date().toISOString(),
            updatedAt:        new Date().toISOString(),
          }

          bons.push(bon)
          log(`  ✅ Retenu [${activityMatch.activityId}]: ${titleFinal.substring(0, 55)}`)
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

module.exports = { scrapeBons, scrapeBonDetails, bonMatchesKeywords, getActivities, getExclusionKeywords }
