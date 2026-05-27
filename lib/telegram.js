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

module.exports = { sendMessage, formatBon }
