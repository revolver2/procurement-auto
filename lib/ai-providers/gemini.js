'use strict'

const GEMINI_BASE = 'https://generativelanguage.googleapis.com'

async function complete({ messages, model = 'gemini-2.5-flash', temperature = 0.3, maxTokens = 2000 }) {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY not set')

  // Merge system messages into first user message (Gemini has no system role)
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
    const err = new Error(msg)
    err.status = res.status
    throw err
  }

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new Error('Gemini returned empty response')
  return text
}

module.exports = { complete }
