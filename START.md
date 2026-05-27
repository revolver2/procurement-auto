# Procurement Intelligence — Quick Start

## 1. Set your API keys (optional but needed for AI analysis)

Edit `.env` and add your Groq key (free at console.groq.com):
```
GROQ_API_KEY=gsk_your_key_here
```

## 2. Start the server
```
npm start
```
Server runs at: http://localhost:3001

## 3. Open the app
Open http://localhost:3001 in your browser.

## Credentials already configured
- **Portal**: marchespublics.gov.ma
- **Username**: 003674240000039
- **Password**: configured in .env

## What it does
1. **Dashboard** → click "Lancer le scraping" to import bons de commande
2. **Analyser IA** → on any project to detect materials and complexity
3. **Générer Docs** → creates Bordereau de Prix, Devis, RFQ, Plan d'exécution
4. **Copilote IA** → chat assistant for procurement questions
5. **Paramètres** → update credentials and API keys
