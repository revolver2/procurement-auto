"""CrewAI Procurement Analysis Microservice.

POST /analyze-tender — runs 8-agent CrewAI pipeline on official AVIS text.
Falls back to rule-based local analysis when GEMINI_API_KEY is absent.

Rules:
- Only official AVIS text may be used as source
- Empty AVIS text → 400 error, analysis blocked
- Results are cached by sourceHash to avoid duplicate AI calls
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import sys
from datetime import datetime
from functools import partial
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

# Load .env from parent directory (Node project root) if running standalone
_parent_env = Path(__file__).resolve().parent.parent / ".env"
if _parent_env.exists():
    load_dotenv(_parent_env)
load_dotenv()  # also load local .env if present

from schemas import TenderAnalysisRequest, TenderAnalysisResponse

logging.basicConfig(level=logging.INFO, stream=sys.stdout)
logger = logging.getLogger("crewai_service")

MISSING = "Non précisé dans l'avis joint."
CACHE_DIR = Path(__file__).resolve().parent.parent / "data" / "ai-analysis"
RUNS_FILE = Path(__file__).resolve().parent.parent / "data" / "crewai-runs.json"

app = FastAPI(title="CrewAI Procurement Service", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

AGENT_NAMES = [
    "TenderReader", "TechnicalSpec", "MaterialExtraction",
    "RFQ", "Bordereau", "ExecutionPlan", "Risk", "TenderManager",
]


# ── Cache helpers ──────────────────────────────────────────────────────────

def _compute_hash(text: str, project_id: str) -> str:
    raw = f"{project_id}:{text[:2000]}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def _cache_path(project_id: str) -> Path:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return CACHE_DIR / f"{project_id}.json"


def _load_cache(project_id: str) -> dict | None:
    p = _cache_path(project_id)
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            return None
    return None


def _save_cache(project_id: str, data: dict) -> None:
    try:
        _cache_path(project_id).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as e:
        logger.warning(f"Cache write failed: {e}")


def _log_run(project_id: str, status: str, source_hash: str, started: str, error: str = "") -> None:
    RUNS_FILE.parent.mkdir(parents=True, exist_ok=True)
    runs: list = []
    if RUNS_FILE.exists():
        try:
            runs = json.loads(RUNS_FILE.read_text(encoding="utf-8"))
        except Exception:
            runs = []
    runs.insert(0, {
        "projectId": project_id,
        "startedAt": started,
        "completedAt": datetime.utcnow().isoformat() + "Z",
        "status": status,
        "agentsUsed": AGENT_NAMES,
        "sourceHash": source_hash,
        "error": error,
    })
    try:
        RUNS_FILE.write_text(json.dumps(runs[:200], ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass


# ── Gemini REST helper (same key format as Node.js ai-providers/gemini.js) ─

async def _gemini_complete(prompt: str) -> str:
    """Call Gemini REST API directly — works with any valid generativelanguage key."""
    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise ValueError("GEMINI_API_KEY not set")

    model = "gemini-2.5-flash"
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    body = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.1, "maxOutputTokens": 4000},
    }
    async with httpx.AsyncClient(timeout=90) as client:
        r = await client.post(url, json=body)
    if not r.is_success:
        raise RuntimeError(f"Gemini HTTP {r.status_code}: {r.text[:300]}")
    data = r.json()
    text = data.get("candidates", [{}])[0].get("content", {}).get("parts", [{}])[0].get("text", "")
    if not text:
        raise RuntimeError("Gemini returned empty response")
    return text


def _clean_json(raw: str) -> str:
    """Strip markdown fences and extract JSON."""
    raw = raw.strip()
    raw = re.sub(r"^```(?:json)?\s*", "", raw, flags=re.IGNORECASE)
    raw = re.sub(r"\s*```\s*$", "", raw)
    # Find first { ... } block
    m = re.search(r"\{[\s\S]*\}", raw)
    return m.group(0) if m else raw


def _ensure_arrays(data: dict) -> dict:
    """Guarantee every list field is actually a list."""
    list_fields = [
        "specifications", "materials", "quantities", "dimensions",
        "supplierRFQ", "executionPlan", "risks", "missingInformation",
        "bordereauDraft", "submissionChecklist", "agentsUsed",
    ]
    for field in list_fields:
        v = data.get(field)
        if v is None:
            data[field] = []
        elif not isinstance(v, list):
            data[field] = [str(v)] if v else []
    return data


# ── CrewAI Gemini pipeline ─────────────────────────────────────────────────

async def _run_crewai_gemini(req: TenderAnalysisRequest) -> dict:
    """Run the full 8-agent pipeline via direct Gemini REST API calls.

    Each agent call is a focused prompt; TenderManager aggregates into final JSON.
    """
    avis = req.avisText[:4000]
    meta = (
        f"Titre: {req.projectTitle}\nAcheteur: {req.buyer}\n"
        f"Ville: {req.city}\nDélai soumission: {req.deadline}"
    )
    ctx_header = (
        f"TEXTE OFFICIEL DE L'AVIS:\n---\n{avis}\n---\n"
        f"MÉTADONNÉES BC:\n{meta}\n---\n"
        "RÈGLE: Utilise UNIQUEMENT le texte de l'AVIS. "
        f"Toute info absente → retourner \"{MISSING}\"\n"
    )

    results: dict[str, Any] = {}

    # Agent 1: TenderReader
    logger.info("[TenderReader] Extracting facts...")
    r1 = await _gemini_complete(ctx_header + """
