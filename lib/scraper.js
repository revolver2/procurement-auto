'use strict'
require('dotenv').config()
const { chromium } = require('playwright')
const { v4: uuidv4 } = require('uuid')
const db = require('./db')

const BASE_URL         = 'https://www.marchespublics.gov.ma'
const LOGIN_URL        = `${BASE_URL}/index.php?page=entreprise.EntrepriseLogin`
const LIST_URL         = `${BASE_URL}/index.php?page=entreprise.ConsultationListBC`
const LIST_ALL_URL     = `${BASE_URL}/index.php?page=entreprise.ConsultationListBC&AllAnnoncesWithoutPagination=1`

const CREDENTIALS = {
  username: process.env.MARCHESPUBLICS_USERNAME,
  password: process.env.MARCHESPUBLICS_PASSWORD,
}

const DELAY = parseInt(process.env.SCRAPER_DELAY || '2000')
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

function bonMatchesKeywords(bon) {
  const keywords = getKeywords()
  const haystack = [bon.title, bon.description, bon.category, bon.buyer]
    .join(' ')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents for matching
  return keywords.some(kw => {
    const normalised = kw.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    return haystack.includes(normalised)
  })
}

/* ── Authentication ─────────────────────────────────────────────── */
async function authenticate(log) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  })
  const page = await context.newPage()

  // Try saved cookies first
  const savedCookies = db.read('cookies.json')
  if (savedCookies?.length) {
    await context.addCookies(savedCookies)
    log?.('🍪 Session cookies restored')
    await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 20000 })
    await sleep(1500)
    const url = page.url()
    if (!url.includes('Login') && !url.includes('login') && !url.includes('index.php?page=entreprise.EntrepriseLogin')) {
      log?.('✅ Session still valid')
      return { browser, context, page }
    }
    log?.('⚠️  Session expired, re-logging in...')
  }

  if (!CREDENTIALS.username || !CREDENTIALS.password) {
    await browser.close()
    throw new Error('Identifiants marchespublics.gov.ma non configurés. Vérifiez les Paramètres.')
  }

  log?.('🔐 Connexion à marchespublics.gov.ma...')
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await sleep(1200)

  // Fill login form
  await page.fill('input[name="login"]', CREDENTIALS.username)
  await sleep(400)
  await page.fill('input[name="password"]', CREDENTIALS.password)
  await sleep(400)

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
    page.click('input[type="submit"], button[type="submit"]'),
  ])
  await sleep(2000)

  if (page.url().includes('Login') || page.url().includes('erreur') || page.url().includes('error')) {
    await browser.close()
    throw new Error('Connexion échouée — identifiants incorrects ou compte bloqué')
  }

  const cookies = await context.cookies()
  db.write('cookies.json', cookies)
  log?.('✅ Connecté avec succès')
  return { browser, context, page }
}

/* ── Extract bon details from detail page ───────────────────────── */
async function scrapeBonDetails(context, url) {
  const page = await context.newPage()
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 })
    await sleep(800)

    const extractField = async (...labels) => {
      for (const label of labels) {
        try {
          const el = await page.$(`td:has-text("${label}") + td, th:has-text("${label}") + td, dt:has-text("${label}") + dd`)
          if (el) {
            const t = (await el.innerText()).trim()
            if (t && t.length > 0) return t
          }
        } catch { /* skip */ }
      }
      return ''
    }

    // Extract reference from URL or page
    let reference = ''
    const urlMatch = url.match(/idBC=(\d+)|id=(\d+)|\/(\d{4,})\b/)
    if (urlMatch) reference = `BC-${urlMatch[1] || urlMatch[2] || urlMatch[3]}`

    // Get reference from page text if not in URL
    if (!reference) {
      try {
        const refEl = await page.$('td:has-text("Référence") + td, td:has-text("N°") + td, td:has-text("Numéro") + td')
        if (refEl) reference = (await refEl.innerText()).trim()
      } catch { /* skip */ }
    }

    // Articles table
    const articles = await page.$$eval('table tbody tr', rows =>
      rows.map(row => {
        const cells = row.querySelectorAll('td')
        if (cells.length < 3) return null
        const parseNum = s => parseFloat((s || '').replace(/\s/g, '').replace(/,/g, '.').replace(/[^\d.]/g, '')) || 0
        const designation = cells[1]?.textContent.trim() || cells[0]?.textContent.trim() || ''
        if (!designation || designation.length < 2) return null
        return {
          num:            parseInt(cells[0]?.textContent) || 0,
          designation,
          unite:          cells[2]?.textContent.trim() || 'U',
          quantite:       parseNum(cells[3]?.textContent),
          prixUnitaireHT: parseNum(cells[4]?.textContent),
          montantHT:      parseNum(cells[5]?.textContent),
        }
      }).filter(Boolean)
    ).catch(() => [])

    const totalHT = articles.reduce((s, a) => s + (a.montantHT || 0), 0)

    const docLinks = await page.$$eval(
      'a[href*=".pdf"], a[href*="document"], a[href*="fichier"], a[href*="file"]',
      els => els.map(a => a.href)
    ).catch(() => [])

    // Full page text for better field extraction
    const pageText = await page.innerText('body').catch(() => '')

    // Extract deadline more aggressively
    let deadline = await extractField('Date limite', "Date d'ouverture", 'Délai remise', 'Ouverture des plis')
    if (!deadline) {
      const m = pageText.match(/(\d{2}[\/\-]\d{2}[\/\-]\d{4}(?:\s+\d{2}[:\h]\d{2})?)/g)
      if (m) deadline = m[0]
    }

    return {
      reference,
      location:        await extractField("Lieu d'exécution", 'Lieu exécution', 'Lieu', 'Région', 'Ville'),
      estimatedBudget: await extractField('Estimation', 'Montant estimé', 'Budget estimatif', 'Budget'),
      description:     await extractField('Objet', 'Description', 'Intitulé', 'Spécifications'),
      caution:         await extractField('Caution provisoire', 'Cautionnement', 'Caution'),
      contact:         await extractField('Contact', 'Responsable', 'Maître d\'ouvrage'),
      deadline,
      publicationDate: await extractField('Date publication', 'Date de publication', 'Date mise en ligne'),
      articles,
      totalHT,
      tva:      totalHT * 0.20,
      totalTTC: totalHT * 1.20,
      documents: [...new Set(docLinks)],
    }
  } finally {
    await page.close()
  }
}

