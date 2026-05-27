'use strict'
require('dotenv').config()
const Groq = require('groq-sdk')
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

async function analyze(bon, memory = {}) {
  const catalog  = memory.pricesCatalog?.aluminium || []
  const articles = (bon.articles || []).slice(0, 10)

  const prompt = `Tu es un expert fabricant aluminium marocain (20 ans d'expérience en façades, menuiserie, pergolas, habillage).
Analyse ce bon de commande et réponds UNIQUEMENT en JSON valide:
{
  "projectType": "facade|menuiserie|pergola|garde-corps|habillage|cloison|chassis|autre",
  "profiles": [{"designation":"string","serie":"string","finition":"anodise|laque|naturel","mlEstimate":number}],
  "surfaces": [{"element":"string","surfaceM2":number,"hauteurM":number,"largeurM":number}],
  "vitrage": [{"type":"simple|double|feuillete|reflechissant","epaisseurMm":number,"surfaceM2":number}],
  "accessories": [{"item":"string","qty":number,"unit":"string","description":"string"}],
  "fabrication": {"difficultLvl":3,"specialEquipment":["string"],"fabricationDays":number,"notes":"string"},
  "installation": {"phases":["string"],"teamSize":number,"installDays":number,"liftRequired":false},
  "materials": [{"name":"string","qty":number,"unit":"string","estimatedUnitPrice":number,"total":number}],
  "estimatedWeightKg": number,
  "keyRisks": ["string"],
  "missingInfo": ["string"],
  "technicalNotes": "string"
}

Bon de commande:
- Titre: ${bon.title}
- Description: ${(bon.description||'').substring(0,500)}
- Spécifications: ${(bon.specifications||'').substring(0,400)}
- Lieu: ${bon.location}
- Acheteur: ${bon.buyer||'—'}
- Articles: ${JSON.stringify(articles)}
${catalog.length ? `\nCatalogue prix de référence: ${JSON.stringify(catalog.slice(0,6))}` : ''}

Réponds UNIQUEMENT avec le JSON valide.`

  try {
    const r = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.2,
      max_tokens: 2000,
    })
    const raw = r.choices[0].message.content.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim()
    const parsed = JSON.parse(raw)
    return { ...parsed, skill: 'aluminium', analyzedAt: new Date().toISOString() }
  } catch (e) {
    return fallback(bon)
  }
}

function fallback(bon) {
  return {
    skill: 'aluminium',
    projectType: 'aluminium-general',
    profiles: [],
    surfaces: [],
    vitrage: [],
    accessories: [],
    fabrication: { difficultLvl: 3, specialEquipment: ['Scie à onglet aluminium', 'Plieuse'], fabricationDays: 7, notes: 'Estimation par défaut' },
    installation: { phases: ['Prise de cotes', 'Fabrication atelier', 'Transport', 'Pose', 'Finitions'], teamSize: 3, installDays: 3, liftRequired: false },
    materials: [],
    estimatedWeightKg: 0,
    keyRisks: ['Dimensions non confirmées', 'Accès chantier à vérifier'],
    missingInfo: ['Dimensions précises', 'Plans architecte', 'Type de finition'],
    technicalNotes: 'Analyse manuelle requise — détails insuffisants dans le bon.',
    analyzedAt: new Date().toISOString(),
  }
}

module.exports = { analyze }
