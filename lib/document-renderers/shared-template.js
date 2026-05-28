'use strict'

function e(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

function fmtAmt(v) {
  if (v === undefined || v === null || v === '') return '<span class="val-na">—</span>'
  const n = parseFloat(String(v).replace(/[^0-9.-]/g,''))
  if (isNaN(n) || n === 0) return `<span class="val-na">${e(v)}</span>`
  return n.toLocaleString('fr-FR',{minimumFractionDigits:2,maximumFractionDigits:2})
}

function mv(v) {
  const s = String(v ?? '').trim()
  if (!s || s.toLowerCase().includes("non précisé") || s === '—')
    return `<span class="missing-val">Non précisé dans l'avis joint</span>`
  return e(s)
}

const BASE_CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',Arial,sans-serif;font-size:13px;color:#1e293b;background:#f8fafc;-webkit-print-color-adjust:exact;print-color-adjust:exact}
@media print{body{background:#fff}.no-print{display:none!important}@page{size:A4;margin:14mm}}
.page{max-width:820px;margin:0 auto;background:#fff;padding:24px 30px;min-height:100vh}
/* ── Header ── */
.doc-header{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:12px;border-bottom:3px solid #1e3a5f;margin-bottom:14px}
.co-name{font-size:17px;font-weight:800;color:#1e3a5f;letter-spacing:.02em}
.co-sub{font-size:11px;color:#64748b;margin-top:2px;line-height:1.45}
.doc-logo{width:60px;height:60px;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:6px;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#94a3b8;font-size:9px;text-align:center;font-weight:700;flex-shrink:0;letter-spacing:.03em}
/* ── Title ── */
.doc-title-block{text-align:center;margin-bottom:14px}
.doc-badge{display:inline-block;background:#1e3a5f;color:#fff;font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;padding:3px 12px;border-radius:4px;margin-bottom:5px}
.doc-title{font-size:15px;font-weight:700;color:#1e293b}
.doc-ref{font-size:11px;color:#64748b;margin-top:3px}
/* ── Project block ── */
.proj-block{background:#f8fafc;border:1px solid #e2e8f0;border-left:4px solid #f97316;border-radius:5px;padding:10px 14px;margin-bottom:12px;display:grid;grid-template-columns:1fr 1fr;gap:4px 20px;font-size:12px}
.proj-row{display:flex;gap:5px;align-items:baseline}
.proj-lbl{font-weight:600;color:#64748b;white-space:nowrap;flex-shrink:0}
.proj-val{color:#1e293b}
.source-badge{background:rgba(16,185,129,.08);border:1px solid rgba(16,185,129,.25);border-radius:5px;padding:5px 10px;font-size:11px;color:#059669;margin-bottom:14px;display:flex;align-items:center;gap:5px}
/* ── Sections ── */
.section{margin-bottom:16px}
.section-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#1e3a5f;padding-bottom:5px;border-bottom:2px solid #e2e8f0;margin-bottom:9px;display:flex;align-items:center;gap:6px}
.dot{width:7px;height:7px;background:#f97316;border-radius:50%;display:inline-block;flex-shrink:0}
/* ── Tables ── */
table{width:100%;border-collapse:collapse;font-size:12px;margin-bottom:10px}
th{background:#1e3a5f;color:#fff;padding:6px 8px;text-align:left;font-weight:600;font-size:11px;letter-spacing:.02em;white-space:nowrap}
td{padding:6px 8px;border-bottom:1px solid #f0f4f8;vertical-align:top;line-height:1.4}
tr:nth-child(even) td{background:#fafbfc}
.total-row td{background:#1e3a5f!important;color:#fff!important;font-weight:700}
.subtotal-row td{background:#eef2f7!important;font-weight:600}
/* ── Checklist ── */
.check-cat{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#f97316;margin:10px 0 4px 0;padding-bottom:3px;border-bottom:1px dashed #fde68a}
.check-item{display:flex;gap:9px;padding:6px 2px;border-bottom:1px solid #f8fafc;align-items:flex-start;font-size:13px}
.check-box{width:14px;height:14px;border:1.5px solid #94a3b8;border-radius:3px;flex-shrink:0;margin-top:2px}
.check-text{flex:1;line-height:1.4}
/* ── Phases ── */
.phase-row{display:flex;gap:10px;padding:8px 0;border-bottom:1px solid #f0f4f8;align-items:flex-start}
.phase-num{width:26px;height:26px;background:#1e3a5f;color:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;margin-top:1px}
.phase-body{flex:1}
.phase-name{font-weight:700;font-size:13px;color:#1e293b}
.phase-desc{font-size:12px;color:#64748b;margin-top:2px;line-height:1.4}
.phase-meta{display:flex;flex-wrap:wrap;gap:5px;margin-top:4px}
.phase-tag{background:#f1f5f9;padding:2px 7px;border-radius:9px;font-size:10px;color:#475569}
/* ── Devis ── */
.devis-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;font-size:13px}
.devis-field{padding:8px 10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:5px}
.devis-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:2px}
.devis-value{font-size:13px;color:#1e293b;font-weight:600}
.sign-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:18px}
.sign-box{border:1px solid #e2e8f0;border-radius:5px;padding:14px 16px;min-height:70px}
.sign-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#94a3b8;margin-bottom:4px}
/* ── RFQ ── */
.rfq-cat-title{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#fff;background:#334155;padding:5px 8px;border-radius:3px 3px 0 0;margin-top:10px}
/* ── Note / Warning ── */
.note-box{background:#fffbeb;border:1px solid #fde68a;border-radius:4px;padding:7px 11px;font-size:12px;color:#92400e;margin-bottom:10px;line-height:1.4}
.warn-box{background:#fef2f2;border:1px solid #fecaca;border-radius:4px;padding:7px 11px;font-size:12px;color:#991b1b;margin-bottom:10px}
/* ── Misc ── */
.missing-val{color:#d97706;font-style:italic;font-size:11px}
.val-na{color:#94a3b8;font-style:italic}
.text-right{text-align:right}
.text-center{text-align:center}
p{margin-bottom:8px;line-height:1.5}
/* ── Footer ── */
.doc-footer{border-top:1px solid #e2e8f0;margin-top:18px;padding-top:8px;display:flex;justify-content:space-between;align-items:center;font-size:10px;color:#94a3b8}
`

function wrapPage(bodyHtml, meta = {}, opts = {}) {
  const co  = meta.company || ''
  const p   = meta.project || {}
  const now = new Date().toLocaleDateString('fr-FR',{year:'numeric',month:'long',day:'numeric'})

  const header = `<div class="doc-header">
  <div>
    <div class="co-name">${e(co || 'Votre Entreprise')}</div>
    ${meta.address ? `<div class="co-sub">${e(meta.address)}</div>` : ''}
    ${meta.phone   ? `<div class="co-sub">Tél: ${e(meta.phone)}</div>` : ''}
    ${meta.email   ? `<div class="co-sub">${e(meta.email)}</div>` : ''}
    ${meta.ice     ? `<div class="co-sub">ICE: ${e(meta.ice)}${meta.rc ? ' · RC: '+e(meta.rc) : ''}${meta.ifNum ? ' · IF: '+e(meta.ifNum) : ''}</div>` : ''}
  </div>
  <div class="doc-logo">LOGO</div>
</div>`

  const titleBlock = `<div class="doc-title-block">
  <div class="doc-badge">${e(opts.typeLabel || 'Document')}</div>
  <div class="doc-title">${e(opts.title || '')}</div>
  ${opts.refLine ? `<div class="doc-ref">${e(opts.refLine)}</div>` : ''}
</div>`

  const projBlock = (p.bonId || p.buyer) ? `<div class="proj-block">
  ${p.bonId    ? `<div class="proj-row"><span class="proj-lbl">BC Réf:</span><span class="proj-val">${e(p.bonId)}</span></div>` : ''}
  ${p.buyer    ? `<div class="proj-row"><span class="proj-lbl">Acheteur:</span><span class="proj-val">${e(p.buyer)}</span></div>` : ''}
  ${p.city     ? `<div class="proj-row"><span class="proj-lbl">Ville:</span><span class="proj-val">${e(p.city)}</span></div>` : ''}
  ${p.deadline ? `<div class="proj-row"><span class="proj-lbl">Date limite:</span><span class="proj-val" style="color:#dc2626;font-weight:600">${e(p.deadline)}</span></div>` : ''}
  ${p.objet    ? `<div class="proj-row" style="grid-column:1/-1"><span class="proj-lbl">Objet:</span><span class="proj-val">${e(p.objet)}</span></div>` : ''}
  ${p.avisName ? `<div class="proj-row" style="grid-column:1/-1"><span class="proj-lbl">AVIS analysé:</span><span class="proj-val">${e(p.avisName)}</span></div>` : ''}
</div>
<div class="source-badge">✓ Document préparé exclusivement sur la base de l'AVIS joint officiel</div>` : ''

  const footer = `<div class="doc-footer">
  <span>Généré le ${now}</span>
  <span>Document basé sur l'AVIS joint officiel uniquement</span>
  <span>procurement-auto</span>
</div>`

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${e(opts.title || 'Document')}</title>
<style>${BASE_CSS}</style>
</head>
<body>
<div class="page">
${header}
${titleBlock}
${projBlock}
${bodyHtml}
${footer}
</div>
</body>
</html>`
}

function buildMeta(bon, src) {
  return {
    company: src?.companyName || '',
    address: src?.address     || '',
    phone:   src?.phone       || '',
    email:   src?.email       || '',
    ice:     src?.ice         || '',
    rc:      src?.rc          || '',
    ifNum:   src?.ifNum       || '',
    project: {
      bonId:    bon.id       || '',
      buyer:    bon.buyer    || '',
      city:     bon.location || bon.city || '',
      objet:    bon.title    || '',
      deadline: bon.deadline || '',
      avisName: src?.attachmentAnalyzed || '',
    },
  }
}

module.exports = { wrapPage, buildMeta, e, fmtAmt, mv }
