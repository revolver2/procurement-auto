'use strict'
require('dotenv').config()

const groq = require('../ai-router')
const { groundingBlock } = require('./_grounding')

async function analyze(bon, activityResult = {}) {
  const prompt = `Tu es un gestionnaire de risques expert en marchés publics marocains.
Identifie les risques de ce projet et retourne UNIQUEMENT JSON:
{
  "overallRiskLevel": "Faible|Modéré|Élevé|Critique",
  "overallRiskScore": 4,
  "risks": [
    {
      "category": "technique|délai|financier|administratif|concurrence|specification|paiement|execution",
      "description": "string",
      "severity": "Faible|Modéré|Élevé|Critique",
      "probability": "Faible|Modérée|Élevée",
      "mitigation": "string"
    }
  ],
  "specificationIssues": ["string"],
  "deadlineAnalysis": {
    "feasible": true,
    "concerns": ["string"],
    "recommendation": "string"
  },
  "paymentRisk": {
    "level": "Faible|Modéré|Élevé",
    "notes": "string"
  },
  "goNoGo": "GO|CONDITIONAL|NO-GO",
  "goNoGoReason": "string",
  "recommendations": ["string"]
}


${groundingBlock(bon)}

Projet: ${bon.title}
Acheteur: ${bon.buyer||'—'}
Lieu: ${bon.location}
Délai: ${bon.deadline}
Budget: ${bon.estimatedAmount||bon.estimatedBudget||'Non précisé'} MAD
Description: ${(bon.description||'').substring(0,400)}
Spécifications: ${(bon.specifications||'').substring(0,300)}
Articles: ${JSON.stringify((bon.articles||[]).slice(0,6))}
Risques identifiés par analyse activité: ${JSON.stringify(activityResult.keyRisks||[])}
Infos manquantes: ${JSON.stringify(activityResult.missingInfo||[])}

Réponds UNIQUEMENT avec le JSON valide.`

  try {
    const r = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.2,
      max_tokens: 1800,
    })
    const raw = r.choices[0].message.content.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim()
    const parsed = JSON.parse(raw)
    return {
      ...parsed,
      overallRiskScore: Math.min(10, Math.max(1, Number(parsed.overallRiskScore) || 5)),
      analyzedAt: new Date().toISOString(),
    }
  } catch {
    return fallback(bon, activityResult)
  }
}

function fallback(bon, activityResult) {
  const risks = []
  const missingInfo = activityResult.missingInfo || []
  if (missingInfo.length > 2) risks.push({ category:'specification', description:'Spécifications insuffisantes', severity:'Élevé', probability:'Élevée', mitigation:'Demander cahier des charges complet' })
  if (!bon.estimatedAmount && !bon.estimatedBudget) risks.push({ category:'financier', description:'Budget non précisé', severity:'Modéré', probability:'Élevée', mitigation:'Chiffrer avant soumission' })

  return {
    overallRiskLevel: risks.some(r => r.severity === 'Élevé') ? 'Élevé' : 'Modéré',
    overallRiskScore: risks.length > 2 ? 7 : 4,
    risks,
    specificationIssues: missingInfo,
    deadlineAnalysis: { feasible: true, concerns: [], recommendation: 'Vérifier délai de fabrication' },
    paymentRisk: { level: 'Modéré', notes: 'Vérifier historique acheteur' },
    goNoGo: 'CONDITIONAL',
    goNoGoReason: 'Analyse manuelle requise',
    recommendations: ['Demander visite chantier', 'Valider spécifications techniques'],
    analyzedAt: new Date().toISOString(),
  }
}

module.exports = { analyze }
