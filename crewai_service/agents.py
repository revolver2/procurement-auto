"""CrewAI agent definitions for procurement tender analysis.

All agents enforce the AVIS-only rule:
  - Work exclusively from the official AVIS text + BC metadata
  - No internet, no guessing, no external knowledge
  - Return "Non précisé dans l'avis joint." for missing information
"""
from __future__ import annotations

import os
from crewai import Agent, LLM


MISSING = "Non précisé dans l'avis joint."

AVIS_ONLY_RULE = (
    "RÈGLE ABSOLUE: Tu travailles UNIQUEMENT à partir du texte officiel de l'AVIS fourni. "
    "N'invente rien. Si une information n'est pas dans l'AVIS, retourne exactement: "
    f'"{MISSING}". '
    "Aucune recherche internet. Aucune hypothèse. Seulement les faits de l'AVIS."
)


def build_llm() -> LLM | None:
    """Build Gemini LLM via LiteLLM. Returns None if key is absent."""
    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    if not api_key:
        return None
    try:
        return LLM(
            model="gemini/gemini-2.5-flash",
            api_key=api_key,
            temperature=0.1,
            max_tokens=2000,
        )
    except Exception:
        try:
            # Fallback: Gemini OpenAI-compatible endpoint
            return LLM(
                model="openai/gemini-2.5-flash",
                base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
                api_key=api_key,
                temperature=0.1,
                max_tokens=2000,
            )
        except Exception:
            return None


def make_agents(llm: LLM | None, tools: list) -> dict[str, Agent]:
    """Create all 8 procurement analysis agents."""

    base = dict(llm=llm, verbose=False, allow_delegation=False, tools=tools)

    tender_reader = Agent(
        role="Tender Reader",
        goal="Lire le texte officiel de l'AVIS et extraire uniquement les faits écrits dedans.",
        backstory=(
            "Expert en lecture de documents d'appel d'offres marocains. "
            "Tu lis l'AVIS avec précision et extrais les données factuelles: "
            "objet du marché, acheteur, lieu, délai, budget, description des travaux. "
            + AVIS_ONLY_RULE
        ),
        **base,
    )

    tech_spec = Agent(
        role="Technical Specification Agent",
        goal="Extraire toutes les spécifications techniques de l'AVIS officiel.",
        backstory=(
            "Ingénieur technicien spécialisé en menuiserie aluminium, inox et métallerie. "
            "Tu extrais: destination des travaux, spécifications techniques, dimensions, "
            "tolérances, normes, finitions, contraintes d'installation. "
            + AVIS_ONLY_RULE
        ),
        **base,
    )

    material_agent = Agent(
        role="Material Extraction Agent",
        goal="Détecter tous les matériaux et leurs quantités dans l'AVIS.",
        backstory=(
            "Expert matériaux menuiserie. Tu détectes: aluminium, inox, acier, vitrage, "
            "fixation, quincaillerie, panneaux sandwich, peinture, serrurerie, charpente. "
            "Tu extrais les quantités, unités et spécifications pour chaque matériau. "
            + AVIS_ONLY_RULE
        ),
        **base,
    )

    rfq_agent = Agent(
        role="RFQ Agent",
        goal="Créer une liste de demande de cotation fournisseurs groupée par catégorie.",
        backstory=(
            "Acheteur industriel expérimenté. Tu crées des RFQ structurées en regroupant "
            "les matériaux par catégorie fournisseur: profileurs aluminium, verriers, "
            "quincailliers, peintres industriels, fabricants inox. "
            + AVIS_ONLY_RULE
        ),
        **base,
    )

    bordereau_agent = Agent(
        role="Bordereau Agent",
        goal="Créer un projet de bordereau de prix à partir des spécifications de l'AVIS.",
        backstory=(
            "Métreur-vérificateur spécialisé marchés publics marocains. "
            "Tu crées le bordereau avec: désignation, unité, quantité, "
            "prix unitaire HT (vide), total HT (vide), TVA 20%, total TTC (vide). "
            "Chaque ligne correspond à une prestation identifiable dans l'AVIS. "
            + AVIS_ONLY_RULE
        ),
        **base,
    )

    plan_agent = Agent(
        role="Execution Plan Agent",
        goal="Créer un plan d'exécution chantier en 7 phases.",
        backstory=(
            "Chef de chantier expérimenté en métallerie et menuiserie aluminium. "
            "Tu crées un plan en 7 phases: préparation, approvisionnement, fabrication, "
            "livraison, installation, contrôle qualité, réception. "
            "Durées basées UNIQUEMENT sur les informations de l'AVIS. "
            + AVIS_ONLY_RULE
        ),
        **base,
    )

    risk_agent = Agent(
        role="Risk Agent",
        goal="Identifier tous les risques du marché à partir de l'AVIS.",
        backstory=(
            "Expert en gestion des risques marchés publics. "
            "Tu identifies: informations manquantes, délais irréalistes, "
            "quantités floues, spécifications incomplètes, risques documentaires, "
            "risques techniques et financiers. "
            + AVIS_ONLY_RULE
        ),
        **base,
    )

    manager_agent = Agent(
        role="Tender Manager",
        goal=(
            "Compiler tous les résultats des agents en un JSON final propre "
            "avec tous les champs requis."
        ),
        backstory=(
            "Directeur de projets marchés publics marocains avec 15 ans d'expérience. "
            "Tu synthétises les analyses de tous les agents spécialisés en un rapport "
            "structuré JSON complet, cohérent et actionnable. "
            "Tu évalues la rentabilité (0-100) et l'urgence (0-100). "
            + AVIS_ONLY_RULE
        ),
        **base,
    )

    return {
        "tender_reader": tender_reader,
        "tech_spec": tech_spec,
        "material": material_agent,
        "rfq": rfq_agent,
        "bordereau": bordereau_agent,
        "plan": plan_agent,
        "risk": risk_agent,
        "manager": manager_agent,
    }