Extrait les faits de base. JSON uniquement:
{"objet":"...","acheteur":"...","lieu":"...","deadline":"...","budget":"...","description":"..."}
""")
    try:
        results["reader"] = json.loads(_clean_json(r1))
    except Exception:
        results["reader"] = {"description": r1[:500]}

    # Agent 2: TechnicalSpec
    logger.info("[TechnicalSpec] Extracting specifications...")
    r2 = await _gemini_complete(ctx_header + """
Extrait les spécifications techniques. JSON uniquement:
{"destination":"...","specifications":["..."],"dimensions":["..."],"quantites":["..."]}
""")
    try:
        results["tech"] = json.loads(_clean_json(r2))
    except Exception:
        results["tech"] = {"specifications": [], "dimensions": [], "quantites": []}

    # Agent 3: MaterialExtraction
    logger.info("[MaterialExtraction] Detecting materials...")
    r3 = await _gemini_complete(ctx_header + """
Détecte tous les matériaux (aluminium, inox, vitrage, fixation, quincaillerie, panneaux sandwich, peinture, serrurerie, charpente).
JSON uniquement:
{"materials":["..."],"detected_categories":["..."]}
""")
    try:
        results["materials"] = json.loads(_clean_json(r3))
    except Exception:
        results["materials"] = {"materials": [], "detected_categories": []}

    # Agent 4: RFQ
    logger.info("[RFQ] Building supplier requests...")
    r4 = await _gemini_complete(ctx_header + f"""
Basé sur les matériaux détectés: {json.dumps(results['materials'].get('materials', []))}.
Crée la liste RFQ fournisseurs groupée par catégorie.
JSON uniquement:
{{"supplierRFQ":[{{"category":"...","items":["..."],"specification":"..."}}]}}
""")
    try:
        results["rfq"] = json.loads(_clean_json(r4))
    except Exception:
        results["rfq"] = {"supplierRFQ": []}

    # Agent 5: Bordereau
    logger.info("[Bordereau] Creating bordereau draft...")
    r5 = await _gemini_complete(ctx_header + """
Crée le bordereau de prix. JSON uniquement:
{"bordereauDraft":[{"num":1,"designation":"...","unite":"...","quantite":"...","prixUnitaireHT":"","totalHT":"","tva":"20%","totalTTC":""}]}
""")
    try:
        results["bordereau"] = json.loads(_clean_json(r5))
    except Exception:
        results["bordereau"] = {"bordereauDraft": []}

    # Agent 6: ExecutionPlan
    logger.info("[ExecutionPlan] Building execution plan...")
    r6 = await _gemini_complete(ctx_header + """
