'use strict'
require('dotenv').config()

const groq = require('../ai-router')
const { groundingBlock } = require('./_grounding')

async function generate(bon, activityResult = {}, memory = {}) {
  const suppliers = memory.supplierCatalog || []
  const materials = activityResult.materials || []

  const prompt = `Tu es un acheteur industriel marocain expert. Génère une demande de cotation fournisseurs groupée.
Retourne JSON:
{
  "subject": "string",
  "deadline": "string (date réelle basée sur deadline bon - 7 jours)",
  "groups": [
    {
      "category": "aluminium|inox|vitrage|quincaillerie|metal|peinture|fixation|autre",
      "items": [
        {
          "designation": "string",
          "specification": "string (norme, grade, finition)",
          "quantite": "string",
          "unite": "string",
          "remarques": "string"
        }
      ],
      "suggestedSuppliers": ["string"],
      "urgency": "normal|urgent|tres-urgent"
    }
  ],
  "paymentTerms": "string",
  "deliveryRequirements": "string",
  "technicalRequirements": "string"
}


${groundingBlock(bon)}

Projet: ${bon.title}
Lieu livraison: ${bon.location}
Date limite offre: ${bon.deadline}
Matériaux détectés: ${JSON.stringify(materials.slice(0,12))}
Articles bon: ${JSON.stringify((bon.articles||[]).slice(0,10))}
Fournisseurs catalogue: ${JSON.stringify(suppliers.slice(0,8))}

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
    return { ...parsed, generatedAt: new Date().toISOString() }
  } catch {
    return fallback(bon, materials)
  }
}

function fallback(bon, materials) {
  const groups = materials.length
    ? [{ category: 'matériaux', items: materials.slice(0,8).map(m => ({ designation: m.name||m.nom||'', specification: '', quantite: String(m.qty||m.quantite||'1'), unite: m.unit||m.unite||'u', remarques: '' })), suggestedSuppliers: [], urgency: 'normal' }]
    : [{ category: 'divers', items: [{ designation: `Matériaux ${bon.title}`, specification: 'Selon spécifications BC', quantite: '1', unite: 'lot', remarques: '' }], suggestedSuppliers: [], urgency: 'normal' }]
  return {
    subject: `Demande de cotation — ${bon.title}`,
    deadline: bon.deadline || 'À définir',
    groups,
    paymentTerms: 'Paiement à 30 jours fin de mois',
    deliveryRequirements: `Livraison sur site: ${bon.location}`,
    technicalRequirements: 'Selon cahier des charges joint',
    generatedAt: new Date().toISOString(),
  }
}

module.exports = { generate }
