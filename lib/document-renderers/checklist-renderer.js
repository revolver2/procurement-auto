'use strict'
const { wrapPage, buildMeta, e } = require('./shared-template')

function render(bon, data, src = {}) {
  // Accept both legacy {submission,technical,administrative,financial} and CrewAI {submissionChecklist:[strings]}
  const isList = Array.isArray(data)
  const isCrewAi = Array.isArray(data?.submissionChecklist)

  let sections = []

  if (isList) {
    sections = [{ label: 'Checklist de soumission', items: data }]
  } else if (isCrewAi) {
    sections = [{ label: 'Checklist de soumission', items: data.submissionChecklist }]
  } else {
    // Legacy structured checklist
    const cats = [
      { label: 'Pièces de soumission',   key: 'submission'     },
      { label: 'Documents techniques',   key: 'technical'      },
      { label: 'Documents administratifs', key: 'administrative' },
      { label: 'Documents financiers',   key: 'financial'      },
    ]
    sections = cats.map(c => ({ label: c.label, items: toArr(data?.[c.key]) }))
      .filter(s => s.items.length)

    if (!sections.length) {
      sections = [{ label: 'Checklist', items: Object.values(data||{}).flat().filter(Boolean) }]
    }
  }

  const infoBar = (data?.deadline || bon.deadline || data?.caution || bon.caution) ? `<div style="display:flex;gap:16px;background:rgba(30,58,95,.06);border:1px solid rgba(30,58,95,.15);border-radius:4px;padding:7px 12px;font-size:12px;margin-bottom:12px">
  ${(data?.deadline||bon.deadline) ? `<span><strong>Date limite dépôt:</strong> <span style="color:#dc2626;font-weight:700">${e(data?.deadline||bon.deadline)}</span></span>` : ''}
  ${(data?.caution||bon.caution) ? `<span><strong>Caution provisoire:</strong> <span style="color:#ea580c;font-weight:700">${e(data?.caution||bon.caution)}</span></span>` : ''}
</div>` : ''

  const sectionsHtml = sections.map(s => `<div class="section">
  <div class="check-cat">${e(s.label)}</div>
  ${s.items.map(item => {
    const txt = String(item||'').replace(/^[☐✓□]\s*/,'')
    return `<div class="check-item">
      <div class="check-box"></div>
      <div class="check-text">${e(txt)}</div>
    </div>`
  }).join('')}
</div>`).join('')

  const body = `${infoBar}
${sectionsHtml}
<div class="note-box" style="margin-top:8px">⚠ Cette checklist est basée sur l'AVIS officiel. Vérifier les exigences spécifiques dans le CPS avant soumission.</div>
<div style="margin-top:16px;padding:10px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:4px">
  <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:6px">Validation</div>
  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;min-height:40px">
    <div style="border-bottom:1px solid #94a3b8;font-size:11px;color:#64748b">Préparé par</div>
    <div style="border-bottom:1px solid #94a3b8;font-size:11px;color:#64748b">Vérifié par</div>
    <div style="border-bottom:1px solid #94a3b8;font-size:11px;color:#64748b">Date</div>
  </div>
</div>`

  return wrapPage(body, buildMeta(bon, src), {
    typeLabel: 'Checklist de Soumission',
    title:     `Checklist — ${bon.title || ''}`,
    refLine:   `BC: ${bon.id || ''} · Délai: ${bon.deadline || '—'}`,
  })
}

function toArr(v) {
  if (Array.isArray(v)) return v.filter(Boolean)
  if (!v) return []
  if (typeof v === 'string') return v.trim() ? [v] : []
  return Object.values(v).filter(Boolean)
}

module.exports = { render }
