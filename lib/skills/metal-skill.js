'use strict'
require('dotenv').config()
const Groq = require('groq-sdk')
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })
const { groundingBlock } = require('./_grounding')

async function analyze(bon, memory = {}) {
  const catalog  = memory.pricesCatalog?.metal || []
  const articles = (bon.articles || []).slice(0, 10)

  const prompt = `Tu es un expert charpentier métallique marocain (structures, charpentes, abris, escaliers, serrurerie).
Analyse ce bon et réponds UNIQUEMENT en JSON valide:
{
  "projectType": "charpente|structure|abri|escalier|portail|rideau|serrurerie|ferronnerie|autre",
  "steelGrade": "S235|S275|S355|autre",
  "mainSections": [{"designation":"string","profile":"IPE|HEA|UPN|tube|corniere|autre","section":"string","mlEstimate":number,"weightKgPerM":number}],
  "surfaceTreatment": "galvanisation|peinture|zinguage|epoxy|brut",
  "fabrication": {"difficultLvl":3,"cutting":"plasma|oxycoupage|scie","welding":"MIG|MAG|electrode","specialEquipment":["string"],"fabricationDays":number},
  "foundations": {"required":true,"type":"platines|fondations-beton|ancrage","notes":"string"},
  "installation": {"phases":["string"],"teamSize":number,"installDays":number,"cranRequired":false},
  "materials": [{"name":"string","qty":number,"unit":"string","estimatedUnitPrice":number,"total":number}],
  "estimatedWeightKg": number,
  "estimatedAreaM2": number,
  "keyRisks": ["string"],
  "missingInfo": ["string"]
}

${groundingBlock(bon)}

Métadonnées BC:
- Titre: ${bon.title}
- Acheteur: ${bon.buyer||'—'}
- Lieu: ${bon.location}
- Délai: ${bon.deadline||'—'}
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
    return { ...parsed, skill: 'metal', analyzedAt: new Date().toISOString() }
  } catch {
    return {
      skill: 'metal',
      projectType: 'metal-general',
      steelGrade: 'S235',
      mainSections: [],
      surfaceTreatment: 'peinture',
      fabrication: { difficultLvl: 3, cutting: 'plasma', welding: 'MIG', specialEquipment: ['Poste MIG', 'Table de traçage', 'Rouleuse'], fabricationDays: 10 },
      foundations: { required: false, type: 'platines', notes: '' },
      installation: { phases: ['Préparation', 'Levage', 'Assemblage', 'Soudure', 'Traitement surface', 'Finitions'], teamSize: 4, installDays: 5, cranRequired: false },
      materials: [],
      estimatedWeightKg: 0,
      estimatedAreaM2: 0,
      keyRisks: ['Plans de calcul manquants', 'Accès engins à vérifier'],
      missingInfo: ['Plans architecte', 'Calcul de charge', 'Dimensions précises'],
      analyzedAt: new Date().toISOString(),
    }
  }
}

module.exports = { analyze }
