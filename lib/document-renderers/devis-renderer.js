'use strict'
const { wrapPage, buildMeta, e, fmtAmt, mv } = require('./shared-template')

function render(bon, data, src = {}) {
  const items   = data?.items || []
  const totalHT = data?.totalHT || items.reduce((s,i) => s + (parseFloat(i.total||0)||0), 0)
  const tva     = data?.tva    != null ? data.tva    : totalHT * 0.20
  const ttc     = data?.totalTTC != null ? data.totalTTC : totalHT + tva

  const infoBlock = `<div class="devis-grid">
  <div class="devis-field"><div class="devis-label">Référence</div><div class="devis-value">${e(data?.reference||'—')}</div></div>
  <div class="devis-field"><div class="devis-label">Date</div><div class="devis-value">${e(data?.date||new Date().toLocaleDateString('fr-FR'))}</div></div>
  <div class="devis-field"><div class="devis-label">Client / Acheteur</div><div class="devis-value">${e(data?.client||bon.buyer||'—')}</div></div>
  <div class="devis-field"><div class="devis-label">Validité</div><div class="devis-value">${e(data?.validite||'30 jours')}</div></div>
</div>`

  const rows = items.map(it => `<tr>
    <td>${e(String(it.designation||''))}</td>
    <td class="text-center">${mv(it.unite)}</td>
    <td class="text-right">${fmtAmt(it.quantite)}</td>
    <td class="text-right">${fmtAmt(it.prixUnitaire)}</td>
    <td class="text-right">${fmtAmt(it.total)}</td>
  </tr>`).join('')

  const totals = `<tfoot>
    <tr class="subtotal-row"><td colspan="4" class="text-right">Total HT</td><td class="text-right">${fmtAmt(totalHT)} MAD</td></tr>
    <tr class="subtotal-row"><td colspan="4" class="text-right">TVA (20%)</td><td class="text-right">${fmtAmt(tva)} MAD</td></tr>
    <tr class="total-row"><td colspan="4" class="text-right" style="font-size:12px">TOTAL TTC</td><td class="text-right" style="font-size:14px">${fmtAmt(ttc)} MAD</td></tr>
  </tfoot>`

  const conditions = data?.conditions ? `<div class="section">
  <div class="section-title"><span class="dot"></span> Conditions</div>
  <p style="font-size:13px">${e(data.conditions)}</p>
</div>` : ''

  const notes = data?.notes ? `<div class="note-box">${e(data.notes)}</div>` : ''

  const body = `${infoBlock}
<div class="section">
  <div class="section-title"><span class="dot"></span> Détail des Prestations</div>
  <table>
    <thead><tr>
      <th>Désignation</th><th class="text-center">Unité</th>
      <th class="text-right">Quantité</th><th class="text-right">Prix unitaire</th>
      <th class="text-right">Total</th>
    </tr></thead>
    <tbody>${rows || noData()}</tbody>
    ${items.length ? totals : ''}
  </table>
</div>
${conditions}
${notes}
<div class="sign-grid">
  <div class="sign-box"><div class="sign-label">Établi par</div></div>
  <div class="sign-box"><div class="sign-label">Lu et approuvé — Client</div></div>
</div>`

  return wrapPage(body, buildMeta(bon, src), {
    typeLabel: 'Devis Commercial',
    title:     `Devis — ${bon.title || ''}`,
    refLine:   data?.reference ? `Réf: ${data.reference}` : `BC: ${bon.id || ''}`,
  })
}

function noData() {
  return `<tr><td colspan="5" class="text-center" style="padding:20px;color:#94a3b8">Aucun article</td></tr>`
}

module.exports = { render }
