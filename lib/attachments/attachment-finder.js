'use strict'

const AVIS_PATTERNS = [/avis/i, /cahier.{0,15}charge/i, /\bcps\b/i, /appel.{0,10}offre/i]

async function findAttachments(page) {
  try {
    const found = await page.evaluate(() => {
      const seen = new Set()
      const results = []

      function push(url, name) {
        if (!url || seen.has(url)) return
        seen.add(url)
        results.push({ url, name: (name || '').replace(/\s+/g, ' ').trim() })
      }

      // Pattern 1: direct download / file links
      document.querySelectorAll(
        'a[href*="/download/"], a[href$=".pdf"], a[href$=".zip"], a[href$=".docx"], a[href$=".doc"]'
      ).forEach(a => push(a.href, a.textContent || a.getAttribute('download') || ''))

      // Pattern 2: Links near "Pièces jointes" heading
      const allEls = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,span,td,th,div,p,label,strong'))
      const pjEl = allEls.find(el =>
        /pi[èe]ces?\s*jointes?/i.test(el.textContent.trim()) &&
        el.textContent.trim().length < 60
      )
      if (pjEl) {
        let container = pjEl.parentElement
        for (let i = 0; i < 6 && container; i++, container = container.parentElement) {
          const links = container.querySelectorAll('a[href]')
          if (links.length > 0) {
            links.forEach(a => push(a.href, a.textContent || a.getAttribute('title') || ''))
            break
          }
        }
      }

      return results
    })

    return found
      .filter(a => a.url && /^https?:\/\//.test(a.url))
      .map(a => {
        const name = a.name || a.url.split('/').pop()
        return {
          name,
          url:    a.url,
          type:   classifyAttachment(name),
          isAvis: isAvisFile(name),
        }
      })
  } catch (e) {
    console.error('[AttachmentFinder]', e.message)
    return []
  }
}

function classifyAttachment(name) {
  if (AVIS_PATTERNS.some(p => p.test(name))) return 'avis'
  if (/cps|cahier/i.test(name)) return 'cps'
  if (/r[cé]\.?\s*($|\s)|reglement/i.test(name)) return 'rc'
  return 'other'
}

function isAvisFile(name) {
  return AVIS_PATTERNS.some(p => p.test(name))
}

module.exports = { findAttachments, classifyAttachment, isAvisFile }
