'use strict'
require('dotenv').config()
const Groq = require('groq-sdk')

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

/**
 * Analyze a procurement bon with AI
 */
async function analyzeProcurement(bon) {
  const prompt = `Analyze this procurement project and provide a JSON response with these exact keys:
{
  "complexity": "Low|Medium|High",
  "durationDays": number,
  "teamSize": number,
  "roles": ["string"],
  "risks": ["string"],
  "mitigations": ["string"],
  "suppliers": ["string"],
  "materials": [{"name":"string","quantity":"string","unit":"string","specification":"string"}],
  "laborCostEstimate": number,
  "marginOpportunity": "string",
  "notes": "string"
}

Project Details:
- Title: ${bon.title}
- Description: ${bon.description || 'N/A'}
- Location: ${bon.location}
- Estimated Budget: ${bon.estimatedBudget || 'N/A'} MAD
- Category: ${bon.category || 'N/A'}
- Articles: ${JSON.stringify(bon.articles?.slice(0, 10), null, 2)}

Respond ONLY with valid JSON, no markdown, no comments.`

  const response = await groq.chat.completions.create({
    messages: [{ role: 'user', content: prompt }],
    model: 'llama-3.3-70b-versatile',
    temperature: 0.3,
    max_tokens: 2000,
  })

  const raw = response.choices[0].message.content
    .replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()

  try {
    return JSON.parse(raw)
  } catch {
    return { raw, complexity: 'Medium', durationDays: 15, roles: [], risks: [], materials: [] }
  }
}

/**
 * Chat with Copilote IA
 */
async function chatWithCopilot(message, conversationHistory = [], context = '') {
  const messages = [
    {
      role: 'system',
      content: `You are a procurement expert assistant for Moroccan public markets (Marchés Publics du Maroc).
You help users analyze procurement notices, generate documents, estimate costs, and provide strategic advice.
Always respond in French. Be precise, concise and actionable.
${context}`,
    },
    ...conversationHistory,
    { role: 'user', content: message },
  ]

  const response = await groq.chat.completions.create({
    messages,
    model: 'llama-3.3-70b-versatile',
    temperature: 0.7,
    max_tokens: 1000,
  })

  return response.choices[0].message.content
}

module.exports = { analyzeProcurement, chatWithCopilot }
