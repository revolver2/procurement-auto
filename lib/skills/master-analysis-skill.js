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
    { "category": "Aluminium|Inox|Vitrage|Quincaillerie|Serrurerie|Charpente métallique|Panneaux sandwich|Fixation|Peinture|Main d'œuvre|Autres", "designation": "string", "specification": "string", "quantity": "Non précisé dans l'avis joint", "unit": "string", "confidence": "Élevée|Moyenne|Faible" }
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
    { "category": "string", "item": "string", "specification": "string", "quantity": "Non précisé dans l'avis joint", "unit": "string", "supplierType": "string", "notes": "string" }
  ],
  "bordereauDraft": [
    { "num": 1, "designation": "string", "unit": "string", "quantity": "Non précisé dans l'avis joint", "unitPriceHT": "", "totalHT": "", "tva": "20%", "notes": "string" }
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
- Extraire UNIQUEMENT les informations présentes dans l'AVIS ou déductibles du titre/catégorie
- Pour materials: lister CHAQUE matériau ou fourniture mentionné ou clairement impliqué — NE JAMAIS retourner un tableau vide si le projet concerne des travaux métalliques/aluminium/vitrerie
- Pour supplierRFQ: un article par ligne (tableau plat) — NE JAMAIS retourner vide si materials est non-vide
- Pour bordereauDraft: une ligne par prestation/fourniture — NE JAMAIS retourner vide si materials est non-vide
- Si quantité absente dans l'AVIS: mettre quantity: "Non précisé dans l'avis joint" (ne jamais laisser vide)
- Ne pas inventer les prix unitaires (laisser unitPriceHT et totalHT vides)
- profitabilityScore 0-100 (100 = très rentable pour une entreprise de métallerie)
- urgencyScore 0-100 (100 = délai très court, très urgent)
- Si information absente: signaler dans risks avec type "missing_quantities" ou "ambiguous_spec"
- Répondre UNIQUEMENT avec le JSON valide, sans markdown ni commentaires`

  try {
    console.log('[CREWAI] Starting analysis —', hasAvis ? 'source: official AVIS text' : 'source: metadata only')
    console.log('[CREWAI] Calling Gemini API…')
    const r = await groq.chat.completions.create({
      messages:    [{ role: 'user', content: prompt }],
      temperature: 0.15,
      max_tokens:  8000,
    })
    const providerUsed   = r._provider  || 'unknown'
    const modelUsed      = r.model      || 'unknown'
    const fallbackReason = r._reason    || null

    if (providerUsed === 'local-rulebased') {
      console.warn(`[CREWAI] Gemini unavailable (${fallbackReason || 'unknown'}) — falling back to local-rulebased`)
      return fallback(bon,
        fallbackReason === 'quota_exceeded'
          ? 'Quota Gemini dépassé — réessayez dans quelques minutes'
          : fallbackReason === 'no_key'
            ? 'GEMINI_API_KEY non configuré'
            : 'Erreur API Gemini',
        providerUsed, fallbackReason)
    }

    console.log(`[CREWAI] Gemini response received (model: ${modelUsed})`)
    const raw = r.choices[0].message.content.trim()
    const jsonStart = raw.indexOf('{')
    const jsonEnd   = raw.lastIndexOf('}')
    if (jsonStart < 0 || jsonEnd <= jsonStart) throw new Error('No JSON found in response')
    const parsed = JSON.parse(raw.substring(jsonStart, jsonEnd + 1))

    if (parsed.executive) {
      parsed.executive.profitabilityScore = clamp(Number(parsed.executive.profitabilityScore) || 50)
      parsed.executive.urgencyScore       = clamp(Number(parsed.executive.urgencyScore)       || 50)
    }

    // Normalize + fallback-fill empty arrays
    const normalized = normalizeAnalysis(parsed, bon)
    console.log(`[CREWAI] Analysis saved — materials:${normalized.materials.length} rfq:${normalized.supplierRFQ.length} bordereau:${normalized.bordereauDraft.length}`)

    return {
      ...normalized,
      analysisVersion: 'v2-procurement-engineer',
      analyzedAt:  new Date().toISOString(),
      skill:       'master',
      _hasAvis:    hasAvis,
      providerUsed,
      modelUsed,
      analysisType: 'full',
    }
  } catch (e) {
    console.warn('[CREWAI] AI call threw exception, using fallback:', e.message)
    return fallback(bon, e.message, 'local-rulebased', 'api_error')
  }
}

/* ── Normalization layer ─────────────────────────────────────────── */
function ensureArray(v) {
  if (Array.isArray(v)) return v
  if (!v) return []
  if (typeof v === 'string') return [{ designation: v, notes: '' }]
  if (typeof v === 'object') return Object.values(v).flat().filter(x => x && typeof x === 'object')
  return []
}

function normalizeAnalysis(parsed, bon) {
  // ── Materials: handle alias field names ──────────────────────────
  parsed.materials = ensureArray(
    parsed.materials      ||
    parsed.materialList   ||
    parsed.detectedMaterials ||
    parsed.materiaux
  )

  // ── SupplierRFQ: flatten nested { category, items:[...] } format ─
  let rfqRaw = ensureArray(
    parsed.supplierRFQ  ||
    parsed.rfq          ||
    parsed.rfqItems     ||
    parsed.demandePrix  ||
    parsed.fournisseurs
  )
  // If old nested format: { category, items:[...] } → flatten
  if (rfqRaw.length && rfqRaw[0]?.items !== undefined) {
    rfqRaw = rfqRaw.flatMap(group =>
      ensureArray(group.items).map(item => ({
        category:     group.category || item.category || 'Fournitures',
        item:         item.designation || item.item || item.name || '—',
        specification:item.specification || '',
        quantity:     item.quantity || item.quantite || 'Non précisé dans l\'avis joint',
        unit:         item.unit || item.unite || '',
        supplierType: item.supplierType || group.category || '',
        notes:        item.notes || '',
      }))
    )
  }
  parsed.supplierRFQ = rfqRaw

  // ── BordereauDraft: handle alias field names ──────────────────────
  parsed.bordereauDraft = ensureArray(
    parsed.bordereauDraft  ||
    parsed.bordereau       ||
    parsed.bordereauItems  ||
    parsed.priceSchedule   ||
    parsed.lignesPrix
  )
  // Normalise field names within each row
  parsed.bordereauDraft = parsed.bordereauDraft.map((row, i) => ({
    num:         row.num || i + 1,
    designation: row.designation || row.item || row.name || '—',
    unit:        row.unit || row.unite || 'Ens',
    quantity:    row.quantity || row.quantite || 'Non précisé dans l\'avis joint',
    unitPriceHT: row.unitPriceHT || row.pu || '',
    totalHT:     row.totalHT || row.total || '',
    tva:         row.tva || '20%',
    notes:       row.notes || '',
  }))

  // ── Keyword fallback: fill any still-empty array ──────────────────
  const needsFallback = !parsed.materials.length || !parsed.supplierRFQ.length || !parsed.bordereauDraft.length
  if (needsFallback) {
    const text = ((bon.officialText || '') + ' ' + (bon.title || '') + ' ' + (bon.description || '')).toLowerCase()
    const fb = keywordFallback(text, bon)
    if (!parsed.materials.length)     parsed.materials     = fb.materials
    if (!parsed.supplierRFQ.length)   parsed.supplierRFQ   = fb.supplierRFQ
    if (!parsed.bordereauDraft.length) parsed.bordereauDraft = fb.bordereauDraft
  }

  return parsed
}

/* ── Keyword-based fallback extractor ───────────────────────────── */
const KEYWORD_RULES = [
  {
    keywords: ['aluminium', ' alu ', 'menuiserie alu', 'profilé alu', 'façade alu'],
    category: 'Aluminium', item: 'Menuiserie / structures aluminium',
    spec: 'Selon AVIS joint', rfqType: 'Fournisseur profilés aluminium',
    bord: 'Fourniture et pose menuiserie aluminium',
  },
  {
    keywords: ['inox', 'acier inoxydable', 'inoxydable'],
    category: 'Inox', item: 'Éléments en inox',
    spec: 'Selon AVIS joint', rfqType: 'Fournisseur inox / tubes inox',
    bord: 'Fourniture et pose éléments inox',
  },
  {
    keywords: ['vitrage', ' verre ', 'double vitrage', 'simple vitrage', 'vitre'],
    category: 'Vitrage', item: 'Vitrage',
    spec: 'Selon AVIS joint', rfqType: 'Fournisseur vitrage / miroitier',
    bord: 'Fourniture et pose vitrage',
  },
  {
    keywords: ['charpente', 'structure métallique', 'ossature métallique', 'ossature metal', 'abri métal', 'abris métal', 'abris metallique', 'hangar'],
    category: 'Charpente métallique', item: 'Structure / charpente métallique',
    spec: 'Selon AVIS joint', rfqType: 'Fournisseur acier / charpentier métallique',
    bord: 'Fourniture, fabrication et pose charpente métallique',
  },
  {
    keywords: ['garde-corps', 'garde corps', 'balustrade', 'rambarde', 'main courante'],
    category: 'Serrurerie', item: 'Garde-corps métallique',
    spec: 'Selon AVIS joint', rfqType: 'Fournisseur serrurerie / garde-corps',
    bord: 'Fourniture et pose garde-corps',
  },
  {
    keywords: ['serrurerie', 'serrure', 'verrou', 'portail', 'grille', 'porte métallique', 'escalier'],
    category: 'Serrurerie', item: 'Travaux de serrurerie',
    spec: 'Selon AVIS joint', rfqType: 'Fournisseur serrurerie métallique',
    bord: 'Fourniture et pose éléments de serrurerie',
  },
  {
    keywords: ['panneaux sandwich', 'panneau sandwich', 'bardage'],
    category: 'Panneaux sandwich', item: 'Panneaux sandwich / bardage',
    spec: 'Selon AVIS joint', rfqType: 'Fournisseur panneaux sandwich',
    bord: 'Fourniture et pose panneaux sandwich',
  },
  {
    keywords: ['peinture', 'thermolaqué', 'laquage', 'thermolaquage', 'galvanisé'],
    category: 'Peinture', item: 'Traitement de surface / peinture',
    spec: 'Selon AVIS joint', rfqType: 'Thermolaqueur / prestataire peinture',
    bord: 'Traitement de surface et finition',
  },
]

function keywordFallback(text, bon) {
  const matched = KEYWORD_RULES.filter(r => r.keywords.some(kw => text.includes(kw)))
  // If nothing matched, create a generic entry based on category metadata
  if (!matched.length) {
    const cat = bon.activityMatched || bon.category || bon.title || 'Travaux'
    matched.push({
      category: 'Autres', item: cat,
      spec: 'Selon AVIS joint', rfqType: 'Fournisseur spécialisé',
      bord: `Travaux: ${cat}`,
    })
  }

  const materials = matched.map(r => ({
    category:      r.category,
    designation:   r.item,
    specification: r.spec,
    quantity:      'Non précisé dans l\'avis joint',
    unit:          'Ens',
    confidence:    'Faible',
  }))

  // Always add fixation if there are structural items
  const needsFixation = matched.some(r => ['Aluminium','Inox','Charpente métallique','Serrurerie'].includes(r.category))
  if (needsFixation) {
    materials.push({ category: 'Fixation', designation: 'Visserie, chevilles et fixations', specification: 'Selon besoins chantier', quantity: 'Non précisé dans l\'avis joint', unit: 'Ens', confidence: 'Faible' })
  }

  const supplierRFQ = matched.map(r => ({
    category:      r.category,
    item:          r.item,
    specification: r.spec,
    quantity:      'Non précisé dans l\'avis joint',
    unit:          'Ens',
    supplierType:  r.rfqType,
    notes:         'Quantités à confirmer après visite de chantier',
  }))

  const bordereauDraft = [
    ...matched.map((r, i) => ({
      num:         i + 1,
      designation: r.bord,
      unit:        'Ens',
      quantity:    'Non précisé dans l\'avis joint',
      unitPriceHT: '',
      totalHT:     '',
      tva:         '20%',
      notes:       'Quantité à préciser après visite de chantier',
    })),
    {
      num:         matched.length + 1,
      designation: 'Main d\'œuvre — pose et installation',
      unit:        'Ens',
      quantity:    'Non précisé dans l\'avis joint',
      unitPriceHT: '',
      totalHT:     '',
      tva:         '20%',
      notes:       '',
    },
  ]

  return { materials, supplierRFQ, bordereauDraft }
}

/* ── Helpers ─────────────────────────────────────────────────────── */
function clamp(n) { return Math.min(100, Math.max(0, n)) }

function fallback(bon, errorMsg, providerUsed = 'local-rulebased', fallbackReason = 'api_error') {
  // Still run keyword fallback so tabs have minimal content
  const text = ((bon.officialText || '') + ' ' + (bon.title || '') + ' ' + (bon.description || '')).toLowerCase()
  const fb = keywordFallback(text, bon)
  return {
    analysisVersion: 'v2-procurement-engineer',
    providerUsed,
    modelUsed:    'local-rulebased',
    analysisType: 'fallback',
    fallbackReason,
    executive: {
      projectTitle:        bon.title || '—',
      buyer:               bon.buyer || '—',
      city:                bon.location || '—',
      deadline:            bon.deadline || '—',
      scopeOfWork:         bon.description || 'Description non disponible',
      estimatedComplexity: null,
      bidRecommendation:   null,
      profitabilityScore:  null,
      urgencyScore:        null,
      winningProbability:  null,
    },
    materials:          fb.materials,
    certifications:     { required: [], optional: [], notMentioned: ['Attestation fiscale', 'CNSS', 'Registre de commerce', 'Assurance', 'Caution provisoire'] },
    complianceChecklist:[
      { item: 'Documents administratifs (RC, patente, CNSS, attestation fiscale)', category: 'admin' },
      { item: 'Dossier technique (références, qualification)', category: 'technique' },
      { item: 'Bordereau des prix complété et signé', category: 'commercial' },
      { item: 'Caution provisoire bancaire', category: 'submission' },
      { item: 'Dossier soumis avant la date limite', category: 'submission' },
    ],
    supplierRFQ:  fb.supplierRFQ,
    bordereauDraft: fb.bordereauDraft,
    executionPlan:[
      { phase: 'Préparation',       duration: '1 semaine',   tasks: ['Visite de chantier', 'Validation des plans', 'Prise de cotes'] },
      { phase: 'Approvisionnement', duration: '2 semaines',  tasks: ['Commande matériaux', 'Demandes de prix fournisseurs'] },
      { phase: 'Fabrication',       duration: '2-3 semaines',tasks: ['Fabrication atelier', 'Contrôle qualité', 'Préparation livraison'] },
      { phase: 'Installation',      duration: '1-2 semaines',tasks: ['Transport chantier', 'Pose et fixation', 'Finitions'] },
      { phase: 'Réception',         duration: '3 jours',     tasks: ['Inspection et tests', 'Levée de réserves', 'PV de réception'] },
    ],
    manpower:[
      { role: 'Chef de projet',       count: 1, duration: 'Durée projet',       notes: '' },
      { role: 'Chef de chantier',     count: 1, duration: 'Phase installation', notes: '' },
      { role: 'Menuisiers aluminium', count: 3, duration: 'Fabrication + pose', notes: '' },
      { role: 'Manœuvres',            count: 2, duration: 'Phase installation', notes: '' },
    ],
    equipment:[
      { item: 'Scie à onglet aluminium', quantity: 1, location: 'Atelier',  notes: '' },
      { item: 'Poste à souder TIG',      quantity: 1, location: 'Atelier',  notes: '' },
      { item: 'Perceuse/taraudeuse',     quantity: 2, location: 'Atelier',  notes: '' },
      { item: 'Véhicule de transport',   quantity: 1, location: 'Chantier', notes: '' },
      { item: 'Outillage de pose',       quantity: 1, location: 'Chantier', notes: '' },
    ],
    risks:[
      { type: 'missing_quantities', description: 'Quantités et dimensions non précisées — visite de chantier obligatoire', severity: 'Élevée' },
      { type: 'technical_risk',     description: errorMsg ? `Analyse IA: ${errorMsg.substring(0, 120)}` : 'AVIS officiel non disponible — analyse sur métadonnées uniquement', severity: 'Élevée' },
    ],
    winningStrategy:{
      strengths:                 ['Expérience technique en aluminium et métallerie', 'Capacité de fabrication atelier propre'],
      technicalPoints:           ['Certifications qualité et références similaires', 'Délai maîtrisé grâce à atelier intégré'],
      commercialRecommendations: ['Prix compétitif avec marge suffisante (≥20%)', 'Caution bancaire prête à mobiliser'],
      riskMitigation:            ['Visite de chantier avant soumission', 'Demander plans et métrés complets'],
    },
    actionPlan:[
      { step: 1, action: 'Télécharger et lire l\'AVIS complet',            deadline: 'Immédiat', owner: 'Admin' },
      { step: 2, action: 'Valider les documents administratifs en cours',   deadline: 'J+1',      owner: 'Admin' },
      { step: 3, action: 'Demander prix fournisseurs (aluminium, vitrage)', deadline: 'J+2',      owner: 'Commercial' },
      { step: 4, action: 'Compléter le bordereau des prix',                 deadline: 'J+5',      owner: 'Technique' },
      { step: 5, action: 'Vérifier et assembler le dossier de soumission',  deadline: 'J+7',      owner: 'Admin' },
      { step: 6, action: 'Soumettre avant la date limite',                  deadline: bon.deadline || '—', owner: 'Direction' },
    ],
    summary:    errorMsg || 'Analyse IA avancée indisponible.',
    analyzedAt: new Date().toISOString(),
    skill:      'master-fallback',
    _hasAvis:   false,
    _error:     errorMsg,
  }
}

module.exports = { analyze }
