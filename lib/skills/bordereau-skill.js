'use strict'
require('dotenv').config()
const Groq = require('groq-sdk')
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })
const { groundingBlock } = require('./_grounding')

async function generate(bon, activityResult = {}, memory = {}) {
  const catalog   = buildCatalogContext(memory)
  const articles  = (bon.articles || []).slice(0, 12)
  const materials = activityResult.materials || []

  const prompt = `Tu es un expert en marchés publics marocains. Génère un Bordereau de Prix professionnel.
Retourne UN tableau JSON (array):
[
  {
    "num": 1,
    "designation": "string (description précise)",
    "unite": "m2|ml|u|kg|forfait|h",
    "quantite": number,
    "prixUnitaireHT": number,
    "montantHT": number,
    "tva": 20,
    "montantTTC": number,
    "notes": "string"
  }
]

Règles:
- Utilise les prix du catalogue si disponible
- Ajoute pose/installation séparément si applicable
- Inclus protections/nettoyage/divers en ligne finale
- Prix en MAD réalistes pour le marché marocain


${groundingBlock(bon)}

Projet: ${bon.title}
Lieu: ${bon.location}
Acheteur: ${bon.buyer}
Articles du bon: ${JSON.stringify(articles)}
Matériaux détectés: ${JSON.stringify(materials.slice(0,8))}
Catalogue prix: ${catalog}

Réponds UNIQUEMENT avec le tableau JSON.`

  try {
    const r = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.15,
      max_tokens: 2500,
    })
    const raw  = r.choices[0].message.content.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim()
    const data = JSON.parse(raw)
    const lines = Array.isArray(data) ? data : (data.items || data.lines || [])
    const enriched = lines.map((l, i) => ({
      num:            l.num           || i + 1,
      designation:    l.designation   || '',
      unite:          l.unite         || 'u',
      quantite:       Number(l.quantite)      || 1,
      prixUnitaireHT: Number(l.prixUnitaireHT)|| 0,
      montantHT:      Number(l.montantHT)     || Number(l.prixUnitaireHT || 0) * Number(l.quantite || 1),
      tva:            20,
      montantTTC:     (Number(l.montantHT) || Number(l.prixUnitaireHT || 0) * Number(l.quantite || 1)) * 1.20,
      notes:          l.notes || '',
    }))
    const totalHT  = enriched.reduce((s, l) => s + l.montantHT, 0)
    const totalTTC = totalHT * 1.20
    return { lines: enriched, totalHT, tva: totalHT * 0.20, totalTTC, generatedAt: new Date().toISOString() }
  } catch {
    return fallback(bon, articles)
  }
}

function buildCatalogContext(memory) {
  const all = []
  for (const [cat, items] of Object.entries(memory.pricesCatalog || {})) {
    if (Array.isArray(items)) {
      items.slice(0, 4).forEach(i => all.push(`[${cat}] ${i.designation}: ${i.unitPrice} MAD/${i.unit}`))
    }
  }
  return all.slice(0, 15).join('\n') || 'Non disponible'
}

function fallback(bon, articles) {
  const lines = articles.length
    ? articles.map((a, i) => ({
        num: i + 1, designation: a.designation || `Article ${i+1}`,
        unite: a.unite || 'u', quantite: a.quantite || 1,
        prixUnitaireHT: 0, montantHT: 0, tva: 20, montantTTC: 0, notes: 'Prix à compléter',
      }))
    : [{ num: 1, designation: `Travaux — ${bon.title}`, unite: 'Forfait', quantite: 1, prixUnitaireHT: 0, montantHT: 0, tva: 20, montantTTC: 0, notes: '' }]
  return { lines, totalHT: 0, tva: 0, totalTTC: 0, generatedAt: new Date().toISOString() }
}

module.exports = { generate }
