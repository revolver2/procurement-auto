'use strict'

const gemini = require('./ai-providers/gemini')
const local  = require('./ai-providers/local-rulebased')

// Track last call status so diagnostics endpoint can report it
let _lastProvider = null
let _lastModel    = null
let _lastError    = null
let _lastCalledAt = null

function getStatus() {
  return {
    lastProvider: _lastProvider,
    lastModel:    _lastModel,
    lastError:    _lastError,
    lastCalledAt: _lastCalledAt,
  }
}

// Drop-in replacement for groq client — same interface: router.chat.completions.create(...)
const aiRouter = {
  chat: {
    completions: {
      create: async ({ messages, model, temperature = 0.3, max_tokens = 2000 }) => {
        _lastCalledAt = new Date().toISOString()

        if (!process.env.GEMINI_API_KEY) {
          console.log('[AIRouter] GEMINI_API_KEY absent — using local-rulebased')
          _lastProvider = 'local-rulebased'
          _lastModel    = 'local-rulebased'
          _lastError    = 'GEMINI_API_KEY non configuré'
          const text = await local.complete({ messages, reason: 'no_key' })
          return { choices: [{ message: { content: text, role: 'assistant' } }], model: 'local-rulebased', _provider: 'local-rulebased', _reason: 'no_key' }
        }

        console.log('[AIRouter] Provider selected: gemini')
        try {
          const result = await gemini.complete({ messages, temperature, maxTokens: max_tokens })
          const usedModel = result.model || gemini.PRIMARY_MODEL
          console.log(`[AIRouter] Gemini response received (model: ${usedModel})`)
          _lastProvider = 'gemini'
          _lastModel    = usedModel
          _lastError    = null
          return { choices: [{ message: { content: result.text, role: 'assistant' } }], model: usedModel, _provider: 'gemini', _reason: null }
        } catch (e) {
          const reason  = e.quotaExceeded ? 'quota_exceeded' : 'api_error'
          const errMsg  = e.message || 'Gemini API error'
          console.warn(`[AIRouter] Gemini failed (${reason}): ${errMsg.substring(0, 120)}`)
          console.warn('[AIRouter] Falling back to local-rulebased')
          _lastProvider = 'local-rulebased'
          _lastModel    = 'local-rulebased'
          _lastError    = errMsg.substring(0, 200)
          const text = await local.complete({ messages, reason })
          return { choices: [{ message: { content: text, role: 'assistant' } }], model: 'local-rulebased', _provider: 'local-rulebased', _reason: reason }
        }
      }
    }
  }
}

module.exports = aiRouter
module.exports.getStatus = getStatus