Crée le plan d'exécution en 7 phases (préparation, approvisionnement, fabrication, livraison, installation, contrôle qualité, réception).
JSON uniquement:
{"executionPlan":["Phase 1 — Préparation: ...","Phase 2 — Approvisionnement: ...","Phase 3 — Fabrication atelier: ...","Phase 4 — Livraison: ...","Phase 5 — Installation: ...","Phase 6 — Contrôle qualité: ...","Phase 7 — Réception: ..."]}
""")
    try:
        results["plan"] = json.loads(_clean_json(r6))
    except Exception:
        results["plan"] = {"executionPlan": []}

    # Agent 7: Risk
    logger.info("[Risk] Analyzing risks...")
    r7 = await _gemini_complete(ctx_header + """
Identifie tous les risques et informations manquantes.
JSON uniquement:
{"risks":["..."],"missingInformation":["..."]}
""")
    try:
        results["risk"] = json.loads(_clean_json(r7))
    except Exception:
        results["risk"] = {"risks": [], "missingInformation": []}

    # Agent 8: TenderManager — final aggregation
    logger.info("[TenderManager] Compiling final analysis...")
    aggregation_prompt = (
        ctx_header
        + f"""
Analyses des agents précédents:
- TenderReader: {json.dumps(results.get('reader', {}), ensure_ascii=False)[:800]}
- TechnicalSpec: {json.dumps(results.get('tech', {}), ensure_ascii=False)[:800]}
- Materials: {json.dumps(results.get('materials', {}), ensure_ascii=False)[:600]}
- RFQ: {json.dumps(results.get('rfq', {}), ensure_ascii=False)[:600]}
- Bordereau: {json.dumps(results.get('bordereau', {}), ensure_ascii=False)[:600]}
- ExecutionPlan: {json.dumps(results.get('plan', {}), ensure_ascii=False)[:400]}
- Risks: {json.dumps(results.get('risk', {}), ensure_ascii=False)[:400]}

