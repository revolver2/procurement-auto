'use strict'

const gemini = require('./ai-providers/gemini')
const local  = require('./ai-providers/local-rulebased')

// Drop-in replacement for groq client — same interface: router.chat.completions.create(...)
const aiRouter = {
  chat: {
    completions: {
      create: async ({ messages, model, temperature = 0.3, max_tokens = 2000 }) => {
        if (!process.env.GEMINI_API_KEY) {
          const text = await local.complete({ messages })
          return { choices: [{ message: { content: text, role: 'assistant' } }], model: 'local-rulebased', _provider: 'local-rulebased' }
        }

        try {
          const text = await gemini.complete({ messages, temperature, maxTokens: max_tokens })
          return { choices: [{ message: { content: text, role: 'assistant' } }], model: 'gemini-2.5-flash', _provider: 'gemini' }
        } catch (e) {
          console.warn('[AIRouter] Gemini failed, falling back to local:', e.message)
          const text = await local.complete({ messages })
          return { choices: [{ message: { content: text, role: 'assistant' } }], model: 'local-rulebased', _provider: 'local-rulebased' }
        }
      }
    }
  }
}

module.exports = aiRouter
