'use strict'

const fs    = require('fs')
const path  = require('path')
const https = require('https')
const http  = require('http')

const ATTACHMENTS_DIR = path.resolve(__dirname, '..', '..', 'data', 'attachments')

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }) }

function detectExt(name, url) {
  if (/\.zip/i.test(name + url)) return '.zip'
  if (/\.pdf/i.test(name + url)) return '.pdf'
  if (/\.docx/i.test(name + url)) return '.docx'
  if (/\.doc/i.test(name + url)) return '.doc'
  return '.zip' // default — many portals send ZIPs
}

function safeFilename(name, url) {
  const ext  = detectExt(name, url)
  const base = (name || 'attachment')
    .replace(/[^a-zA-Z0-9\-_. ]/g, '_')
    .replace(/\s+/g, '_')
    .substring(0, 60)
  return base.endsWith(ext) ? base : base + ext
}

async function downloadAttachment(att, bonId, context = null, forceRefresh = false) {
  const safeId    = bonId.replace(/[^a-zA-Z0-9\-]/g, '_')
  const dir       = path.join(ATTACHMENTS_DIR, safeId)
  ensureDir(dir)

  const filename  = safeFilename(att.name, att.url)
  const localPath = path.join(dir, filename)

  if (!forceRefresh && fs.existsSync(localPath) && fs.statSync(localPath).size > 200) {
    return { localPath, filename, downloaded: true, skipped: true }
  }

  // Try direct HTTP download first
  try {
    await fetchFile(att.url, localPath)
    const size = fs.existsSync(localPath) ? fs.statSync(localPath).size : 0
    if (size > 200) return { localPath, filename, downloaded: true, skipped: false }
    throw new Error(`Fichier trop petit (${size} octets) — probablement invalide`)
  } catch (e) {
    // Fallback: Playwright browser context (for auth-gated pages)
    if (context) {
      try {
        const ok = await playwrightDownload(att.url, localPath, context)
        if (ok) return { localPath, filename, downloaded: true, skipped: false }
      } catch (pe) {
        console.error('[Downloader] Playwright fallback failed:', pe.message)
      }
    }
    if (fs.existsSync(localPath)) try { fs.unlinkSync(localPath) } catch {}
    return { localPath: null, filename, downloaded: false, error: e.message }
  }
}

function fetchFile(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http
    const tmp   = dest + '.tmp'
    const file  = fs.createWriteStream(tmp)

    const req = proto.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ProcurementBot/1.0)',
        'Accept':     'application/zip,application/pdf,*/*',
      },
      timeout: 25000,
    }, res => {
      // Follow redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        file.close()
        fs.unlink(tmp, () => {})
        fetchFile(res.headers.location, dest).then(resolve).catch(reject)
        return
      }
      if (res.statusCode >= 400) {
        file.close()
        fs.unlink(tmp, () => {})
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }
      res.pipe(file)
      file.on('finish', () => file.close(() => { fs.renameSync(tmp, dest); resolve() }))
    })

    req.on('error', err => { file.close(); fs.unlink(tmp, () => {}); reject(err) })
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout téléchargement')) })
  })
}

async function playwrightDownload(url, dest, context) {
  const page = await context.newPage()
  try {
    const downloadPromise = page.waitForEvent('download', { timeout: 25000 }).catch(() => null)
    await page.goto(url, { timeout: 20000, waitUntil: 'domcontentloaded' }).catch(() => {})
    const download = await downloadPromise

    if (download && typeof download.saveAs === 'function') {
      await download.saveAs(dest)
      await page.close()
      return true
    }

    // Last resort: grab binary via page fetch
    const bytes = await page.evaluate(async (u) => {
      try {
        const r = await fetch(u, { credentials: 'include' })
        if (!r.ok) return null
        const buf = await r.arrayBuffer()
        return Array.from(new Uint8Array(buf))
      } catch { return null }
    }, url)

    if (bytes && bytes.length > 200) {
      fs.writeFileSync(dest, Buffer.from(bytes))
      await page.close()
      return true
    }

    await page.close()
    return false
  } catch (e) {
    try { await page.close() } catch {}
    throw e
  }
}

module.exports = { downloadAttachment, ATTACHMENTS_DIR }