/* ── Extract row data from list ─────────────────────────────────── */
async function extractRowData(row, index) {
  const cells = await row.$$('td')
  if (cells.length < 2) return null

  const getText = async idx => {
    try { return (await cells[idx]?.innerText())?.trim() || '' } catch { return '' }
  }

  const col0 = await getText(0)
  const col1 = await getText(1)
  const col2 = await getText(2)
  const col3 = await getText(3)
  const col4 = await getText(4)
  const col5 = await getText(5)
  const col6 = await getText(6)

  const linkEl = await row.$('a')
  const href = linkEl ? await linkEl.getAttribute('href') : null
  const url = href
    ? href.startsWith('http') ? href : `${BASE_URL}/${href.replace(/^\//, '')}`
    : ''

  // Heuristic: first numeric-looking cell may be reference, title in longest cell
  const texts = [col0, col1, col2, col3, col4, col5, col6].filter(Boolean)
  const title    = texts.sort((a, b) => b.length - a.length)[0] || `Bon ${index}`
  const buyer    = col2 || col3 || ''
  const location = col4 || col3 || ''
  const category = col5 || col4 || ''
  const deadline = col6 || col5 || ''
  const reference = texts.find(t => /BC|BC-|N°\s*\d/i.test(t)) || `BC-${Date.now()}-${index}`

  return { title, buyer, location, category, deadline, reference, url }
}

/* ── Main scrape function ───────────────────────────────────────── */
async function scrapeBons(maxItems = 50, onProgress) {
  const log = msg => { console.log('[Scraper]', msg); onProgress?.(msg) }

  const { browser, context, page } = await authenticate(log)
  const bons = []
  const startTime = Date.now()

  try {
    log('📋 Chargement de la liste des bons de commande...')
    await page.goto(LIST_ALL_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await sleep(DELAY)

    const rows = await page.$$('table tbody tr, .bc-row, tr[class*="ligne"]')
    log(`📊 ${rows.length} lignes trouvées — filtrage par mots-clés...`)

    // First pass: collect row data and filter by keywords quickly
    const candidates = []
    for (let i = 0; i < rows.length && candidates.length < maxItems * 3; i++) {
      try {
        const data = await extractRowData(rows[i], i)
        if (!data) continue
        // Quick keyword filter on title + category
        const quickCheck = `${data.title} ${data.category}`.toLowerCase()
          .normalize('NFD').replace(/[̀-ͯ]/g, '')
        const keywords = getKeywords()
        const matches = keywords.some(kw =>
          quickCheck.includes(kw.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''))
        )
        if (matches) candidates.push(data)
      } catch { /* skip */ }
    }

    log(`🎯 ${candidates.length} bons correspondent aux mots-clés — chargement des détails...`)
    const toProcess = candidates.slice(0, maxItems)

    for (let i = 0; i < toProcess.length; i++) {
      const { title, buyer, location, category, deadline, reference, url } = toProcess[i]
      try {
        await sleep(DELAY)
        log(`[${i + 1}/${toProcess.length}] ${title.substring(0, 55)}`)

        let details = {}
        if (url) {
          try {
            details = await scrapeBonDetails(context, url)
          } catch (detailErr) {
            log(`  ⚠️  Détail indisponible: ${detailErr.message.substring(0, 60)}`)
          }
        }

        const bon = {
          id:              uuidv4(),
          reference:       details.reference || reference,
          title,
          buyer,
          location:        details.location        || location,
          category,
          deadline:        details.deadline        || deadline,
          estimatedBudget: details.estimatedBudget || '',
          description:     details.description     || '',
          caution:         details.caution         || '',
          contact:         details.contact         || '',
          articles:        details.articles        || [],
          totalHT:         details.totalHT         || 0,
          tva:             details.tva             || 0,
          totalTTC:        details.totalTTC        || 0,
          documents:       details.documents       || [],
          sourceUrl:       url,
          resultStatus:    'En cours',
          publicationDate: details.publicationDate || new Date().toISOString().split('T')[0],
          scrapedAt:       new Date().toISOString(),
          keywords:        getKeywords().filter(kw => {
            const n = kw.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
            const h = `${title} ${category} ${details.description || ''}`.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
            return h.includes(n)
          }),
        }

        // Final check: full keyword match including description
        if (bonMatchesKeywords(bon)) {
          bons.push(bon)
        }
      } catch (err) {
        log(`  ❌ Erreur ligne ${i}: ${err.message.substring(0, 60)}`)
      }
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000)
    log(`✅ Scraping terminé: ${bons.length} bons qualifiés en ${elapsed}s`)
    return bons
  } finally {
    await browser.close()
  }
}

module.exports = { scrapeBons, scrapeBonDetails, DEFAULT_KEYWORDS, bonMatchesKeywords }
