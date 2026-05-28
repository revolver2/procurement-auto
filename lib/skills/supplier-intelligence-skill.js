'use strict'
require('dotenv').config()

const groq = require('../ai-router')

async function analyze(bon, activityResult = {}, memory = {}) {
  const catalogSuppliers = memory.supplierCatalog || []
  const materials        = activityResult.materials || []

  const prompt = `Tu es un acheteur expert connaissant le marché des fournisseurs marocains en aluminium, inox, acier.
Génère une intelligence fournisseurs pour ce projet et retourne UNIQUEMENT JSON:
{
  "categories": [
    {
      "category": "string",
      "priority": "Critique|Important|Standard",
      "suggestedSuppliers": [
        {
          "name": "string",
          "location": "string",
          "specialty": "string",
          "leadTimeDays": number,
          "priceLevel": "Économique|Moyen|Premium",
          "notes": "string"
        }
      ],
      "alternativeOptions": ["string"],
      "procurementAdvice": "string"
    }
  ],
  "criticalItems": ["string"],
  "longLeadItems": [{"item":"string","leadTimeDays":number,"orderBy":"string"}],
  "totalSupplierCount": number,
  "procurementStrategy": "string"
}

Projet: ${bon.title}
Activité: ${activityResult.skill||'général'}
Lieu: ${bon.location}
Matériaux requis: ${JSON.stringify(materials.slice(0,10))}
Fournisseurs catalogue entreprise: ${JSON.stringify(catalogSuppliers)}

Réponds UNIQUEMENT avec le JSON valide.`

  try {
    const r = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.3,
      max_tokens: 1800,
    })
    const raw = r.choices[0].message.content.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim()
    const parsed = JSON.parse(raw)
    return { ...parsed, analyzedAt: new Date().toISOString() }
  } catch {
    return {
      categories: catalogSuppliers.length
        ? [{ category: 'Général', priority: 'Important', suggestedSuppliers: catalogSuppliers.slice(0,3).map(s => ({ name: s.name, location: s.city||'—', specialty: s.activity, leadTimeDays: 5, priceLevel: 'Moyen', notes: '' })), alternativeOptions: [], procurementAdvice: 'Contacter fournisseurs catalogue' }]
        : [],
      criticalItems: materials.slice(0,3).map(m => m.name||m.nom||''),
      longLeadItems: [],
      totalSupplierCount: catalogSuppliers.length,
      procurementStrategy: 'Lancer RFQ immédiatement pour sécuriser les prix',
      analyzedAt: new Date().toISOString(),
    }
  }
}

module.exports = { analyze }
