'use strict'
const fs   = require('fs')
const path = require('path')

const DATA_DIR   = path.join(__dirname, '../data')
const BACKUP_DIR = path.join(DATA_DIR, 'backups')

if (!fs.existsSync(DATA_DIR))   fs.mkdirSync(DATA_DIR,   { recursive: true })
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true })

function read(filename) {
  const filepath = path.join(DATA_DIR, filename)
  try {
    if (fs.existsSync(filepath)) return JSON.parse(fs.readFileSync(filepath, 'utf8'))
    return null
  } catch (error) {
    console.error(`[db] read error ${filename}:`, error.message)
    return null
  }
}

function write(filename, data) {
  const filepath = path.join(DATA_DIR, filename)
  const tmpPath  = filepath + '.tmp'
  try {
    // Backup existing file (keep last 5 per file)
    if (fs.existsSync(filepath)) {
      const stamp      = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19)
      const base       = path.basename(filename, '.json')
      const backupPath = path.join(BACKUP_DIR, `${base}_${stamp}.json`)
      fs.copyFileSync(filepath, backupPath)

      const prefix  = base + '_'
      const backups = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith(prefix)).sort().reverse()
      backups.slice(5).forEach(b => { try { fs.unlinkSync(path.join(BACKUP_DIR, b)) } catch {} })
    }

    // Atomic write: write to .tmp then rename
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8')
    fs.renameSync(tmpPath, filepath)
  } catch (error) {
    console.error(`[db] write error ${filename}:`, error.message)
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath) } catch {}
    throw error
  }
}

module.exports = { read, write, DATA_DIR }
