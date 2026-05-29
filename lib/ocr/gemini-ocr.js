'use strict'

const fs = require('fs')

const MODEL = 'gemini-2.5-flash'
const MAX_SIZE = 20 * 1024 * 1024  // 20 MB

/**
 * OCR a PDF file using Gemini vision.
 * Returns the extracted text string, or null on failure.
 */
async function ocrWithGemini(filePath) {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return null

  try {
    const stat = fs.statSync(filePath)
    if (stat.size > MAX_SIZE) {
      console.warn(`[OCR] File too large for inline Gemini OCR: ${stat.size} bytes`)
      return null
    }

    const base64 = fs.readFileSync(filePath).toString('base64')
    const url    = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`

    const body = JSON.stringify({
      contents: [{
        parts: [
          { inline_data: { mime_type: 'application/pdf', data: base64 } },
          { text: 'Extract the exact text from this scanned procurement AVIS document. Do not summarize. Do not invent. Return only the extracted text, preserving structure (titles, sections, tables row by row).' },
        ],
      }],
      generationConfig: { temperature: 0, maxOutputTokens: 8192 },
    })

    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal:  AbortSignal.timeout(120000),
    })

    const data = await res.json()

    if (!res.ok) {
      console.warn(`[OCR] Gemini API error (${res.status}):`, data?.error?.message || 'unknown')
      return null
    }

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || ''
    if (!text || text.length < 50) {
      console.warn('[OCR] Gemini returned empty or too-short text')
      return null
    }

    return text.trim()
  } catch (e) {
    console.warn('[OCR] Gemini OCR failed:', e.message)
    return null
  }
}

module.exports = { ocrWithGemini, MODEL }
