const ALLERGEN_ALIASES = {
  'cereals containing gluten': ['wheat', 'wheat flour', 'maida', 'atta', 'barley', 'rye', 'oat', 'oats', 'malt'],
  crustaceans: ['crab', 'lobster', 'prawn', 'shrimp', 'crustacean'],
  eggs: ['egg', 'eggs', 'albumin', 'ovalbumin', 'mayonnaise'],
  fish: ['fish', 'anchovy', 'tuna', 'salmon', 'sardine', 'cod'],
  peanuts: ['peanut', 'peanuts', 'groundnut', 'groundnuts', 'arachis'],
  soybeans: ['soy', 'soya', 'soybean', 'soybeans', 'tofu', 'tempeh', 'edamame'],
  milk: ['milk', 'whey', 'casein', 'caseinate', 'lactose', 'butter', 'ghee', 'cream', 'cheese', 'curd', 'paneer'],
  'tree nuts': ['almond', 'cashew', 'walnut', 'pistachio', 'hazelnut', 'pecan', 'macadamia', 'brazil nut', 'chestnut'],
  sesame: ['sesame', 'til', 'tahini'],
  sulphites: ['sulphite', 'sulfite', 'sulphur dioxide', 'sulfur dioxide', 'e220', 'e221', 'e222', 'e223', 'e224', 'e226', 'e227', 'e228'],
};

const CLAIM_PATTERNS = [
  /\b(?:vegan|vegetarian|halal|kosher|organic|natural|no\s+added\s+sugar|sugar[- ]free|trans[- ]fat[- ]free|gluten[- ]free|dairy[- ]free|nut[- ]free|high\s+protein|source\s+of\s+fibr(?:e|er))\b/gi,
  /\b(?:and\/or|one\s+or\s+more\s+of\s+the\s+following|flavou?r(?:ing)?|colour(?:ing)?)\b/gi,
];

function normalize(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLocaleLowerCase('en-IN')
    .replace(/[^\p{L}\p{N}%]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function aliasRegex(alias) {
  return new RegExp(`(^|[^\\p{L}\\p{N}])${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\p{L}\\p{N}])`, 'iu');
}

function findAlias(text, aliases) {
  const normalized = normalize(text);
  for (const alias of aliases) {
    if (aliasRegex(alias).test(normalized)) return alias;
  }
  return null;
}

function finding(allergen, status, evidenceType, matchedText, sourceField, explanation) {
  return { allergen, status, evidenceType, matchedText, sourceField, confidence: status === 'present' ? 'high' : 'medium', explanation };
}

export function extractAllergens(ingredientResult, containsText = '') {
  const ingredientText = ingredientResult?.raw || '';
  const explicitText = String(containsText || '').trim();
  const findings = [];

  for (const [allergen, aliases] of Object.entries(ALLERGEN_ALIASES)) {
    let ingredientAlias = findAlias(ingredientText, aliases);
    // Cocoa butter is a cocoa fat, not dairy butter. Keep this distinction
    // explicit so a common compound ingredient is not silently mislabelled.
    if (allergen === 'milk' && ingredientAlias === 'butter' && /\bcocoa\s+butter\b/i.test(ingredientText)) ingredientAlias = null;
    if (ingredientAlias) {
      findings.push(finding(
        allergen,
        'present',
        'ingredient',
        ingredientAlias,
        'ingredientText',
        `The ingredient text contains “${ingredientAlias}”, an alias associated with ${allergen}.`,
      ));
    }

    if (explicitText) {
      const advisory = /\b(?:may\s+contain|processed\s+in|made\s+in\s+(?:a|the)\s+same\s+facility)\b/i.test(explicitText);
      const explicitAlias = findAlias(explicitText, aliases);
      if (explicitAlias) {
        const status = advisory ? 'precautionary' : 'present';
        findings.push(finding(
          allergen,
          status,
          advisory ? 'precautionary_statement' : 'contains_statement',
          explicitAlias,
          'containsText',
          advisory
            ? `The advisory text mentions “${explicitAlias}”; this is a cross-contact warning, not confirmation that it is an ingredient.`
            : `The label’s allergen statement declares ${allergen}.`,
        ));
      }
    }
  }

  const deduped = new Map();
  for (const item of findings) {
    const key = `${item.allergen}:${item.status}`;
    if (!deduped.has(key) || deduped.get(key).evidenceType === 'ingredient') deduped.set(key, item);
  }

  return {
    findings: [...deduped.values()],
    declaredText: explicitText,
    status: ingredientResult?.status === 'missing' && !explicitText ? 'unknown' : 'assessed',
    notDetected: ingredientResult?.status === 'present'
      ? Object.keys(ALLERGEN_ALIASES).filter((allergen) => ![...deduped.values()].some((item) => item.allergen === allergen))
      : [],
  };
}

export function findInvestigationFlags(text) {
  const source = String(text || '');
  const matches = [];
  for (const pattern of CLAIM_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      matches.push({
        text: match[0],
        reason: 'This claim or collective wording needs the manufacturer’s evidence and the full label context; it is not independently verified here.',
      });
    }
  }
  return matches.filter((item, index, list) => list.findIndex((candidate) => candidate.text.toLocaleLowerCase() === item.text.toLocaleLowerCase()) === index);
}

export { ALLERGEN_ALIASES };
