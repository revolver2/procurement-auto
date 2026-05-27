'use strict'
require('dotenv').config()
const Groq = require('groq-sdk')

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

async function callAI(prompt) {
  const response = await groq.chat.completions.create({
    messages: [
      {
        role: 'system',
        content: `Tu es un expert en marchés publics marocains. Génère des documents professionnels en français.
Réponds UNIQUEMENT en JSON valide sans texte autour. Pas de markdown, pas de commentaires.`,
      },
      { role: 'user', content: prompt },
    ],
    model: 'llama-3.3-70b-versatile',
    temperature: 0.2,
    max_tokens: 3000,
  })
  return response.choices[0].message.content
    .replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
}

function parseJSON(raw, fallback) {
  try { return JSON.parse(raw) } catch { return fallback }
}

/* ── Prompt builders ─────────────────────────────────────────── */

function generateBordereauPrompt(bon) {
  const items = bon.articles?.length ? JSON.stringify(bon.articles, null, 2)
    : '[{"designation":"À compléter","unite":"U","quantite":1,"prixUnitaireHT":0,"montantHT":0}]'
  return `Génère un bordereau de prix pour ce marché public.
Retourne un JSON array: [{"num":number,"designation":"string","unite":"string","quantite":number,"prixUnitaireHT":number,"montantHT":number,"notes":"string"}]

Projet: ${bon.title}
Articles existants: ${items}
Estimation totale: ${bon.estimatedBudget || 'N/A'} MAD`
}

function generateDevisPrompt(bon, analysis) {
  return `Génère un devis commercial complet pour ce projet.
Retourne JSON: {
  "reference":"string","date":"string","client":"string","validite":"string",
  "items":[{"designation":"string","unite":"string","quantite":number,"prixUnitaire":number,"total":number}],
  "totalHT":number,"tva":number,"totalTTC":number,
  "conditions":"string","notes":"string"
}

Projet: ${bon.title}
Client: ${bon.buyer}
Analyse: ${analysis ? JSON.stringify({ complexity: analysis.complexity, roles: analysis.roles, laborCostEstimate: analysis.laborCostEstimate }) : 'N/A'}
Articles: ${JSON.stringify(bon.articles?.slice(0, 8))}`
}

function generateRFQPrompt(bon) {
  return `Génère une demande de cotation (RFQ) pour ce projet.
Retourne JSON: {
  "subject":"string",
  "suppliers":[{"category":"string","items":[{"designation":"string","specification":"string","quantite":"string","unite":"string"}],"notes":"string"}],
  "deadline":"string","paymentTerms":"string","deliveryRequirements":"string"
}

Projet: ${bon.title}
Description: ${bon.description || ''}
Articles: ${JSON.stringify(bon.articles?.slice(0, 10))}`
}

function generatePlanPrompt(bon, analysis) {
  return `Génère un plan d'exécution pour ce chantier.
Retourne JSON: {
  "phases":[{"phase":number,"name":"string","description":"string","duration":"string","dependencies":["string"],"resources":["string"]}],
  "totalDuration":"string","milestones":["string"],"risks":["string"]
}

Projet: ${bon.title}
Lieu: ${bon.location}
Durée estimée: ${analysis?.durationDays || 15} jours
Équipe: ${JSON.stringify(analysis?.roles || [])}`
}

function generateChecklistPrompt(bon) {
  return `Génère une checklist de soumission complète pour ce marché public.
Retourne JSON: {
  "submission":["string"],
  "technical":["string"],
  "administrative":["string"],
  "financial":["string"],
  "deadline":"${bon.deadline || 'À vérifier'}",
  "caution":"${bon.caution || 'À vérifier'}"
}

Projet: ${bon.title}
Description: ${bon.description || ''}`
}

/* ── Fallbacks ─────────────────────────────────────────────────── */

function fallbackBordereau(bon) {
  if (bon.articles?.length) {
    return bon.articles.map((a, i) => ({
      num: i + 1,
      designation: a.designation || a.name || 'Article',
      unite: a.unite || 'U',
      quantite: a.quantite || 1,
      prixUnitaireHT: a.prixUnitaireHT || 0,
      montantHT: a.montantHT || 0,
      notes: '',
    }))
  }
  return [{ num: 1, designation: 'Travaux — ' + bon.title, unite: 'Forfait', quantite: 1, prixUnitaireHT: 0, montantHT: 0, notes: '' }]
}

function fallbackDevis(bon) {
  const totalHT = bon.totalHT || 0
  return {
    reference: `DEV-${bon.id?.substring(0,8).toUpperCase() || 'XXXX'}`,
    date: new Date().toISOString().split('T')[0],
    client: bon.buyer,
    validite: '30 jours',
    items: bon.articles?.map(a => ({
      designation: a.designation, unite: a.unite, quantite: a.quantite,
      prixUnitaire: a.prixUnitaireHT, total: a.montantHT
    })) || [],
    totalHT,
    tva: totalHT * 0.20,
    totalTTC: totalHT * 1.20,
    conditions: 'Paiement à 30 jours.',
    notes: '',
  }
}

