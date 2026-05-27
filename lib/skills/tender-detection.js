'use strict'

/* ── Keyword maps per activity ───────────────────────────────────── */
const ACTIVITY_MAP = {
  aluminium: {
    label: 'Aluminium / Menuiserie',
    keywords: ['aluminium','aluminum','alucobond','chassis aluminium','menuiserie aluminium',
      'facade aluminium','habillage aluminium','fenetre aluminium','porte aluminium',
      'pergola aluminium','garde-corps','garde corps','profile aluminium'],
  },
  inox: {
    label: 'Inox / Acier inoxydable',
    keywords: ['inox','acier inoxydable','garde-corps inox','main courante','rampe inox',
      'escalier inox','grille inox','paroi inox','tube inox'],
  },
  metal: {
    label: 'Métal / Charpente métallique',
    keywords: ['metallique','metal','charpente metallique','structure metallique',
      'construction metallique','escalier metallique','rideau metallique','abri metallique',
      'ferronnerie','serrurerie','faux plafond metallique','hangar metallique'],
  },
  fourniture: {
    label: 'Fourniture et pose',
    keywords: ['fourniture et pose','fourniture et installation','fourniture et montage',
      'fourniture pose','supply and install'],
  },
  vitrage: {
    label: 'Vitrage / Vitrerie',
    keywords: ['vitrage','vitre','double vitrage','vitree','vitrerie','verre securit',
      'film solaire','miroiterie'],
  },
  panneaux: {
    label: 'Panneaux sandwich / Composites',
    keywords: ['panneaux sandwich','panneau composite','panneau alucobond','bardage',
      'isolation thermique','panneau isolant'],
  },
  cloison: {
    label: 'Cloisons / Faux plafonds',
    keywords: ['cloison','cloison amovible','faux plafond','plafond suspendu',
      'plancher','mezzanine'],
  },
}

function norm(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
}

function daysUntil(deadline) {
  if (!deadline) return null
  try {
    let dl
    if (deadline.includes('/')) {
      const [d, m, y] = deadline.split('/')
      dl = new Date(`${y}-${m}-${d}`)
    } else {
      dl = new Date(deadline)
    }
    const days = Math.ceil((dl - Date.now()) / 86400000)
    return isNaN(days) ? null : days
  } catch { return null }
}

function analyze(bon) {
  const text = norm([
    bon.title, bon.description, bon.specifications,
    bon.category, bon.naturePrestation, bon.destination,
    bon.buyer, bon.rawTextSnapshot,
  ].join(' '))

  // Score each activity
  const matches = []
  for (const [id, { label, keywords }] of Object.entries(ACTIVITY_MAP)) {
    const matched = keywords.filter(kw => text.includes(norm(kw)))
    if (matched.length > 0) {
      matches.push({ id, label, keywords: matched, score: matched.length })
    }
  }
  matches.sort((a, b) => b.score - a.score)

  const relevanceScore = Math.min(100, matches.reduce((s, m) => s + m.score * 15, 0))
  const urgencyDays    = daysUntil(bon.deadline)
  const urgencyLevel   = urgencyDays === null ? 'unknown'
    : urgencyDays <= 0  ? 'expired'
    : urgencyDays <= 3  ? 'critical'
    : urgencyDays <= 7  ? 'high'
    : urgencyDays <= 14 ? 'medium'
    : 'low'

  return {
    relevanceScore,
    primaryActivity: matches[0]?.id    || null,
    primaryLabel:    matches[0]?.label || null,
    allMatches:      matches,
    matchedKeywords: matches.flatMap(m => m.keywords),
    urgencyDays,
    urgencyLevel,
    projectType:     inferProjectType(text, matches),
    isRelevant:      matches.length > 0 && relevanceScore >= 15,
  }
}

function inferProjectType(text, matches) {
  if (text.includes('facade') || text.includes('habillage'))          return 'facade'
  if (text.includes('charpente'))                                      return 'charpente'
  if (text.includes('garde-corps') || text.includes('garde corps'))   return 'garde-corps'
  if (text.includes('menuiserie'))                                     return 'menuiserie'
  if (text.includes('toiture') || text.includes('couverture'))        return 'toiture'
  if (text.includes('cloison'))                                        return 'cloison'
  if (text.includes('pergola') || text.includes('abri'))              return 'pergola-abri'
  if (text.includes('escalier'))                                       return 'escalier'
  if (text.includes('vitrage') || text.includes('vitre'))             return 'vitrage'
  if (text.includes('panneaux sandwich') || text.includes('bardage')) return 'bardage'
  return matches[0]?.id ? `${matches[0].id}-general` : 'general'
}

module.exports = { analyze, ACTIVITY_MAP }
