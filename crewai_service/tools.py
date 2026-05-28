"""CrewAI tools — AVIS-only enforcement.

No internet access, no assumptions. Agents must work
exclusively from the official AVIS text provided as input.
"""
from crewai.tools import BaseTool
from pydantic import Field


class AvisTextTool(BaseTool):
    """Read the official AVIS text.  Returns the raw text so agents
    can reference it directly.  The only allowed data source."""

    name: str = "avis_text_reader"
    description: str = (
        "Read the official AVIS text provided for this tender. "
        "This is the ONLY allowed data source. "
        "Do NOT use internet, guesses, or external knowledge."
    )
    avis_text: str = Field(default="")

    def _run(self, query: str = "") -> str:
        if not self.avis_text:
            return "AVIS text is empty — analysis blocked."
        return self.avis_text


class MetadataTool(BaseTool):
    """Read BC metadata (title, buyer, city, deadline) as JSON string."""

    name: str = "metadata_reader"
    description: str = (
        "Read the BC metadata: project title, buyer, city, deadline. "
        "Use only to supplement facts found in the official AVIS text."
    )
    metadata: str = Field(default="{}")

    def _run(self, query: str = "") -> str:
        return self.metadata