Compile tout en un JSON final STRICT. Retourne UNIQUEMENT le JSON:
{{
  "source": "official_avis_attachment_only",
  "summary": "résumé exécutif 2-3 phrases",
  "destination": "lieu des travaux",
  "specifications": ["..."],
  "materials": ["..."],
  "quantities": ["..."],
  "dimensions": ["..."],
  "supplierRFQ": [{{"category":"...","items":["..."],"specification":"..."}}],
  "executionPlan": ["Phase 1...", "Phase 2...", "Phase 3...", "Phase 4...", "Phase 5...", "Phase 6...", "Phase 7..."],
  "risks": ["..."],
  "missingInformation": ["..."],
  "bordereauDraft": [{{"num":1,"designation":"...","unite":"...","quantite":"...","prixUnitaireHT":"","totalHT":"","tva":"20%","totalTTC":""}}],
  "submissionChecklist": ["Acte d'engagement signé et cacheté","Bordereau de prix complété","CPS signé","Dossier administratif complet","Attestation CNSS","Attestation DGI","RC + Patente","Caution provisoire","Note méthodologique"],
  "profitabilityScore": 65,
  "urgencyScore": 70,
  "winningProbability": "Moyenne",
  "recommendedNextAction": "action recommandée"
}}
RÈGLES ABSOLUES: tous les champs liste = arrays. Info absente = "{MISSING}".
"""
    )
    r8 = await _gemini_complete(aggregation_prompt)
    final = json.loads(_clean_json(r8))
    return _ensure_arrays(final)


# ── Local rule-based fallback ──────────────────────────────────────────────

_MATERIAL_PATTERNS = {
    "Aluminium": [r"alumin", r"\balum\b"],
    "Inox / Acier inoxydable": [r"inox", r"inoxydable", r"acier inoxydable"],
    "Acier galvanisé": [r"acier galvanis", r"galvanis"],
    "Vitrage": [r"vitrage", r"\bverre\b", r"double vitrage", r"simple vitrage"],
    "Quincaillerie": [r"quincaill", r"serrure", r"paumelle", r"charnière"],
    "Panneaux sandwich": [r"panneau.{0,10}sandwich", r"isolant", r"laine de roche"],
    "Peinture thermolaquée": [r"thermolaq", r"peinture", r"RAL \d{4}"],
    "Serrurerie": [r"serrurerie", r"ferronnerie", r"garde.corps"],
    "Charpente métallique": [r"charpente", r"structure métall"],
    "Menuiserie": [r"menuiserie", r"châssis", r"fenêtre", r"porte", r"portail", r"vantail"],
}

_RISK_TEMPLATES = [
    "Délai de soumission court — vérifier calendrier d'approvisionnement",
    "Spécifications techniques incomplètes dans l'AVIS",
    "Quantités non précisées — risque d'estimation incorrecte",
    "Caution provisoire à vérifier avant soumission",
    "Critères de sélection des offres non précisés",
]

_CHECKLIST = [
    "Acte d'engagement signé et cacheté",
    "Bordereau des prix unitaires complété et signé",
    "CPS paraphé et signé",
    "Attestation CNSS en cours de validité",
    "Attestation fiscale DGI",
    "RC et patente",
    "Attestation ICE",
    "Caution provisoire",
    "Note méthodologique",
    "Planning d'exécution prévisionnel",
    "Références similaires",
]


def _local_analyze(req: TenderAnalysisRequest) -> dict:
    """Rule-based fallback — no AI required."""
    text = req.avisText
    text_lower = text.lower()

    # Materials
    detected = []
    for label, patterns in _MATERIAL_PATTERNS.items():
        if any(re.search(p, text_lower) for p in patterns):
            detected.append(label)

    # Dimensions
    dims = re.findall(r"\d+\s*[×xX]\s*\d+(?:\s*[×xX]\s*\d+)?(?:\s*mm|\s*cm)?", text)
    dims += re.findall(r"\d+(?:[.,]\d+)?\s*(?:mm|cm|m)\b", text)
    dims = list(dict.fromkeys(dims))[:10]

    # Quantities
    qtys = re.findall(r"\d+(?:[.,]\d+)?\s*(?:ml|m²|m2|m\.l\.|m\.c\.|m\b|kg|pcs|unités?|u\.?|lot)", text, re.IGNORECASE)
    qtys = list(dict.fromkeys(qtys))[:10]

    # Specs from text (first 3 sentences with numbers)
    specs = [s.strip() for s in re.split(r"[.;]\s+", text) if re.search(r"\d", s) and len(s) > 20][:5]
    if not specs:
        specs = [MISSING]

    # Execution plan
    plan = [
        "Phase 1 — Préparation: Étude des plans, préparation atelier, commande matériaux",
        "Phase 2 — Approvisionnement: Réception des matériaux et vérification conformité",
        "Phase 3 — Fabrication atelier: Découpe, usinage et assemblage des éléments",
        "Phase 4 — Livraison chantier: Transport et déchargement sur site",
        "Phase 5 — Installation: Pose et fixation selon les plans approuvés",
        "Phase 6 — Contrôle qualité: Vérification finitions, étanchéité et alignement",
        "Phase 7 — Réception: Levée de réserves et signature PV de réception",
    ]

    # Risks
    risks = list(_RISK_TEMPLATES)
    if not dims:
        risks.append("Dimensions non précisées dans l'AVIS — devis estimatif impossible")
    if not detected:
        risks.append("Matériaux principaux non identifiables dans l'AVIS")

    missing = []
    if not dims:
        missing.append(f"Dimensions des ouvrages — {MISSING}")
    if not qtys:
        missing.append(f"Quantités détaillées — {MISSING}")
    if not detected:
        missing.append(f"Matériaux principaux — {MISSING}")
    if not missing:
        missing = [MISSING]

    # RFQ
    rfq = []
    if any("Aluminium" in m for m in detected):
        rfq.append({"category": "Profileurs aluminium", "items": ["Profils aluminium série standard", "Accessoires et joints"], "specification": MISSING})
    if any("Vitrage" in m for m in detected):
        rfq.append({"category": "Verriers / Vitrerie", "items": ["Vitrage selon spécifications", "Joints de vitrage"], "specification": MISSING})
    if any("Quincaillerie" in m for m in detected):
        rfq.append({"category": "Quincaillerie", "items": ["Serrures, paumelles, crémones"], "specification": MISSING})
    if not rfq:
        rfq = [{"category": MISSING, "items": [MISSING], "specification": MISSING}]

    # Bordereau
    bordereau = [{"num": 1, "designation": req.projectTitle or "Travaux selon AVIS",
                  "unite": "Forfait", "quantite": MISSING,
                  "prixUnitaireHT": "", "totalHT": "", "tva": "20%", "totalTTC": ""}]
    for i, mat in enumerate(detected[:5], 2):
        bordereau.append({"num": i, "designation": mat, "unite": MISSING,
                          "quantite": MISSING, "prixUnitaireHT": "", "totalHT": "", "tva": "20%", "totalTTC": ""})

    return {
        "source": "official_avis_attachment_only",
        "summary": f"Analyse locale du marché: {req.projectTitle}. Acheteur: {req.buyer or MISSING}. Lieu: {req.city or MISSING}.",
        "destination": req.city or MISSING,
        "specifications": specs,
        "materials": detected if detected else [MISSING],
        "quantities": qtys if qtys else [MISSING],
        "dimensions": dims if dims else [MISSING],
        "supplierRFQ": rfq,
        "executionPlan": plan,
        "risks": risks,
        "missingInformation": missing,
        "bordereauDraft": bordereau,
        "submissionChecklist": _CHECKLIST,
        "profitabilityScore": 50,
        "urgencyScore": 50,
        "winningProbability": "Moyenne",
        "recommendedNextAction": "Compléter l'analyse avec les pièces jointes officielles",
    }


# ── FastAPI endpoint ────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "gemini": bool(os.getenv("GEMINI_API_KEY")),
        "agents": AGENT_NAMES,
    }


@app.post("/analyze-tender", response_model=TenderAnalysisResponse)
async def analyze_tender(req: TenderAnalysisRequest):
    """Run CrewAI multi-agent analysis on official AVIS text."""

    # Block if AVIS text missing or too short
    if not req.avisText or len(req.avisText.strip()) < 50:
        raise HTTPException(
            status_code=400,
            detail="Analyse bloquée: AVIS officiel non extrait ou trop court pour être analysé.",
        )

    source_hash = _compute_hash(req.avisText, req.projectId)
    started_at = datetime.utcnow().isoformat() + "Z"

    # Check cache (skip if force_refresh in query)
    cached = _load_cache(req.projectId)
    if cached and cached.get("sourceHash") == source_hash and not cached.get("error"):
        logger.info(f"[Cache] Returning cached result for {req.projectId}")
        cached["cached"] = True
        return TenderAnalysisResponse(**{
            **cached,
            "projectId": req.projectId,
            "agentsUsed": AGENT_NAMES,
        })

    # Try CrewAI with Gemini
    provider = "local-rulebased"
    if os.getenv("GEMINI_API_KEY"):
        try:
            logger.info(f"[CrewAI] Running Gemini pipeline for {req.projectId}")
            result_data = await asyncio.wait_for(
                _run_crewai_gemini(req),
                timeout=120,
            )
            provider = "gemini"
            logger.info(f"[CrewAI] Gemini pipeline complete for {req.projectId}")
        except Exception as e:
            logger.warning(f"[CrewAI] Gemini failed ({e}), falling back to local rules")
            result_data = _local_analyze(req)
    else:
        logger.info(f"[CrewAI] No GEMINI_API_KEY — using local rules for {req.projectId}")
        result_data = _local_analyze(req)

    result_data = _ensure_arrays(result_data)
    result_data["projectId"] = req.projectId
    result_data["source"] = "official_avis_attachment_only"
    result_data["aiEngine"] = "crewai"
    result_data["provider"] = provider
    result_data["cached"] = False
    result_data["sourceHash"] = source_hash
    result_data["analyzedAt"] = datetime.utcnow().isoformat() + "Z"
    result_data["agentsUsed"] = AGENT_NAMES

    _save_cache(req.projectId, result_data)
    _log_run(req.projectId, "success", source_hash, started_at)

    return TenderAnalysisResponse(**result_data)


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("CREWAI_PORT", "8001"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)
