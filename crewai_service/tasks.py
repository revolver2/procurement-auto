"""CrewAI task definitions.

Each task contains detailed prompts that enforce the AVIS-only rule
and specify the exact JSON output format required.
"""
from __future__ import annotations

from crewai import Task

MISSING = "Non précisé dans l'avis joint."


def build_tasks(agents: dict, avis_text: str, metadata: str) -> list[Task]:
    """Build all 8 tasks in sequential order."""

    ctx = f"""
TEXTE OFFICIEL DE L'AVIS:
---
{avis_text[:4000]}
---
MÉTADONNÉES DU BC:
{metadata}
---
RÈGLE ABSOLUE: Utilise UNIQUEMENT le texte de l'AVIS ci-dessus.
Si une information est absente, retourne exactement: "{MISSING}"
"""

    reader_task = Task(
        description=f"""
{ctx}
MISSION: Lire l'AVIS et extraire les faits de base.
Retourne un JSON avec:
{{
  "objet": "objet exact du marché",
  "acheteur": "nom exact de l'acheteur",
  "lieu": "ville/lieu exact",
  "deadline": "date limite exacte",
  "budget": "montant exact ou estimation",
  "description": "description des travaux"
}}
""",
        expected_output='JSON object with extracted tender facts',
        agent=agents["tender_reader"],
    )

    tech_task = Task(
        description=f"""
{ctx}
MISSION: Extraire les spécifications techniques.
Retourne un JSON:
{{
  "destination": "lieu exact des travaux",
  "specifications": ["spec1", "spec2", ...],
  "dimensions": ["dim1 mm", "dim2 cm", ...],
  "quantites": ["X ml aluminium", "Y m² vitrage", ...]
}}
Inclure: standards, normes, finitions, types de profils, épaisseurs, RAL couleur.
""",
        expected_output='JSON with technical specifications extracted from AVIS',
        agent=agents["tech_spec"],
        context=[reader_task],
    )

    material_task = Task(
        description=f"""
{ctx}
MISSION: Détecter tous les matériaux.
Cherche: aluminium, inox, acier inoxydable, vitrage, verre, double vitrage,
fixation, chevilles, quincaillerie, panneaux sandwich, laine de roche,
peinture thermolaquée, serrurerie, charpente, ferronnerie, garde-corps.
Retourne JSON:
{{
  "materials": ["Aluminium thermolaqué RAL...", "Vitrage feuilleté...", ...],
  "detected_categories": ["aluminium", "vitrage", "quincaillerie", ...]
}}
""",
        expected_output='JSON with detected materials from AVIS text',
        agent=agents["material"],
        context=[reader_task, tech_task],
    )

    rfq_task = Task(
        description=f"""
{ctx}
MISSION: Créer la liste de demandes de cotation fournisseurs.
Groupe par catégorie.
Retourne JSON:
{{
  "supplierRFQ": [
    {{
      "category": "Profileurs aluminium",
      "items": ["Profil aluminium 60mm série...", ...],
      "specification": "Norme EN 573, thermolaqué RAL..."
    }},
    {{
      "category": "Verriers / Vitrerie",
      "items": ["Double vitrage 4/16/4...", ...],
      "specification": "..."
    }}
  ]
}}
""",
        expected_output='JSON with supplier RFQ list grouped by category',
        agent=agents["rfq"],
        context=[material_task],
    )

    bordereau_task = Task(
        description=f"""
{ctx}
MISSION: Créer le projet de bordereau de prix.
Retourne JSON:
{{
  "bordereauDraft": [
    {{
      "num": 1,
      "designation": "description complète de la prestation",
      "unite": "ml / m² / U / Forfait",
      "quantite": "X (nombre ou vide si inconnu)",
      "prixUnitaireHT": "",
      "totalHT": "",
      "tva": "20%",
      "totalTTC": ""
    }}
  ]
}}
Une ligne par prestation identifiable dans l'AVIS.
""",
        expected_output='JSON with bordereau draft items',
        agent=agents["bordereau"],
        context=[reader_task, tech_task, material_task],
    )

    plan_task = Task(
        description=f"""
{ctx}
MISSION: Créer le plan d'exécution chantier en 7 phases.
Retourne JSON:
{{
  "executionPlan": [
    "Phase 1 — Préparation: [détails]",
    "Phase 2 — Approvisionnement: [détails]",
    "Phase 3 — Fabrication atelier: [détails]",
    "Phase 4 — Livraison chantier: [détails]",
    "Phase 5 — Installation/Pose: [détails]",
    "Phase 6 — Contrôle qualité: [détails]",
    "Phase 7 — Réception et PV: [détails]"
  ]
}}
Base les durées sur le délai d'exécution mentionné dans l'AVIS.
""",
        expected_output='JSON with 7-phase execution plan',
        agent=agents["plan"],
        context=[reader_task, tech_task],
    )

    risk_task = Task(
        description=f"""
{ctx}
MISSION: Identifier tous les risques et informations manquantes.
Retourne JSON:
{{
  "risks": [
    "Risque: [description du risque]",
    ...
  ],
  "missingInformation": [
    "Quantités détaillées non précisées dans l'AVIS",
    ...
  ]
}}
Types de risques: délai irréaliste, specs floues, quantités manquantes,
caution non précisée, critères de sélection absents, documents manquants.
""",
        expected_output='JSON with risks and missing information',
        agent=agents["risk"],
        context=[reader_task, tech_task, material_task, bordereau_task],
    )

    manager_task = Task(
        description=f"""
{ctx}
MISSION: Compiler tous les résultats en un rapport final JSON.
Tu as accès aux analyses de tous les agents précédents.

Retourne UNIQUEMENT un JSON valide (pas de markdown, pas de texte autour):
{{
  "source": "official_avis_attachment_only",
  "summary": "résumé exécutif du marché en 2-3 phrases",
  "destination": "lieu des travaux",
  "specifications": ["spec1", "spec2", ...],
  "materials": ["mat1", "mat2", ...],
  "quantities": ["X ml profil...", "Y m² vitrage...", ...],
  "dimensions": ["largeur X mm", "hauteur Y mm", ...],
  "supplierRFQ": [
    {{"category": "...", "items": [...], "specification": "..."}}
  ],
  "executionPlan": ["Phase 1...", "Phase 2...", ...],
  "risks": ["Risque 1...", "Risque 2...", ...],
  "missingInformation": ["Info manquante 1...", ...],
  "bordereauDraft": [
    {{"num": 1, "designation": "...", "unite": "...", "quantite": "...",
      "prixUnitaireHT": "", "totalHT": "", "tva": "20%", "totalTTC": ""}}
  ],
  "submissionChecklist": [
    "Acte d'engagement signé et cacheté",
    "Bordereau de prix unitaire complété",
    "Attestation CNSS en cours de validité",
    "Attestation ICE",
    "RC et patente",
    "Attestation fiscale",
    "Caution provisoire",
    "Note méthodologique",
    "Planning d'exécution"
  ],
  "profitabilityScore": 0,
  "urgencyScore": 0,
  "winningProbability": "Faible / Moyenne / Élevée",
  "recommendedNextAction": "action recommandée"
}}

RÈGLES FINALES:
- Tous les champs liste DOIVENT être des arrays, jamais null
- Pour toute info absente dans l'AVIS: "{MISSING}"
- profitabilityScore: 0-100 (basé sur budget, complexité, compétition estimée)
- urgencyScore: 0-100 (basé sur délai de soumission)
- winningProbability: "Faible" / "Moyenne" / "Élevée"
""",
        expected_output='Complete tender analysis JSON following the exact schema',
        agent=agents["manager"],
        context=[reader_task, tech_task, material_task, rfq_task, bordereau_task, plan_task, risk_task],
    )

    return [reader_task, tech_task, material_task, rfq_task, bordereau_task, plan_task, risk_task, manager_task]
