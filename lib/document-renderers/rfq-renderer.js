'use strict'
const { wrapPage, buildMeta, e, mv } = require('./shared-template')

function render(bon, data, src = {}) {
  // Accept both rfq-generated format {subject,suppliers,[]} and CrewAI format {supplierRFQ:[]}
  const subject   = data?.subject || `Demande de Prix — ${bon.title || ''}`
  const suppliers = data?.suppliers || data?.supplierRFQ || []
  const deadline  = data?.deadline  || bon.deadline || '—'
  const payment   = data?.paymentTerms        || '—'
  const delivery  = data?.deliveryRequirements || `Livraison sur site: ${bon.location || bon.city || '—'}`

  const header = `<div class="note-box" style="background:rgba(30,58,95,.06);border-color:rgba(30,58,95,.2);color:#1e3a5f">
  <strong>Objet de la consultation:</strong> ${e(subject)}<br>
  <strong>Date limite de réponse:</strong> ${e(deadline)} &nbsp;|&nbsp;
  <strong>Paiement:</strong> ${e(payment)} &nbsp;|&nbsp;
  <strong>Livraison:</strong> ${e(delivery)}
</div>`

  const sections = suppliers.map(s => {
    const items = s.items || []
    const rows = items.map(it => {
      // Items can be strings (CrewAI) or objects (legacy)
      if (typeof it === 'string') {
        return `<tr><td>${e(it)}</td><td class="missing-val">—</td><td class="missing-val text-center">—</td><td class="missing-val text-center">—</td><td></td></tr>`
      }
      return `<tr>
        <td>${e(String(it.designation||it||''))}</td>
        <td>${mv(it.specification||'')}</td>
        <td class="text-center">${mv(it.quantite||'')}</td>
        <td class="text-center">${mv(it.unite||'')}</td>
        <td></td>
      </tr>`
    }).join('')

    const spec = s.specification || s.notes || ''

    return `<div style="margin-bottom:14px">
  <div class="rfq-cat-title">${e(s.category||'Catégorie')}</div>
  ${spec ? `<p style="font-size:11px;color:#64748b;padding:4px 8px;background:#f8fafc;border:1px solid #e2e8f0;border-top:none;margin-bottom:0">${e(spec)}</p>` : ''}
  <table>
    <thead><tr><th>Article / Désignation</th><th>Spécification</th><th class="text-center">Quantité</th><th class="text-center">Unité</th><th>Observations</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="5" class="text-center" style="color:#94a3b8;padding:10px">Aucun article</td></tr>`}</tbody>
  </table>
</div>`
  }).join('')

  const empty = suppliers.length === 0 ? `<div class="note-box">Aucun fournisseur détecté. Compléter selon l'AVIS officiel.</div>` : ''

  const body = `${header}
<div class="section">
  <div class="section-title"><span class="dot"></span> Articles à Chiffrer par Catégorie</div>
  ${sections}${empty}
</div>
<div class="note-box">⚠ Les quantités marquées "Non précisé" sont à vérifier dans le dossier officiel avant envoi.</div>
<div class="sign-grid" style="grid-template-columns:1fr 1fr 1fr;gap:14px">
  <div class="sign-box"><div class="sign-label">Prix proposé (MAD HT)</div><div style="height:40px"></div></div>
  <div class="sign-box"><div class="sign-label">Délai de livraison</div><div style="height:40px"></div></div>
  <div class="sign-box"><div class="sign-label">Cachet &amp; Signature fournisseur</div><div style="height:40px"></div></div>
</div>`

  return wrapPage(body, buildMeta(bon, src), {
    typeLabel: 'Demande de Prix Fournisseur',
    title:     `RFQ — ${bon.title || ''}`,
    refLine:   `BC: ${bon.id || ''} · ${new Date().toLocaleDateString('fr-FR')}`,
  })
}

module.exports = { render }
