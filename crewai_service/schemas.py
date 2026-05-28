"""Pydantic schemas for the CrewAI procurement analysis service."""
from __future__ import annotations

from typing import List, Optional
from pydantic import BaseModel, Field


class TenderAnalysisRequest(BaseModel):
    projectId: str
    projectTitle: str
    buyer: str = ""
    city: str = ""
    deadline: str = ""
    officialUrl: str = ""
    avisText: str


class SourceTraceability(BaseModel):
    bcId: str = ""
    buyer: str = ""
    attachmentAnalyzed: str = ""
    analysisDate: str = ""
    aiEngine: str = ""
    statement: str = (
        "Analyse basée uniquement sur l'AVIS joint officiel. "
        "Toute information absente est signalée explicitement."
    )


class ConfidenceMap(BaseModel):
    """Per-section confidence labels (parallel arrays matching corresponding list fields)."""
    specifications: List[str] = Field(default_factory=list)
    materials: List[str] = Field(default_factory=list)
    quantities: List[str] = Field(default_factory=list)
    dimensions: List[str] = Field(default_factory=list)
    executionPlan: List[str] = Field(default_factory=list)
    bordereauDraft: List[str] = Field(default_factory=list)
    submissionChecklist: List[str] = Field(default_factory=list)
    risks: List[str] = Field(default_factory=list)
    missingInformation: List[str] = Field(default_factory=list)


class TenderAnalysisResponse(BaseModel):
    source: str = "official_avis_attachment_only"
    projectId: str
    summary: str = ""
    destination: str = ""
    specifications: List[str] = Field(default_factory=list)
    materials: List[str] = Field(default_factory=list)
    quantities: List[str] = Field(default_factory=list)
    dimensions: List[str] = Field(default_factory=list)
    supplierRFQ: List[dict] = Field(default_factory=list)
    executionPlan: List[str] = Field(default_factory=list)
    risks: List[str] = Field(default_factory=list)
    missingInformation: List[str] = Field(default_factory=list)
    bordereauDraft: List[dict] = Field(default_factory=list)
    submissionChecklist: List[str] = Field(default_factory=list)
    profitabilityScore: int = 0
    urgencyScore: int = 0
    winningProbability: str = ""
    recommendedNextAction: str = ""
    # source traceability
    sourceTraceability: Optional[SourceTraceability] = None
    confidence: Optional[ConfidenceMap] = None
    # metadata
    aiEngine: str = "crewai"
    provider: str = "gemini"
    cached: bool = False
    sourceHash: str = ""
    analyzedAt: str = ""
    agentsUsed: List[str] = Field(default_factory=list)
