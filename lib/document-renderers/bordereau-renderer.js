'use strict'
const { wrapPage, buildMeta, e, fmtAmt, mv } = require('./shared-template')

function render(bon, data, src = {}) {
  // Accept both legacy (array) and CrewAI (bordereauDraft) formats
  const items = Array.isArray(data) ? data
    : (data?.bordereauDraft || data?.items || [])

  let totalHT = 0
  const rows = items.map(it => {
    const pu  = parseFloat(String(it.prixUnitaireHT || '').replace(/[^0-9.-]/g,''))
    const qty = parseFloat(String(it.quantite || '').replace(/[^0-9.-]/g,''))
    let   th  = parseFloat(String(it.totalHT || it.montantHT || '').replace(/[^0-9.-]/g,''))
    if (isNaN(th) && !isNaN(pu) && !isNaN(qty)) th = pu * qty
    if (!isNaN(th) && th > 0) totalHT += th

    const qStr = String(it.quantite || '').trim()
    const puOK = !isNaN(pu) && pu > 0
    const thOK = !isNaN(th) && th > 0

    return `<tr>
      <td class="text-center" style="font-weight:600;width:34px">${e(String(it.num||''))}</td>
      <td>${e(String(it.designation||''))}</td>
      <td>${mv(it.unite)}</td>
      <td>${qStr ? mv(qStr) : `<span class="missing-val">Non précisé</span>`}</td>
      <td class="text-right">${puOK ? fmtAmt(pu) : `<span class="missing-val">À compléter</span>`}</td>
      <td class="text-right">${thOK ? fmtAmt(th) : `<span class="missing-val">À compléter</span>`}</td>
      <td class="text-center">${e(String(it.tva||'20%'))}</td>
      <td class="text-right">${thOK ? fmtAmt(th*1.20) : `<span class="missing-val">À compléter</span>`}</td>
    </tr>`
  }).join('')

  const tva = totalHT * 0.20
  const ttc = totalHT * 1.20

  const totals = totalHT > 0 ? `<tfoot>
    <tr class="subtotal-row">
      <td colspan="5" class="text-right">Sous-total HT</td>
      <td class="text-right">${fmtAmt(totalHT)} MAD</td><td></td><td></td>
    </tr>
    <tr class="subtotal-row">
      <td colspan="5" class="text-right">TVA (20%)</td>
      <td class="text-right">${fmtAmt(tva)} MAD</td><td></td><td></td>
    </tr>
    <tr class="total-row">
      <td colspan="5" class="text-right" style="font-size:12px">TOTAL TTC</td>
      <td class="text-right" colspan="3" style="font-size:14px">${fmtAmt(ttc)} MAD</td>
    </tr>
  </tfoot>` : ''

  const body = `<div class="section">
  <div class="section-title"><span class="dot"></span> Détail des Prestations</div>
  <table>
    <thead><tr>
      <th>#</th><th>Désignation</th><th>Unité</th><th>Quantité</th>
      <th class="text-right">P.U. HT</th><th class="text-right">Total HT</th>
      <th class="text-center">TVA</th><th class="text-right">Total TTC</th>
    </tr></thead>
    <tbody>${rows || noData()}</tbody>
    ${totals}
  </table>
</div>
${totalHT === 0 ? `<div class="note-box">⚠ Les prix unitaires sont à compléter selon devis fournisseurs. Les quantités marquées "Non précisé" sont à vérifier dans le dossier officiel.</div>` : ''}
<div class="sign-grid">
  <div class="sign-box"><div class="sign-label">Établi par</div></div>
  <div class="sign-box"><div class="sign-label">Validé par</div></div>
</div>`

  return wrapPage(body, buildMeta(bon, src), {
    typeLabel: 'Bordereau de Prix',
    title:     `Bordereau de Prix — ${bon.title || ''}`,
    refLine:   `Réf. BC: ${bon.id || ''}${bon.reference ? ' · ' + bon.reference : ''}`,
  })
}

function noData() {
  return `<tr><td colspan="8" class="text-center" style="padding:20px;color:#94a3b8">Aucune ligne générée</td></tr>`
}

module.exports = { render }
