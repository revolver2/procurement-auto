'use strict'

const GEMINI_BASE = 'https://generativelanguage.googleapis.com'
// Primary model, fallback model if primary quota exhausted
const PRIMARY_MODEL  = 'gemini-2.5-flash'
const FALLBACK_MODEL = 'gemini-1.5-flash'

async function complete({ messages, model = PRIMARY_MODEL, temperature = 0.3, maxTokens = 2000 }) {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY not set')
  return _attempt({ messages, model, temperature, maxTokens, apiKey, attempt: 1 })
}

async function _attempt({ messages, model, temperature, maxTokens, apiKey, attempt }) {
  const systemText = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n')
  const chatMsgs   = messages.filter(m => m.role !== 'system')

  const contents = chatMsgs.map((m, i) => ({
    role:  m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: i === 0 && systemText ? `${systemText}\n\n${m.content}` : m.content }],
  }))

  if (!contents.length) throw new Error('No messages for Gemini')

  const url  = `${GEMINI_BASE}/v1beta/models/${model}:generateContent?key=${apiKey}`
  const body = JSON.stringify({
    contents,
    generationConfig: { temperature, maxOutputTokens: maxTokens },
  })

  const res  = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal:  AbortSignal.timeout(120000),
  })

  const data = await res.json()

  if (!res.ok) {
    const msg = data?.error?.message || `Gemini HTTP ${res.status}`

    if (res.status === 429) {
      // Attempt 1: wait for parsed retry-after, then retry same model
      if (attempt === 1) {
        const retryMatch = msg.match(/retry in (\d+(?:\.\d+)?)\s*s/i)
        const waitMs = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) * 1000 : 40000
        console.log(`[Gemini] Rate limited (429) on ${model}, retrying in ${Math.ceil(waitMs/1000)}s…`)
        await new Promise(r => setTimeout(r, Math.min(waitMs, 65000)))
        return _attempt({ messages, model, temperature, maxTokens, apiKey, attempt: 2 })
      }
      // Attempt 2 same model still 429 — try fallback model once
      if (attempt === 2 && model !== FALLBACK_MODEL) {
        console.log(`[Gemini] Still rate limited on ${model}, switching to ${FALLBACK_MODEL}…`)
        return _attempt({ messages, model: FALLBACK_MODEL, temperature, maxTokens, apiKey, attempt: 3 })
      }
      // All attempts exhausted
      const err = new Error(`Quota Gemini dépassé (${model}): ${msg.substring(0, 120)}`)
      err.status = 429
      err.quotaExceeded = true
      err.geminiModel   = model
      throw err
    }

    const err = new Error(msg)
    err.status    = res.status
    err.geminiError = true
    err.geminiModel = model
    throw err
  }

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new Error(`Gemini returned empty response (model: ${model})`)
  return { text, model }
}

module.exports = { complete, PRIMARY_MODEL, FALLBACK_MODEL }
