'use strict'

async function sendMessage(botToken, chatId, text) {
  if (!botToken || !chatId) return
  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`
    const r = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    })
    const data = await r.json()
    if (!data.ok) console.warn('[Telegram]', data.description)
    return data
  } catch (e) {
    console.warn('[Telegram] send failed:', e.message)
  }
}

function formatBon(bon) {
  const lines = [
    `🔔 <b>Nouveau Bon de Commande</b>`,
    ``,
    `📋 <b>Réf:</b> ${bon.reference || '—'}`,
    `📝 <b>Objet:</b> ${(bon.title || '').substring(0, 120)}`,
    `🏛 <b>Acheteur:</b> ${(bon.buyer || '—').substring(0, 80)}`,
    `📍 <b>Lieu:</b> ${bon.location || '—'}`,
    `🏷 <b>Activité:</b> ${bon.activityMatched || '—'}`,
    `🔑 <b>Mots-clés:</b> ${(bon.keywordsMatched || []).slice(0, 5).join(', ') || '—'}`,
    `⏰ <b>Date limite:</b> ${bon.deadline || '—'}`,
    bon.estimatedAmount ? `💰 <b>Estimation:</b> ${bon.estimatedAmount} MAD` : null,
    ``,
    `🔗 <a href="${bon.sourceUrl}">Voir le bon</a>`,
  ]
  return lines.filter(l => l !== null).join('\n')
}

function formatCrewAiSummary(bon, analysis) {
  const title     = (bon.title || '').substring(0, 100)
  const buyer     = (bon.buyer || '—').substring(0, 60)
  const city      = bon.location || bon.city || '—'
  const urgency   = analysis.urgencyScore   != null ? analysis.urgencyScore   : '?'
  const profit    = analysis.profitabilityScore != null ? analysis.profitabilityScore : '?'
  const winProb   = analysis.winningProbability || '—'
  const nextAction = (analysis.recommendedNextAction || '—').substring(0, 120)
  const mats      = (analysis.materials || []).slice(0, 5).join(', ') || '—'
  const provider  = analysis.provider === 'gemini' ? '🤖 Gemini 2.5 Flash' : '📐 Règles locales'
  const cached    = analysis.cached ? ' (cache)' : ''

  const urgIcon   = urgency >= 70 ? '🔴' : urgency >= 40 ? '🟡' : '🟢'
  const winIcon   = winProb === 'Élevée' ? '✅' : winProb === 'Faible' ? '⚠️' : '🔵'

  const lines = [
    `🤖 <b>Analyse CrewAI terminée${cached}</b>`,
    ``,
    `📋 <b>${title}</b>`,
    `🏛 <b>Acheteur:</b> ${buyer}`,
    `📍 <b>Lieu:</b> ${city}`,
    ``,
    `${urgIcon} <b>Urgence:</b> ${urgency}/100`,
    `💰 <b>Rentabilité:</b> ${profit}/100`,
    `${winIcon} <b>Probabilité succès:</b> ${winProb}`,
    ``,
    `🏗 <b>Matériaux:</b> ${mats}`,
    ``,
    `→ <b>Action:</b> ${nextAction}`,
    ``,
    `<i>${provider} • 8 agents</i>`,
  ]
  return lines.join('\n')
}

module.exports = { sendMessage, formatBon, formatCrewAiSummary }
