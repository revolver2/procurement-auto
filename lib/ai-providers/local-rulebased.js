'use strict'

// reason: 'no_key' | 'quota_exceeded' | 'api_error'
function complete({ messages, reason = 'no_key' } = {}) {
  const summaryMap = {
    no_key:        'Analyse IA indisponible — GEMINI_API_KEY non configuré.',
    quota_exceeded:'Analyse IA indisponible — Quota Gemini dépassé (limite gratuite). Réessayez dans quelques minutes.',
    api_error:     'Analyse IA indisponible — Erreur API Gemini. Vérifiez la clé et réessayez.',
  }
  const summary = summaryMap[reason] || summaryMap.no_key

  return Promise.resolve(JSON.stringify({
    projectType:        'general',
    profiles:           [],
    surfaces:           [],
    vitrage:            [],
    accessories:        [],
    fabrication:        { difficultLvl: 3, specialEquipment: [], fabricationDays: 7, notes: summary },
    installation:       { phases: ['Prise de cotes', 'Fabrication', 'Pose', 'Finitions'], teamSize: 3, installDays: 3, liftRequired: false },
    materials:          [],
    estimatedWeightKg:  0,
    keyRisks:           [summary],
    missingInfo:        ['Dimensions', 'Plans', 'Finition', 'Quantités'],
    technicalNotes:     summary,
    attractivenessScore:null,
    attractivenessLabel:'Indisponible',
    estimatedMarginPercent: null,
    goNoGo:             'unavailable',
    goNoGoReason:       summary,
    overallRiskScore:   null,
    overallRiskLevel:   'Indisponible',
    risks:              [],
    riskFactors:        [],
    winProbabilityPercent: null,
    confidenceLevel:    'Indisponible',
    recommendation:     'Analyse IA avancée indisponible',
    recommendationReason: summary,
    summary,
    suppliers:          [],
    categories:         [],
    specificationsTechniques: [],
    materiaux:          [],
    fournisseursRFQ:    [],
    planExecution:      [],
    mainOeuvre:         [],
    equipements:        [],
    risques:            [],
    informationsManquantes: [],
    strategieOffre:     '—',
    difficulte:         null,
    urgence:            null,
    rentabilite:        null,
    actionRecommandee:  'Réessayez après configuration Gemini',
    resume:             summary,
    activiteDetectee:   '—',
    _fallbackReason:    reason,
  }))
}

module.exports = { complete }
