"""
Tests for CrewAI procurement analysis service.

Run: cd crewai_service && pytest tests/ -v
"""
import json
import os
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

# Ensure main module importable
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# Avoid loading real .env keys during tests
os.environ.pop("GEMINI_API_KEY", None)

from main import app, _local_analyze, _ensure_arrays, _compute_hash, MISSING
from schemas import TenderAnalysisRequest, TenderAnalysisResponse

client = TestClient(app)

SAMPLE_AVIS = (
    "Objet du marché: Fourniture et pose de menuiserie aluminium thermolaqué RAL 9016. "
    "Acheteur: Commune Urbaine de Casablanca. Lieu: Casablanca, quartier Anfa. "
    "Délai d'exécution: 45 jours à compter de l'ordre de service. "
    "Caution provisoire: 2% du montant estimatif. "
    "Le marché comprend: châssis aluminium 80×120 cm, double vitrage 4/16/4, "
    "serrures multipoints, quincaillerie inox. Quantité: 25 ml profils, 15 m² vitrage. "
    "Norme: NM 03.3.086. Finition: peinture thermolaquée RAL 9016. "
    "Date limite de soumission: 30 jours."
)

SHORT_TEXT = "Court"

PROJECT_ID = "test-project-001"


# ── 1. No AVIS blocks analysis ─────────────────────────────────────────────

def test_empty_avis_returns_400():
    """Empty avisText must return 400 — analysis blocked."""
    resp = client.post("/analyze-tender", json={
        "projectId": PROJECT_ID,
        "projectTitle": "Test BC",
        "avisText": "",
    })
    assert resp.status_code == 400
    assert "bloquée" in resp.json()["detail"].lower() or "avis" in resp.json()["detail"].lower()


def test_short_avis_returns_400():
    """Too-short avisText must return 400."""
    resp = client.post("/analyze-tender", json={
        "projectId": PROJECT_ID,
        "projectTitle": "Test BC",
        "avisText": SHORT_TEXT,
    })
    assert resp.status_code == 400


def test_health_endpoint():
    """Health check returns ok."""
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


# ── 2. Valid AVIS calls analysis ───────────────────────────────────────────

