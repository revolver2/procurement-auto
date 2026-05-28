'use strict'

function groundingBlock(bon) {
  if (bon.officialText) {
    const text = bon.officialText.substring(0, 3500)
    return `
=== TEXTE OFFICIEL DE L'AVIS (SOURCE UNIQUE AUTORISÉE) ===
Document: ${bon.officialTextName || 'AVIS joint officiel'}
---
${text}
---
FIN DU TEXTE OFFICIEL
==========================================================
RÈGLE ABSOLUE: Analyse UNIQUEMENT ce texte. Pour toute information (matériaux, dimensions, quantités, délais, localisation) NON mentionnée dans ce texte, écris exactement: "Non précisé dans l'avis joint."
N'invente rien. Ne suppose rien. N'utilise aucune connaissance extérieure au document.
Source: ${bon.officialTextName || 'AVIS joint officiel'}
`
  }
  return `
⚠️ AVIS joint non disponible — analyse basée uniquement sur les métadonnées du bon de commande.
Toutes les informations manquantes doivent figurer dans le champ "missingInfo".
`
}

module.exports = { groundingBlock }
