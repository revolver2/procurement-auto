'use strict'
require('dotenv').config()
const Groq = require('groq-sdk')
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })
const { groundingBlock } = require('./_grounding')

async function generate(bon, activityResult = {}) {
  const activity  = activityResult.skill || 'general'
  const duration  = activityResult.fabrication?.fabricationDays + activityResult.installation?.installDays || 15
  const teamSize  = activityResult.installation?.teamSize || 3

  const prompt = `Tu es un conducteur de travaux marocain expert. Génère un plan d'exécution réaliste pour ce chantier.
Retourne JSON:
{
  "phases": [
    {
      "num": 1,
      "name": "string",
      "description": "string",
      "durationDays": number,
      "startDay": number,
      "resources": ["string"],
      "deliverables": ["string"],
      "prerequisites": ["string"]
    }
  ],
  "totalDurationDays": number,
  "teamComposition": [{"role":"string","count":number,"skills":["string"]}],
  "equipment": ["string"],
  "criticalPath": ["Phase N", "Phase M"],
  "qualityCheckpoints": ["string"],
  "safetyRequirements": ["string"],
  "milestones": [{"day":number,"name":"string"}]
}


${groundingBlock(bon)}

Projet: ${bon.title}
Activité: ${activity}
Lieu: ${bon.location}
Durée estimée totale: ${duration} jours
Équipe: ${teamSize} personnes
Description: ${(bon.description||'').substring(0,300)}
Articles: ${JSON.stringify((bon.articles||[]).slice(0,6))}

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
    return fallback(duration, teamSize)
  }
}

function fallback(duration, teamSize) {
  const d = duration || 15
  return {
    phases: [
      { num:1, name:'Prise de cotes et relevé', description:'Visite chantier, mesures, photos',       durationDays:1,           startDay:1,            resources:['Chef chantier'], deliverables:['Plan de relevé','Bon de commande matériaux'], prerequisites:[] },
      { num:2, name:'Commande matériaux',        description:'Passage commandes fournisseurs, réception',durationDays:3,           startDay:2,            resources:['Acheteur'],     deliverables:['Bons livraison'], prerequisites:['Prise de cotes'] },
      { num:3, name:'Fabrication atelier',       description:'Découpe, façonnage, assemblage en atelier',durationDays:Math.round(d*0.4), startDay:5,    resources:[`Équipe ${teamSize} personnes`], deliverables:['Éléments préfabriqués'], prerequisites:['Commande matériaux'] },
      { num:4, name:'Transport et livraison',    description:'Chargement, transport site chantier',    durationDays:1,           startDay:5+Math.round(d*0.4), resources:['Chauffeur','Grue si nécessaire'], deliverables:['Éléments sur site'], prerequisites:['Fabrication'] },
      { num:5, name:'Installation / Pose',       description:'Pose des éléments, fixations, réglages',  durationDays:Math.round(d*0.4), startDay:6+Math.round(d*0.4), resources:[`Équipe ${teamSize} poseurs`], deliverables:['Installation complète'], prerequisites:['Transport'] },
      { num:6, name:'Finitions et contrôle',     description:'Nettoyage, retouches, contrôle qualité',   durationDays:1,           startDay:d,            resources:['Chef chantier'], deliverables:['PV réception'], prerequisites:['Installation'] },
    ],
    totalDurationDays: d,
    teamComposition: [{ role: 'Chef chantier', count: 1, skills: ['Organisation','Contrôle qualité'] }, { role: 'Technicien', count: teamSize - 1, skills: ['Pose','Mesures'] }],
    equipment: ['Outillage standard', 'Perceuse', 'Niveau laser'],
    criticalPath: ['Commande matériaux', 'Fabrication atelier', 'Installation'],
    qualityCheckpoints: ['Vérification dimensions avant pose', 'Test étanchéité', 'Propreté chantier'],
    safetyRequirements: ['EPI obligatoires', 'Harnais si travail en hauteur'],
    milestones: [{ day: 1, name: 'Démarrage' }, { day: d, name: 'Réception' }],
    generatedAt: new Date().toISOString(),
  }
}

module.exports = { generate }
