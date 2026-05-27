'use strict'
require('dotenv').config()
const Groq = require('groq-sdk')
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

async function analyze(bon, memory = {}) {
  const catalog  = memory.pricesCatalog?.inox || []
  const articles = (bon.articles || []).slice(0, 10)

  const prompt = `Tu es un expert fabricant inox marocain spécialisé en garde-corps, main courante, escaliers et structures AISI 304/316.
Analyse ce bon et réponds UNIQUEMENT en JSON valide:
{
  "projectType": "garde-corps|main-courante|escalier|structure|grille|bardage|autre",
  "grade": "304|316|autre",
  "finish": "brosse|poli-miroir|satiné|brut",
  "structure": [{"element":"string","profile":"string","mlEstimate":number,"epaisseurMm":number}],
  "welding": {"type":"TIG|MIG|mixte","joints":number,"postWeldTreatment":"decapage|passivation|polissage"},
  "fixings": [{"type":"string","qty":number,"notes":"string"}],
  "materials": [{"name":"string","qty":number,"unit":"string","gradeInox":"304|316","estimatedUnitPrice":number,"total":number}],
  "fabrication": {"difficultLvl":3,"specialEquipment":["string"],"fabricationDays":number},
  "installation": {"phases":["string"],"teamSize":number,"installDays":number},
  "estimatedWeightKg": number,
  "keyRisks": ["string"],
  "missingInfo": ["string"]
}

Bon de commande:
- Titre: ${bon.title}
- Description: ${(bon.description||'').substring(0,500)}
- Spécifications: ${(bon.specifications||'').substring(0,400)}
- Lieu: ${bon.location}
- Articles: ${JSON.stringify(articles)}
${catalog.length ? `\nCatalogue prix: ${JSON.stringify(catalog.slice(0,5))}` : ''}

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
    return { ...parsed, skill: 'inox', analyzedAt: new Date().toISOString() }
  } catch {
    return {
      skill: 'inox',
      projectType: 'inox-general',
      grade: '304',
      finish: 'brosse',
      structure: [],
      welding: { type: 'TIG', joints: 0, postWeldTreatment: 'passivation' },
      fixings: [],
      materials: [],
      fabrication: { difficultLvl: 3, specialEquipment: ['Poste TIG', 'Meuleuse orbitale'], fabricationDays: 5 },
      installation: { phases: ['Prise de cotes', 'Fabrication', 'Polissage', 'Pose', 'Protection'], teamSize: 2, installDays: 2 },
      estimatedWeightKg: 0,
      keyRisks: ['Dimensions manquantes', 'Grade inox non précisé'],
      missingInfo: ['Plans détaillés', 'Hauteur garde-corps', 'Espacement barreau'],
      analyzedAt: new Date().toISOString(),
    }
  }
}

module.exports = { analyze }
