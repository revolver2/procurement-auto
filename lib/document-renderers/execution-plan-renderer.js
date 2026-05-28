'use strict'
const { wrapPage, buildMeta, e, mv } = require('./shared-template')

function render(bon, data, src = {}) {
  // Accept both legacy {phases:[]} and CrewAI {executionPlan:[strings]} formats
  const phases  = data?.phases         || []
  const planStr = data?.executionPlan  || []
  const total   = data?.totalDuration  || bon.deadline || '—'
  const milestones = data?.milestones  || []
  const risks      = data?.risks       || []

  let phasesHtml = ''

  if (phases.length) {
    // Structured phases from document-generator
    phasesHtml = phases.map(p => {
      const deps = (p.dependencies || []).filter(Boolean)
      const res  = (p.resources    || []).filter(Boolean)
      return `<div class="phase-row">
  <div class="phase-num">${e(String(p.phase||''))}</div>
  <div class="phase-body">
    <div class="phase-name">${e(p.name||'')}</div>
    <div class="phase-desc">${e(p.description||'')}</div>
    <div class="phase-meta">
      ${p.duration ? `<span class="phase-tag">⏱ ${e(p.duration)}</span>` : ''}
      ${deps.length ? `<span class="phase-tag">↳ ${deps.map(d=>e(d)).join(', ')}</span>` : ''}
      ${res.length  ? `<span class="phase-tag">👥 ${res.map(r=>e(r)).join(', ')}</span>` : ''}
    </div>
  </div>
</div>`
    }).join('')
  } else if (planStr.length) {
    // String phases from CrewAI (e.g. "Phase 1 — Préparation: ...")
    phasesHtml = planStr.map((line, i) => {
      const match = String(line).match(/^Phase\s*(\d+)\s*[—\-–:]\s*(.+?)(?:[:\-–]\s*(.*))?$/)
      const num   = match ? match[1] : String(i+1)
      const name  = match ? match[2] : ''
      const desc  = match ? (match[3] || '') : String(line)
      return `<div class="phase-row">
  <div class="phase-num">${e(num)}</div>
  <div class="phase-body">
    <div class="phase-name">${e(name || desc)}</div>
    ${(name && desc) ? `<div class="phase-desc">${e(desc)}</div>` : ''}
  </div>
</div>`
    }).join('')
  }

  const milestonesHtml = milestones.length ? `<div class="section">
  <div class="section-title"><span class="dot"></span> Jalons Clés</div>
  <ul style="margin-left:16px;font-size:13px;line-height:1.8">${milestones.map(m=>`<li>${e(String(m))}</li>`).join('')}</ul>
</div>` : ''

  const risksHtml = risks.length ? `<div class="section">
  <div class="section-title"><span class="dot"></span> Points de Vigilance</div>
  <ul style="margin-left:16px;font-size:13px;line-height:1.8">${risks.slice(0,5).map(r=>`<li>${e(String(r))}</li>`).join('')}</ul>
</div>` : ''

  const body = `<div class="section">
  <div class="section-title"><span class="dot"></span> Plan d'Exécution du Chantier</div>
  <div style="background:rgba(30,58,95,.06);border:1px solid rgba(30,58,95,.15);border-radius:4px;padding:7px 12px;font-size:12px;margin-bottom:12px;display:flex;justify-content:space-between">
    <span><strong>Projet:</strong> ${e(bon.title||'—')}</span>
    <span><strong>Durée totale estimée:</strong> ${e(total)}</span>
  </div>
  ${phasesHtml || `<div style="padding:20px;text-align:center;color:#94a3b8">Aucune phase définie</div>`}
</div>
${milestonesHtml}
${risksHtml}`

  return wrapPage(body, buildMeta(bon, src), {
    typeLabel: "Plan d'Exécution",
    title:     `Plan d'Exécution — ${bon.title || ''}`,
    refLine:   `BC: ${bon.id || ''} · ${bon.location || bon.city || ''}`,
  })
}

module.exports = { render }
