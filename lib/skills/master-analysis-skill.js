'use strict'
const groq = require('../ai-router')

async function analyze(bon) {
  const avisText = bon.officialText || ''
  const hasAvis  = avisText.length >= 50

  const contextBlock = hasAvis
    ? `TEXTE OFFICIEL DE L'AVIS (source primaire — extraire toutes les informations de CE texte):\n${avisText.substring(0, 8000)}`
    : `MÉTADONNÉES UNIQUEMENT (AVIS PDF non disponible — analyser sur la base du titre et description):\n- Titre: ${bon.title}\n- Acheteur: ${bon.buyer||'N/A'}\n- Lieu: ${bon.location||'N/A'}\n- Description: ${(bon.description||'').substring(0, 500)}`

  const prompt = `Tu es un ingénieur senior en marchés publics marocains (15 ans d'expérience: aluminium, inox, métallerie, façades, charpente métallique, serrurerie, vitrerie).

Analyse ce bon de commande et génère un dossier complet d'ingénierie appel d'offres.
Réponds UNIQUEMENT avec un JSON valide correspondant exactement à ce schéma (sans markdown, sans texte avant/après):

{
  "executive": {
    "projectTitle": "string",
    "buyer": "string",
    "city": "string",
    "deadline": "string",
    "scopeOfWork": "string — 2-3 phrases résumant les travaux",
    "estimatedComplexity": "Faible|Moyenne|Élevée|Très élevée",
    "bidRecommendation": "Fortement recommandé|Recommandé|Neutre|Non recommandé",
    "profitabilityScore": 75,
    "urgencyScore": 60,
    "winningProbability": "Élevée|Modérée|Faible"
  },
  "materials": [
    { "category": "Aluminium|Inox|Vitrage|Quincaillerie|Serrurerie|Charpente métallique|Panneaux sandwich|Fixation|Peinture|Main d'œuvre|Autres", "designation": "string", "specification": "string", "quantity": "string", "unit": "string", "confidence": "Élevée|Moyenne|Faible" }
  ],
  "certifications": {
    "required": ["string — exactement ce qui est mentionné dans l'AVIS"],
    "optional": ["string"],
    "notMentioned": ["Attestation fiscale","CNSS","Assurance","Method statement"]
  },
  "complianceChecklist": [
    { "item": "string", "category": "admin|technique|commercial|submission" }
  ],
  "supplierRFQ": [
    { "category": "string", "items": [{ "designation": "string", "specification": "string", "quantity": "string", "unit": "string", "supplierType": "string" }] }
  ],
  "bordereau": [
    { "num": 1, "designation": "string", "unit": "string", "quantity": "string", "notes": "string" }
  ],
  "executionPlan": [
    { "phase": "Préparation|Approvisionnement|Fabrication|Livraison|Installation|Tests|Réception", "duration": "string", "tasks": ["string"] }
  ],
  "manpower": [
    { "role": "string", "count": 1, "duration": "string", "notes": "string" }
  ],
  "equipment": [
    { "item": "string", "quantity": 1, "location": "Atelier|Chantier", "notes": "string" }
  ],
  "risks": [
    { "type": "missing_quantities|deadline_risk|technical_risk|ambiguous_spec|commercial_risk", "description": "string", "severity": "Faible|Moyenne|Élevée" }
  ],
  "winningStrategy": {
    "strengths": ["string"],
    "technicalPoints": ["string"],
    "commercialRecommendations": ["string"],
    "riskMitigation": ["string"]
  },
  "actionPlan": [
    { "step": 1, "action": "string", "deadline": "string", "owner": "string" }
  ],
  "summary": "string — résumé exécutif 2-3 phrases"
}

${contextBlock}

Métadonnées BC:
- Titre: ${bon.title || 'N/A'}
- Acheteur: ${bon.buyer || 'N/A'}
- Lieu: ${bon.location || 'N/A'}
- Délai: ${bon.deadline || 'N/A'}
- Budget estimé: ${bon.estimatedAmount || bon.estimatedBudget || 'Non précisé'} MAD
- Catégorie: ${bon.activityMatched || bon.category || 'N/A'}

RÈGLES STRICTES:
- Extraire UNIQUEMENT les informations présentes dans l'AVIS (ne pas inventer les quantités/dimensions non mentionnées)
- Pour materials: lister CHAQUE matériau ou fourniture mentionné ou clairement impliqué
- Pour certifications.required: extraire exactement les documents demandés dans l'AVIS
- Pour bordereau: une ligne par prestation/fourniture distincte listée dans l'AVIS
- profitabilityScore 0-100 (100 = très rentable pour une entreprise de métallerie)
- urgencyScore 0-100 (100 = délai très court, très urgent)
- Si une information est absente dans l'AVIS, signaler dans risks avec type "missing_quantities" ou "ambiguous_spec"
- Répondre UNIQUEMENT avec le JSON valide, sans markdown ni commentaires`

  try {
    const r = await groq.chat.completions.create({
      messages:    [{ role: 'user', content: prompt }],
      temperature: 0.15,
      max_tokens:  8000,
    })
    const raw = r.choices[0].message.content.trim()
    const jsonStart = raw.indexOf('{')
    const jsonEnd   = raw.lastIndexOf('}')
    if (jsonStart < 0 || jsonEnd <= jsonStart) throw new Error('No JSON found in response')
    const parsed = JSON.parse(raw.substring(jsonStart, jsonEnd + 1))

    if (parsed.executive) {
      parsed.executive.profitabilityScore = clamp(Number(parsed.executive.profitabilityScore) || 50)
      parsed.executive.urgencyScore       = clamp(Number(parsed.executive.urgencyScore)       || 50)
    }

    return { ...parsed, analysisVersion: 'v2-procurement-engineer', analyzedAt: new Date().toISOString(), skill: 'master', _hasAvis: hasAvis }
  } catch (e) {
    console.warn('[MasterSkill] AI failed, using fallback:', e.message)
    return fallback(bon, e.message)
  }
}

