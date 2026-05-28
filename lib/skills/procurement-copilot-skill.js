'use strict'
require('dotenv').config()
const Groq = require('groq-sdk')
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

async function chat(message, bon = null, skillResults = {}, conversationHistory = [], memory = {}) {
  const context = buildContext(bon, skillResults, memory)

  const messages = [
    {
      role: 'system',
      content: `Tu es le Copilote IA d'un entrepreneur marocain spécialisé en aluminium, inox et métallerie.
Tu as accès à tous les détails du projet actuel et aux résultats d'analyse des compétences IA.
Réponds en français, de manière précise et actionnable.
Tu peux: analyser des spécifications, estimer des coûts, générer des listes de matériaux, expliquer les risques, suggérer des stratégies d'offre.

${context}`,
    },
    ...conversationHistory.slice(-10),
    { role: 'user', content: message },
  ]

  try {
    const r = await groq.chat.completions.create({
      messages,
      model: 'llama-3.3-70b-versatile',
      temperature: 0.65,
      max_tokens: 1200,
    })
    return { reply: r.choices[0].message.content, success: true }
  } catch (e) {
    return { reply: `Erreur IA: ${e.message}`, success: false }
  }
}

function buildContext(bon, skillResults, memory) {
  const parts = []

  if (bon?.officialText) {
    parts.push(`=== TEXTE OFFICIEL DE L'AVIS (SOURCE PRINCIPALE) ===`)
    parts.push(`Document: ${bon.officialTextName || 'AVIS joint officiel'}`)
    parts.push(bon.officialText.substring(0, 3000))
    parts.push(`=== FIN TEXTE OFFICIEL ===`)
    parts.push(`RÈGLE: Base-toi prioritairement sur ce texte. Pour toute information absente, écris "Non précisé dans l'avis joint."`)
  } else if (bon) {
    parts.push(`⚠️ AVIS joint non disponible — analyse sur métadonnées uniquement.`)
  }

  if (bon) {
    parts.push(`\n=== PROJET ACTIF ===`)
    parts.push(`Titre: ${bon.title}`)
    parts.push(`Acheteur: ${bon.buyer||'—'}`)
    parts.push(`Lieu: ${bon.location||'—'}`)
    parts.push(`Délai: ${bon.deadline||'—'}`)
    parts.push(`Budget: ${bon.estimatedAmount||bon.estimatedBudget||'Non précisé'} MAD`)
    parts.push(`Description: ${(bon.description||'').substring(0,300)}`)
    if (bon.specifications) parts.push(`Spécifications: ${bon.specifications.substring(0,300)}`)
    if (bon.articles?.length) parts.push(`Articles: ${JSON.stringify(bon.articles.slice(0,5))}`)
  }

  if (skillResults.detection) {
    parts.push(`\n=== DÉTECTION ===`)
    parts.push(`Activité: ${skillResults.detection.primaryLabel||'—'}`)
    parts.push(`Urgence: ${skillResults.detection.urgencyLevel} (${skillResults.detection.urgencyDays||'?'} jours)`)
    parts.push(`Pertinence: ${skillResults.detection.relevanceScore||0}/100`)
  }

  if (skillResults.profitability) {
    const p = skillResults.profitability
    parts.push(`\n=== RENTABILITÉ ===`)
    parts.push(`Marge estimée: ${p.estimatedMarginPercent||'?'}%`)
    parts.push(`Attractivité: ${p.attractivenessScore||'?'}/10 — ${p.attractivenessLabel||''}`)
    if (p.redFlags?.length) parts.push(`Alertes: ${p.redFlags.join(', ')}`)
  }

  if (skillResults.risk) {
    const r = skillResults.risk
    parts.push(`\n=== RISQUES ===`)
    parts.push(`Niveau: ${r.overallRiskLevel||'—'} (${r.overallRiskScore||'?'}/10)`)
    parts.push(`Go/No-Go: ${r.goNoGo||'—'}`)
    if (r.risks?.length) parts.push(`Top risques: ${r.risks.slice(0,2).map(x=>x.description).join('; ')}`)
  }

  if (skillResults.winProbability) {
    const w = skillResults.winProbability
    parts.push(`\n=== PROBABILITÉ SUCCÈS ===`)
    parts.push(`Probabilité: ${w.winProbabilityPercent||'?'}%`)
    parts.push(`Recommandation: ${w.recommendation||'—'}`)
  }

  if (skillResults.activity) {
    const a = skillResults.activity
    parts.push(`\n=== ANALYSE TECHNIQUE ===`)
    if (a.materials?.length) parts.push(`Matériaux: ${a.materials.slice(0,4).map(m=>m.name||m.nom||'').join(', ')}`)
    if (a.keyRisks?.length)  parts.push(`Risques techniques: ${a.keyRisks.slice(0,3).join('; ')}`)
    if (a.missingInfo?.length) parts.push(`Infos manquantes: ${a.missingInfo.slice(0,3).join('; ')}`)
  }

  if (memory.company?.name) {
    parts.push(`\n=== PROFIL ENTREPRISE ===`)
    parts.push(`Activités: ${(memory.company.activities||[]).join(', ')}`)
    parts.push(`Marge habituelle: ${memory.averageMargin||25}%`)
  }

  return parts.join('\n')
}

module.exports = { chat }