def test_valid_avis_returns_200_with_local_rules():
    """Valid AVIS text returns 200 using local rule-based (no API key in tests)."""
    resp = client.post("/analyze-tender", json={
        "projectId": PROJECT_ID,
        "projectTitle": "Menuiserie aluminium — Commune Anfa",
        "buyer": "Commune Urbaine de Casablanca",
        "city": "Casablanca",
        "deadline": "2026-07-15",
        "avisText": SAMPLE_AVIS,
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data["projectId"] == PROJECT_ID
    assert data["source"] == "official_avis_attachment_only"


# ── 3. Output arrays are always arrays ────────────────────────────────────

def test_output_arrays_are_arrays():
    """All list fields in response must be Python lists."""
    resp = client.post("/analyze-tender", json={
        "projectId": "test-arrays",
        "projectTitle": "Test arrays",
        "avisText": SAMPLE_AVIS,
    })
    assert resp.status_code == 200
    data = resp.json()
    list_fields = [
        "specifications", "materials", "quantities", "dimensions",
        "supplierRFQ", "executionPlan", "risks", "missingInformation",
        "bordereauDraft", "submissionChecklist", "agentsUsed",
    ]
    for field in list_fields:
        assert isinstance(data[field], list), f"Field '{field}' must be a list, got {type(data[field])}"


# ── 4. Missing fields return the placeholder string ───────────────────────

def test_missing_info_uses_placeholder():
    """When AVIS contains no specs, missingInformation should contain the placeholder."""
    minimal_avis = (
        "Avis d'appel d'offres ouvert. "
        "Maître d'ouvrage: Administration. "
        "Objet: Travaux divers de rénovation. "
        "Délai de remise des offres: 20 jours. "
        "Le dossier d'appel d'offres peut être retiré au siège."
    )
    req = TenderAnalysisRequest(
        projectId="test-missing",
        projectTitle="Travaux divers",
        avisText=minimal_avis,
    )
    result = _local_analyze(req)
    # At least one missing info entry exists
    assert len(result["missingInformation"]) > 0
    # Must include the standard placeholder somewhere in the response
    all_text = json.dumps(result, ensure_ascii=False)
    assert MISSING in all_text


# ── 5. Caching avoids second AI call ──────────────────────────────────────

def test_cached_analysis_is_returned():
    """Second request with same avisText + projectId returns cached=True."""
    pid = "test-cache-001"
    payload = {
        "projectId": pid,
        "projectTitle": "Cache test",
        "avisText": SAMPLE_AVIS,
    }
    # First call
    r1 = client.post("/analyze-tender", json=payload)
    assert r1.status_code == 200
    assert r1.json()["cached"] is False

    # Second call — should hit cache
    r2 = client.post("/analyze-tender", json=payload)
    assert r2.status_code == 200
    assert r2.json()["cached"] is True


def test_different_avis_invalidates_cache():
    """Different avisText produces different hash — cache must not be reused."""
    pid = "test-cache-002"
    r1 = client.post("/analyze-tender", json={"projectId": pid, "projectTitle": "T", "avisText": SAMPLE_AVIS})
    r2 = client.post("/analyze-tender", json={"projectId": pid, "projectTitle": "T",
                                               "avisText": SAMPLE_AVIS + " (modifié)"})
    h1 = r1.json()["sourceHash"]
    h2 = r2.json()["sourceHash"]
    assert h1 != h2


# ── 6. _ensure_arrays normalises bad shapes ────────────────────────────────

def test_ensure_arrays_converts_none():
    """_ensure_arrays must convert None → []."""
    data = {"specifications": None, "materials": "inox", "risks": []}
    out = _ensure_arrays(data)
    assert out["specifications"] == []
    assert isinstance(out["materials"], list)
    assert out["risks"] == []


# ── 7. Local analysis detects aluminium + vitrage ─────────────────────────

def test_local_detect_materials():
    """Local analyser should detect aluminium and vitrage from the sample AVIS."""
    req = TenderAnalysisRequest(
        projectId="test-mats",
        projectTitle="Menuiserie aluminium",
        avisText=SAMPLE_AVIS,
    )
    result = _local_analyze(req)
    mats_lower = " ".join(result["materials"]).lower()
    assert "aluminium" in mats_lower
    assert "vitrage" in mats_lower


# ── 8. Execution plan has 7 phases ────────────────────────────────────────

def test_local_execution_plan_7_phases():
    """Local analyser must return exactly 7 execution plan phases."""
    req = TenderAnalysisRequest(
        projectId="test-plan",
        projectTitle="Travaux de pose",
        avisText=SAMPLE_AVIS,
    )
    result = _local_analyze(req)
    assert len(result["executionPlan"]) == 7
    for i, phase in enumerate(result["executionPlan"], 1):
        assert f"Phase {i}" in phase


# ── 9. Submission checklist non-empty ─────────────────────────────────────

def test_local_checklist_non_empty():
    """Local analyser must return a non-empty submission checklist."""
    req = TenderAnalysisRequest(
        projectId="test-checklist",
        projectTitle="Test",
        avisText=SAMPLE_AVIS,
    )
    result = _local_analyze(req)
    assert len(result["submissionChecklist"]) >= 5


# ── 10. Source field always set correctly ─────────────────────────────────

def test_source_always_official():
    """source field must always equal 'official_avis_attachment_only'."""
    resp = client.post("/analyze-tender", json={
        "projectId": "test-src",
        "projectTitle": "Test source",
        "avisText": SAMPLE_AVIS,
    })
    assert resp.status_code == 200
    assert resp.json()["source"] == "official_avis_attachment_only"
