'use strict'

const { ocrWithGemini } = require('./gemini-ocr')

/**
 * Try all available OCR providers in priority order.
 * Returns { text, engine } or null if no provider succeeded.
 */
async function extractWithOCR(filePath) {
  if (process.env.GEMINI_API_KEY) {
    const text = await ocrWithGemini(filePath)
    if (text) return { text, engine: 'gemini' }
  }
  return null
}

function isOCRAvailable() {
  return !!(process.env.GEMINI_API_KEY)
}

module.exports = { extractWithOCR, isOCRAvailable }