function fallbackPlan(analysis) {
  const d = analysis?.durationDays || 15
  return {
    phases: [
      { phase: 1, name: 'Préparation',  description: 'Commande matériaux, planification',           duration: '3 jours',              dependencies: [],              resources: ['Responsable'] },
      { phase: 2, name: 'Exécution',    description: 'Travaux principaux',                            duration: `${Math.round(d*0.6)} jours`, dependencies: ['Préparation'],  resources: analysis?.roles || ['Équipe'] },
      { phase: 3, name: 'Finitions',    description: 'Finitions et contrôle qualité',                  duration: `${Math.round(d*0.2)} jours`, dependencies: ['Exécution'],   resources: analysis?.roles || ['Équipe'] },
      { phase: 4, name: 'Réception',    description: 'PV de réception, livraison',                    duration: '1 jour',               dependencies: ['Finitions'],   resources: ['Chef de chantier'] },
    ],
    totalDuration: `${d} jours`,
    milestones: ['Démarrage travaux', 'Mi-parcours', 'Réception provisoire'],
    risks: analysis?.risks || ['À évaluer'],
  }
}

function fallbackChecklist(bon) {
  return {
    submission: [
      "☐ Acte d'engagement signé et cacheté",
      '☐ Bordereau des prix unitaires complété',
      '☐ Devis détaillé',
      `☐ Dossier déposé avant: ${bon.deadline || 'Date limite'}`,
    ],
    technical: ['☐ Note méthodologique', '☐ Planning d\'exécution', '☐ Fiches techniques'],
    administrative: ['☐ RC, patente, attestations fiscales', '☐ Attestation CNSS', '☐ Attestation ICE'],
    financial: [`☐ Caution provisoire: ${bon.caution || 'À vérifier'}`],
    deadline: bon.deadline || 'À vérifier',
    caution: bon.caution || 'À vérifier',
  }
}

function fallbackRFQ(bon) {
  return {
    subject: `Demande de cotation — ${bon.title}`,
    suppliers: bon.articles?.length
      ? [{ category: 'Fournitures', items: bon.articles.map(a => ({ designation: a.designation, specification: '', quantite: String(a.quantite), unite: a.unite })), notes: '' }]
      : [{ category: 'À définir', items: [], notes: '' }],
    deadline: bon.deadline || 'Urgent',
    paymentTerms: 'À définir',
    deliveryRequirements: `Livraison sur site: ${bon.location}`,
  }
}

/* ── Checklist normalizer ────────────────────────────────────── */

function toArr(v) {
  if (Array.isArray(v)) return v.map(x => String(x)).filter(Boolean)
  if (!v) return []
  if (typeof v === 'string') return v.trim() ? [v] : []
  if (typeof v === 'object') return Object.values(v).map(x => String(x)).filter(Boolean)
  return [String(v)]
}

function normalizeChecklist(data, bon) {
  if (!data || typeof data !== 'object') return fallbackChecklist(bon)
  return {
    submission:     toArr(data.submission),
    technical:      toArr(data.technical),
    administrative: toArr(data.administrative),
    financial:      toArr(data.financial),
    deadline:       typeof data.deadline === 'string' ? data.deadline : (bon.deadline || 'À vérifier'),
    caution:        typeof data.caution  === 'string' ? data.caution  : (bon.caution  || 'À vérifier'),
  }
}

/* ── Main generate function ──────────────────────────────────── */

/**
 * Generate different document types
 */
async function generate(bon, analysis, documentType) {
  const prompts = {
    bordereau: generateBordereauPrompt(bon),
    devis:     generateDevisPrompt(bon, analysis),
    rfq:       generateRFQPrompt(bon),
    plan:      generatePlanPrompt(bon, analysis),
    checklist: generateChecklistPrompt(bon),
  }

  const fallbacks = {
    bordereau: () => fallbackBordereau(bon),
    devis:     () => fallbackDevis(bon),
    rfq:       () => fallbackRFQ(bon),
    plan:      () => fallbackPlan(analysis),
    checklist: () => fallbackChecklist(bon),
  }

  const prompt = prompts[documentType]
  if (!prompt) throw new Error(`Unknown document type: ${documentType}`)

  let data
  try {
    const raw = await callAI(prompt)
    data = parseJSON(raw, null)
    if (!data) data = fallbacks[documentType]()
    if (documentType === 'checklist') data = normalizeChecklist(data, bon)
  } catch (err) {
    console.error(`[DocGen] AI error for ${documentType}:`, err.message)
    data = fallbacks[documentType]()
  }

  return {
    type:        documentType,
    data,
    generatedAt: new Date().toISOString(),
  }
}

/**
 * Generate all documents at once
 */
async function generateAll(bon, analysis) {
  const types = ['bordereau', 'devis', 'rfq', 'plan', 'checklist']
  const results = {}
  for (const type of types) {
    try { results[type] = (await generate(bon, analysis, type)).data }
    catch (e) { console.error(`[DocGen] ${type} failed:`, e.message) }
  }
  return results
}

module.exports = { generate, generateAll }
