'use strict'
const fs   = require('fs')
const path = require('path')

const DATA_DIR = path.join(__dirname, '../data')

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })

/**
 * Read JSON file from data directory
 */
function read(filename) {
  const filepath = path.join(DATA_DIR, filename)
  try {
    if (fs.existsSync(filepath)) return JSON.parse(fs.readFileSync(filepath, 'utf8'))
    return null
  } catch (error) {
    console.error(`Error reading ${filename}:`, error.message)
    return null
  }
}

/**
 * Write JSON file to data directory
 */
function write(filename, data) {
  const filepath = path.join(DATA_DIR, filename)
  try {
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf8')
  } catch (error) {
    console.error(`Error writing ${filename}:`, error.message)
  }
}

module.exports = { read, write }
