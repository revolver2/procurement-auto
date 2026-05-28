'use strict'

const https = require('https')
const fs    = require('fs')
const path  = require('path')

const DATA_DIR = path.resolve(__dirname, '../data')
const OWNER    = process.env.GITHUB_OWNER || 'revolver2'
const REPO     = process.env.GITHUB_REPO  || 'procurement-auto'
const BRANCH   = process.env.GITHUB_BRANCH || 'main'

function getToken() {
  return process.env.GITHUB_PAT || process.env.GITHUB_TOKEN || ''
}

/* ── Get current file SHA from GitHub ──────────────────────────── */
function getFileSha(repoPath, token) {
  return new Promise(resolve => {
    const options = {
      hostname: 'api.github.com',
      path:     `/repos/${OWNER}/${REPO}/contents/${repoPath}?ref=${BRANCH}`,
      headers:  { 'Authorization': `Bearer ${token}`, 'User-Agent': 'ProcurementBot/1.0', 'Accept': 'application/vnd.github.v3+json' },
    }
    const req = https.get(options, res => {
      let body = ''
      res.on('data', d => body += d)
      res.on('end', () => {
        try { resolve(JSON.parse(body).sha || null) } catch { resolve(null) }
      })
    })
    req.on('error', () => resolve(null))
  })
}

/* ── PUT file to GitHub ─────────────────────────────────────────── */
function putFile(repoPath, b64Content, sha, message, token) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      message,
      content: b64Content,
      branch:  BRANCH,
      ...(sha ? { sha } : {}),
    })
    const opts = {
      hostname: 'api.github.com',
      method:   'PUT',
      path:     `/repos/${OWNER}/${REPO}/contents/${repoPath}`,
      headers:  {
        'Authorization':  `Bearer ${token}`,
        'User-Agent':     'ProcurementBot/1.0',
        'Accept':         'application/vnd.github.v3+json',
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }
    const req = https.request(opts, res => {
      let rb = ''
      res.on('data', d => rb += d)
      res.on('end', () => {
        const ok = res.statusCode >= 200 && res.statusCode < 300
        if (ok) resolve({ ok: true, status: res.statusCode })
        else    reject(new Error(`GitHub API ${res.statusCode}: ${rb.substring(0, 200)}`))
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

/* ── Public: push a data file to GitHub ────────────────────────── */
async function pushFile(filename, message) {
  const token = getToken()
  if (!token) {
    // Not in production or token not set — skip silently
    return { skipped: true, reason: 'GITHUB_PAT not set' }
  }

  const localPath  = path.join(DATA_DIR, filename)
  const content    = fs.existsSync(localPath) ? fs.readFileSync(localPath, 'utf8') : '[]'
  const b64        = Buffer.from(content).toString('base64')
  const repoPath   = `data/${filename}`
  const commitMsg  = message || `sync: update ${filename} [server]`

  const sha = await getFileSha(repoPath, token)
  return putFile(repoPath, b64, sha, commitMsg, token)
}

/* ── Pull a data file from GitHub (returns parsed JSON or null) ─── */
async function pullFile(filename) {
  const token = getToken()
  if (!token) return null

  return new Promise(resolve => {
    const options = {
      hostname: 'api.github.com',
      path:     `/repos/${OWNER}/${REPO}/contents/data/${filename}?ref=${BRANCH}`,
      headers:  { 'Authorization': `Bearer ${token}`, 'User-Agent': 'ProcurementBot/1.0', 'Accept': 'application/vnd.github.v3+json' },
    }
    const req = https.get(options, res => {
      let body = ''
      res.on('data', d => body += d)
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body)
          if (parsed.content) {
            const decoded = JSON.parse(Buffer.from(parsed.content, 'base64').toString('utf8'))
            resolve(decoded)
          } else {
            resolve(null)
          }
        } catch { resolve(null) }
      })
    })
    req.on('error', () => resolve(null))
    req.setTimeout(10000, () => { req.destroy(); resolve(null) })
  })
}

module.exports = { pushFile, pullFile }
