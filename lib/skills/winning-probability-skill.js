'use strict'
require('dotenv').config()

const groq = require('../ai-router')
const { groundingBlock } = require('./_grounding')

async function analyze(bon, activityResult = {}, profitabilityResult = {}, memory = {}) {
  const winRate    = memory.winRate || 0
  const experience = memory.company?.yearsExperience || 0
  const history    = (memory.projectHistory || []).filter(p => p.status === 'Gagné').length

  const prompt = `Tu es un stratège commercial expert en marchés publics marocains.
Estime la probabilité de remporter ce marché et retourne UNIQUEMENT JSON:
{
  "winProbabilityPercent": 65,
  "confidenceLevel": "Faible|Modérée|Élevée",
  "difficulty": "Facile|Modérée|Difficile|Très difficile",
  "competitionAnalysis": {
    "estimatedCompetitors": number,
    "competitionLevel": "Faible|Modérée|Élevée",
    "ourAdvantages": ["string"],
    "ourWeaknesses": ["string"]
  },
  "pricingStrategy": {
    "approach": "Agressif|Compétitif|Standard|Premium",
    "suggestedDiscountPercent": number,
    "notes": "string"
  },
  "successFactors": ["string"],
  "improvementActions": ["string"],
  "recommendation": "Postuler|Postuler avec caution|Ne pas postuler",
  "recommendationReason": "string"
}


${groundingBlock(bon)}

Projet: ${bon.title}
Acheteur: ${bon.buyer||'—'}
Lieu: ${bon.location}
Budget estimé: ${bon.estimatedAmount||bon.estimatedBudget||'Non précisé'} MAD
Attractivité: ${profitabilityResult.attractivenessScore||5}/10
Risque: ${activityResult.overallRiskScore||5}/10
Notre taux de réussite historique: ${winRate}%
Nos projets gagnés: ${history}
Nos années d'expérience: ${experience}

Réponds UNIQUEMENT avec le JSON valide.`

  try {
    const r = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.3,
      max_tokens: 1500,
    })
    const raw = r.choices[0].message.content.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim()
    const parsed = JSON.parse(raw)
    return {
      ...parsed,
      winProbabilityPercent: Math.min(100, Math.max(0, Number(parsed.winProbabilityPercent) || 50)),
      analyzedAt: new Date().toISOString(),
    }
  } catch {
    return {
      winProbabilityPercent: 50,
      confidenceLevel: 'Faible',
      difficulty: 'Modérée',
      competitionAnalysis: { estimatedCompetitors: 5, competitionLevel: 'Modérée', ourAdvantages: ['Expérience locale'], ourWeaknesses: ['Données insuffisantes'] },
      pricingStrategy: { approach: 'Compétitif', suggestedDiscountPercent: 0, notes: 'Analyser les concurrents locaux' },
      successFactors: ['Qualité technique', 'Respect des délais', 'Prix compétitif'],
      improvementActions: ['Enrichir le dossier technique', 'Compléter les références'],
      recommendation: 'Postuler avec caution',
      recommendationReason: 'Données insuffisantes pour évaluation précise',
      analyzedAt: new Date().toISOString(),
    }
  }
}

module.exports = { analyze }
