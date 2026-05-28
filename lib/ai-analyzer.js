'use strict'
require('dotenv').config()


const groq = require('./ai-router')

/**
 * 15-point AI analysis of a procurement bon
 */
async function analyzeProcurement(bon) {
  const articlesText = bon.articles?.length
    ? bon.articles.slice(0, 12).map(a => `- ${a.designation} (qté: ${a.quantite} ${a.unite})`).join('\n')
    : 'Non renseigné'

  const prompt = `Tu es un expert en marchés publics marocains spécialisé en aluminium, inox et métallerie.
Analyse ce bon de commande et réponds UNIQUEMENT en JSON valide avec exactement ces 15 clés:

{
  "resume": "Résumé du projet en 2-3 phrases",
  "activiteDetectee": "Nom de l'activité principale: aluminium/inox/métal/etc.",
  "specificationsTechniques": ["liste des specs techniques clés"],
  "materiaux": [{"nom":"string","quantite":"string","unite":"string","specification":"string"}],
  "fournisseursRFQ": ["fournisseur 1","fournisseur 2","etc."],
  "planExecution": ["Phase 1: ...","Phase 2: ...","etc."],
  "mainOeuvre": [{"role":"string","nombre":1,"dureeJours":5}],
  "equipements": ["équipement 1","équipement 2"],
  "risques": ["risque 1","risque 2"],
  "informationsManquantes": ["info manquante 1","info manquante 2"],
  "strategieOffre": "Recommandation stratégique pour soumissionner",
  "difficulte": 5,
  "urgence": 7,
  "rentabilite": 6,
  "actionRecommandee": "Action immédiate recommandée"
}

Projet:
- Titre: ${bon.title}
- Acheteur: ${bon.buyer || 'N/A'}
- Lieu: ${bon.location || 'N/A'}
- Activité: ${bon.activityMatched || bon.category || 'N/A'}
- Estimation: ${bon.estimatedAmount || bon.estimatedBudget || 'N/A'} MAD
- Date limite: ${bon.deadline || 'N/A'}
- Description: ${(bon.description || '').substring(0, 400)}
- Spécifications: ${(bon.specifications || '').substring(0, 300)}
- Articles:\n${articlesText}

Réponds UNIQUEMENT avec le JSON, sans markdown ni commentaires.`

  const response = await groq.chat.completions.create({
    messages: [{ role: 'user', content: prompt }],
    model:    'llama-3.3-70b-versatile',
    temperature: 0.3,
    max_tokens:  2500,
  })

  const raw = response.choices[0].message.content
    .replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()

  try {
    const parsed = JSON.parse(raw)
    return {
      ...parsed,
      difficulte:   Math.min(10, Math.max(1, Number(parsed.difficulte)  || 5)),
      urgence:      Math.min(10, Math.max(1, Number(parsed.urgence)     || 5)),
      rentabilite:  Math.min(10, Math.max(1, Number(parsed.rentabilite) || 5)),
    }
  } catch {
    return {
      resume:                  raw.substring(0, 200),
      activiteDetectee:        bon.activityMatched || '—',
      specificationsTechniques: [],
      materiaux:               [],
      fournisseursRFQ:         [],
      planExecution:           [],
      mainOeuvre:              [],
      equipements:             [],
      risques:                 [],
      informationsManquantes:  [],
      strategieOffre:          '—',
      difficulte:              5,
      urgence:                 5,
      rentabilite:             5,
      actionRecommandee:       '—',
    }
  }
}

/**
 * Chat with Copilote IA
 */
async function chatWithCopilot(message, conversationHistory = [], context = '') {
  const messages = [
    {
      role: 'system',
      content: `Tu es un expert en marchés publics marocains spécialisé en aluminium, inox et métallerie.
Tu aides à analyser les bons de commande, générer des documents, estimer les coûts et proposer des stratégies.
Réponds toujours en français. Sois précis, concis et actionnable.${context}`,
    },
    ...conversationHistory,
    { role: 'user', content: message },
  ]

  const response = await groq.chat.completions.create({
    messages,
    model:       'llama-3.3-70b-versatile',
    temperature: 0.7,
    max_tokens:  1000,
  })

  return response.choices[0].message.content
}

module.exports = { analyzeProcurement, chatWithCopilot }
