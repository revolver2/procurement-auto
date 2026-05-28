# CrewAI Procurement Analysis Service

Multi-agent Python microservice for deep tender analysis based exclusively on official AVIS PDF text.

## Architecture

8 specialized agents in sequential pipeline:

| Agent | Role |
|---|---|
| TenderReader | Extracts basic facts from AVIS text |
| TechnicalSpec | Extracts specs, dimensions, quantities |
| MaterialExtraction | Detects aluminium/inox/vitrage/etc. |
| RFQ | Builds supplier request list by category |
| Bordereau | Creates bordereau de prix draft |
| ExecutionPlan | Creates 7-phase chantier plan |
| Risk | Identifies missing info and risks |
| TenderManager | Compiles all outputs into final JSON |

**AVIS-only rule**: All agents work exclusively from the official AVIS text.
No internet, no guessing. Missing info → `"Non précisé dans l'avis joint."`

## Requirements

- Python 3.10+
- `GEMINI_API_KEY` set in `.env` (parent directory or local)

## Local Setup

```bash
cd crewai_service
pip install -r requirements.txt
```

## Run

```bash
# From project root
npm run crewai:start

# Or directly
cd crewai_service
uvicorn main:app --host 0.0.0.0 --port 8001 --reload
```

## Run Both Services

```bash
npm install -g concurrently   # once
npm run dev:all               # runs Node.js + CrewAI together
```

## Tests

```bash
npm run crewai:test
# or
cd crewai_service && pytest tests/ -v
```

## API

### `GET /health`
Returns service status and Gemini availability.

### `POST /analyze-tender`
```json
{
  "projectId": "bc-uuid",
  "projectTitle": "Fourniture et pose menuiserie...",
  "buyer": "Commune Urbaine de Casablanca",
  "city": "Casablanca",
  "deadline": "2026-07-15",
  "officialUrl": "https://...",
  "avisText": "Texte complet de l'AVIS officiel extrait du PDF..."
}
```

Returns full analysis JSON — see `schemas.py` for complete field list.

**Errors:**
- `400` — avisText missing or too short (analysis blocked)
- `500` — internal error

## Caching

Results are cached in `data/ai-analysis/[projectId].json` with a `sourceHash`.
Same AVIS text → returns cached result immediately (no second AI call).
Run logs stored in `data/crewai-runs.json`.

## LLM Configuration

| Env Var | Description |
|---|---|
| `GEMINI_API_KEY` | Google Gemini API key (generativelanguage.googleapis.com) |

If `GEMINI_API_KEY` is missing → falls back to local rule-based analysis (always available, no AI).

## Render Deployment

### Option A — Second Render Service (recommended for production)

1. Create a new Render **Web Service** pointing to this repo
2. Set **Root Directory**: `crewai_service`
3. Set **Build Command**: `pip install -r requirements.txt`
4. Set **Start Command**: `uvicorn main:app --host 0.0.0.0 --port $PORT`
5. Add env var `GEMINI_API_KEY` in Render dashboard
6. Copy the Render service URL (e.g. `https://procurement-crewai.onrender.com`)
7. Add `CREWAI_SERVICE_URL=https://procurement-crewai.onrender.com` to the **main** Render service

### Option B — Local personal use only

Leave `CREWAI_SERVICE_URL` pointing to `http://localhost:8001` (default).
Run `npm run crewai:start` on your local machine.
The Node.js server on Render will fall back to the Gemini orchestrator
when CREWAI_SERVICE_URL is unreachable.