function clamp(n) { return Math.min(100, Math.max(0, n)) }

function fallback(bon, errorMsg) {
  return {
    analysisVersion: 'v2-procurement-engineer',
    executive: {
      projectTitle:        bon.title || '—',
      buyer:               bon.buyer || '—',
      city:                bon.location || '—',
      deadline:            bon.deadline || '—',
      scopeOfWork:         bon.description || 'Description non disponible',
      estimatedComplexity: 'Moyenne',
      bidRecommendation:   'Neutre',
      profitabilityScore:  50,
      urgencyScore:        50,
      winningProbability:  'Modérée',
    },
    materials:          [],
    certifications:     { required: [], optional: [], notMentioned: ['Attestation fiscale', 'CNSS', 'Registre de commerce', 'Assurance', 'Caution provisoire'] },
    complianceChecklist:[
      { item: 'Documents administratifs (RC, patente, CNSS, attestation fiscale)', category: 'admin' },
      { item: 'Dossier technique (références, qualification)', category: 'technique' },
      { item: 'Bordereau des prix complété et signé', category: 'commercial' },
      { item: 'Caution provisoire bancaire', category: 'submission' },
      { item: 'Dossier soumis avant la date limite', category: 'submission' },
    ],
    supplierRFQ:  [],
    bordereau:    [],
    executionPlan:[
      { phase: 'Préparation',      duration: '1 semaine',  tasks: ['Visite de chantier', 'Validation des plans', 'Prise de cotes'] },
      { phase: 'Approvisionnement',duration: '2 semaines', tasks: ['Commande matériaux', 'Demandes de prix fournisseurs'] },
      { phase: 'Fabrication',      duration: '2-3 semaines',tasks: ['Fabrication atelier', 'Contrôle qualité', 'Préparation livraison'] },
      { phase: 'Installation',     duration: '1-2 semaines',tasks: ['Transport chantier', 'Pose et fixation', 'Finitions'] },
      { phase: 'Réception',        duration: '3 jours',    tasks: ['Inspection et tests', 'Levée de réserves', 'PV de réception'] },
    ],
    manpower:[
      { role: 'Chef de projet',          count: 1, duration: 'Durée projet',         notes: '' },
      { role: 'Chef de chantier',        count: 1, duration: 'Phase installation',   notes: '' },
      { role: 'Menuisiers aluminium',    count: 3, duration: 'Fabrication + pose',   notes: '' },
      { role: 'Manœuvres',               count: 2, duration: 'Phase installation',   notes: '' },
    ],
    equipment:[
      { item: 'Scie à onglet aluminium', quantity: 1, location: 'Atelier',  notes: '' },
      { item: 'Poste à souder TIG',      quantity: 1, location: 'Atelier',  notes: '' },
      { item: 'Perceuse/taraudeuse',     quantity: 2, location: 'Atelier',  notes: '' },
      { item: 'Véhicule de transport',   quantity: 1, location: 'Chantier', notes: '' },
      { item: 'Outillage de pose',       quantity: 1, location: 'Chantier', notes: '' },
    ],
    risks:[
      { type: 'missing_quantities',description: 'Quantités et dimensions non précisées — visite de chantier obligatoire', severity: 'Élevée' },
      { type: 'technical_risk',    description: errorMsg ? `Analyse IA échouée: ${errorMsg.substring(0,100)}` : 'AVIS officiel non disponible — analyse sur métadonnées uniquement', severity: 'Élevée' },
    ],
    winningStrategy:{
      strengths:                   ['Expérience technique en aluminium et métallerie', 'Capacité de fabrication atelier propre'],
      technicalPoints:             ['Certifications qualité et références similaires', 'Délai maîtrisé grâce à atelier intégré'],
      commercialRecommendations:   ['Prix compétitif avec marge suffisante (≥20%)', 'Caution bancaire prête à mobiliser'],
      riskMitigation:              ['Visite de chantier avant soumission', 'Demander plans et métrés complets'],
    },
    actionPlan:[
      { step: 1, action: 'Télécharger et lire l\'AVIS complet',             deadline: 'Immédiat',   owner: 'Admin' },
      { step: 2, action: 'Valider les documents administratifs en cours',    deadline: 'J+1',        owner: 'Admin' },
      { step: 3, action: 'Demander prix fournisseurs (aluminium, vitrage)',  deadline: 'J+2',        owner: 'Commercial' },
      { step: 4, action: 'Compléter le bordereau des prix',                  deadline: 'J+5',        owner: 'Technique' },
      { step: 5, action: 'Vérifier et assembler le dossier de soumission',  deadline: 'J+7',        owner: 'Admin' },
      { step: 6, action: 'Soumettre avant la date limite',                   deadline: bon.deadline || '—', owner: 'Direction' },
    ],
    summary:  `Bon de commande: ${bon.title || '—'}. Analyse de base générée${errorMsg ? ' (erreur IA)' : ' sur métadonnées'} — lancer un Re-analyser après validation de l'AVIS PDF.`,
    analyzedAt: new Date().toISOString(),
    skill:      'master-fallback',
    _hasAvis:   false,
    _error:     errorMsg,
  }
}

module.exports = { analyze }
