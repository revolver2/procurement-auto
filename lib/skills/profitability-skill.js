'use strict'
require('dotenv').config()
const Groq = require('groq-sdk')
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

async function analyze(bon, activityResult = {}, memory = {}) {
  const avgMargin   = memory.averageMargin   || 25
  const teamRates   = memory.pricesCatalog?.main_oeuvre || []
  const materials   = activityResult.materials  || []
  const installation= activityResult.installation || {}
  const fabrication = activityResult.fabrication  || {}

  const prompt = `Tu es un directeur financier expert en entreprises de métallerie/aluminium marocaines.
Analyse la rentabilité de ce projet et retourne UNIQUEMENT JSON:
{
  "complexityScore": 5,
  "estimatedMaterialCostMAD": number,
  "estimatedLaborCostMAD": number,
  "estimatedOverheadCostMAD": number,
  "estimatedTotalCostHT": number,
  "recommendedOfferPriceHT": number,
  "estimatedMarginPercent": number,
  "estimatedMarginMAD": number,
  "attractivenessScore": 7,
  "attractivenessLabel": "Très attractif|Attractif|Neutre|Peu attractif|À éviter",
  "breakEvenPoint": "string",
  "competitionLevel": "Faible|Modérée|Élevée|Très élevée",
  "recommendations": ["string"],
  "redFlags": ["string"],
  "opportunityScore": 8
}

Projet: ${bon.title}
Estimation budget acheteur: ${bon.estimatedAmount || bon.estimatedBudget || 'Non précisé'} MAD
Lieu: ${bon.location}
Délai: ${bon.deadline}
Marge historique moyenne entreprise: ${avgMargin}%
Durée fabrication estimée: ${fabrication.fabricationDays || '?'} jours
Taille équipe: ${installation.teamSize || '?'} personnes
Durée installation: ${installation.installDays || '?'} jours
Matériaux détectés: ${JSON.stringify(materials.slice(0,5))}

Réponds UNIQUEMENT avec le JSON valide.`

  try {
    const r = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.25,
      max_tokens: 1500,
    })
    const raw = r.choices[0].message.content.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim()
    const parsed = JSON.parse(raw)
    return {
      ...parsed,
      complexityScore:    Math.min(10, Math.max(1, Number(parsed.complexityScore)   || 5)),
      attractivenessScore:Math.min(10, Math.max(1, Number(parsed.attractivenessScore)|| 5)),
      opportunityScore:   Math.min(10, Math.max(1, Number(parsed.opportunityScore)  || 5)),
      analyzedAt: new Date().toISOString(),
    }
  } catch {
    return fallback(bon, avgMargin)
  }
}

function fallback(bon, avgMargin) {
  const budgetStr = (bon.estimatedAmount || bon.estimatedBudget || '0').replace(/[^\d.]/g, '')
  const budget    = parseFloat(budgetStr) || 0
  const estCost   = budget > 0 ? budget * (1 - avgMargin / 100) : 0
  return {
    complexityScore: 5,
    estimatedMaterialCostMAD: Math.round(estCost * 0.6),
    estimatedLaborCostMAD:    Math.round(estCost * 0.3),
    estimatedOverheadCostMAD: Math.round(estCost * 0.1),
    estimatedTotalCostHT:     Math.round(estCost),
    recommendedOfferPriceHT:  budget || 0,
    estimatedMarginPercent:   avgMargin,
    estimatedMarginMAD:       Math.round(budget * avgMargin / 100),
    attractivenessScore:      5,
    attractivenessLabel:      'Neutre',
    breakEvenPoint:           'Non calculé',
    competitionLevel:         'Modérée',
    recommendations:          ['Demander budget précis', 'Analyser concurrence locale'],
    redFlags:                 budget === 0 ? ['Budget non précisé'] : [],
    opportunityScore:         5,
    analyzedAt:               new Date().toISOString(),
  }
}

module.exports = { analyze }
