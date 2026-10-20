import { INDIA_LABEL_PROFILE } from '../rules/india-label-profile.mjs';

const NUTRIENTS = [
  ['added_sugars', ['added sugars', 'added sugar']],
  ['total_sugars', ['total sugars', 'sugars', 'sugar']],
  ['total_carbohydrate', ['total carbohydrate', 'total carbohydrates', 'carbohydrate', 'carbohydrates']],
  ['saturated_fat', ['saturated fat', 'saturates']],
  ['dietary_fibre', ['dietary fibre', 'dietary fiber', 'fibre', 'fiber']],
  ['trans_fat', ['trans fat', 'trans-fat']],
  ['total_fat', ['total fat', 'fat']],
  ['cholesterol', ['cholesterol']],
  ['sodium', ['sodium']],
  ['salt', ['salt']],
  ['protein', ['protein']],
  ['energy', ['energy', 'calories', 'calorie']],
  ['vitamin_d', ['vitamin d']],
  ['calcium', ['calcium']],
  ['iron', ['iron']],
  ['potassium', ['potassium']],
  ['vitamin_a', ['vitamin a']],
  ['vitamin_c', ['vitamin c']],
  ['vitamin_b12', ['vitamin b12', 'vitamin b-12']],
  ['magnesium', ['magnesium']],
  ['zinc', ['zinc']],
];

// Keep the parser's field semantics in the jurisdiction profile. This avoids
// silently applying a US-style required-field list to an Indian label.
const REQUIRED_NUTRIENTS = INDIA_LABEL_PROFILE.nutrition.required;
const OPTIONAL_NUTRIENTS = INDIA_LABEL_PROFILE.nutrition.optional;

const VALUE_PATTERN = /(?:(less\s+than|under|below|<|about|approximately|approx\.?|~)\s*)?(\d+(?:[.,]\d+)?)\s*(kcal|kilocalories?|cal|kj|kilojoules?|g|grams?|mg|milligrams?|mcg|μg|µg|%)/giu;
const NUMBER_PATTERN = /(?:(less\s+than|under|below|<|about|approximately|approx\.?|~)\s*)?(\d+(?:[.,]\d+)?)\s*(kcal|kilocalories?|cal|kj|kilojoules?|g|grams?|mg|milligrams?|mcg|μg|µg|%)/giu;

const UNIT_ALIASES = {
  kcal: 'kcal',
  kilocalorie: 'kcal',
  kilocalories: 'kcal',
  cal: 'kcal',
  calorie: 'kcal',
  calories: 'kcal',
  kj: 'kJ',
  kilojoule: 'kJ',
  kilojoules: 'kJ',
  g: 'g',
  gram: 'g',
  grams: 'g',
  mg: 'mg',
  milligram: 'mg',
  milligrams: 'mg',
  mcg: 'µg',
  μg: 'µg',
  µg: 'µg',
  '%': '%',
};

function canonicalUnit(unit) {
  return UNIT_ALIASES[String(unit).toLocaleLowerCase('en-IN')] || unit;
}

function numberValue(value) {
  return Number(String(value).replace(',', '.'));
}

function basisFromText(text) {
  const value = String(text || '').toLocaleLowerCase('en-IN');
  if (/per\s*100\s*(?:g|gram|grams)/i.test(value)) return 'per_100g';
  if (/per\s*100\s*(?:ml|millilitre|milliliter)/i.test(value)) return 'per_100ml';
  if (/per\s*(?:serving|serve|portion)/i.test(value)) return 'per_serving';
  if (/per\s*(?:container|pack|package)/i.test(value)) return 'per_container';
  return null;
}

function unitToDisplay(unit) {
  return unit === 'kJ' ? 'kJ' : unit;
}

function parseValueToken(match, line, basis, sourceStart, index, totalTokens) {
  const qualifier = (match[1] || '').toLocaleLowerCase('en-IN');
  const amount = numberValue(match[2]);
  const unit = canonicalUnit(match[3]);
  const bounded = ['less than', 'under', 'below', '<'].includes(qualifier);
  const approximate = ['about', 'approximately', 'approx.', '~'].includes(qualifier);
  const certainty = bounded ? 'bounded' : approximate ? 'approximate' : totalTokens > 1 && unit !== '%' ? 'ambiguous' : 'displayed_rounded';
  const value = {
    amount: bounded ? null : amount,
    lower: bounded ? 0 : amount,
    upper: bounded ? amount : amount,
    upperExclusive: bounded,
    displayAmount: bounded ? `${qualifier} ${amount}` : String(amount),
    unit: unitToDisplay(unit),
    raw: line.trim(),
    basis: basis || 'unknown',
    certainty,
    declared: true,
    derived: false,
    sourceSpan: { field: 'nutritionText', start: sourceStart, end: sourceStart + line.length },
    tokenIndex: index,
  };
  return value;
}

function nutrientForLine(line) {
  const normalized = line.toLocaleLowerCase('en-IN');
  if (/serv(?:ing)?\s+size|servings?\s+per\s+container/.test(normalized)) return null;
  for (const [nutrient, aliases] of NUTRIENTS) {
    if (aliases.some((alias) => new RegExp(`(^|[^a-z])${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^a-z])`, 'i').test(normalized))) {
      return nutrient;
    }
  }
  return null;
}

function extractServing(text) {
  const serving = {};
  const sizeMatch = String(text).match(/serv(?:ing)?\s*size\s*[:\-]?\s*([^\n;]+)/i);
  if (sizeMatch) {
    const metric = sizeMatch[1].match(/(\d+(?:[.,]\d+)?)\s*(g|grams?|ml|millilit(?:re|er)s?|kg|l)\b/i);
    serving.sizeText = sizeMatch[1].trim().replace(/[,)]+$/, '');
    if (metric) {
      serving.amount = numberValue(metric[1]);
      serving.unit = /^ml|millilit/i.test(metric[2]) ? 'ml' : /^l$/i.test(metric[2]) ? 'l' : /^kg$/i.test(metric[2]) ? 'kg' : 'g';
    }
  }
  const servingsMatch = String(text).match(/servings?\s+per\s+(?:container|pack|package)\s*[:\-]?\s*(about\s+)?(\d+(?:[.,]\d+)?)/i)
    || String(text).match(/(?:about\s+)?(\d+(?:[.,]\d+)?)\s+servings?\s+per\s+(?:container|pack|package)/i);
  if (servingsMatch) {
    const numberToken = servingsMatch.find((token, index) => index > 0 && token && /^\d/.test(token.replace(',', '.')));
    serving.servingsPerContainer = numberValue(numberToken || servingsMatch[1]);
    serving.servingsApproximate = /about/i.test(servingsMatch[0]);
  }
  return serving;
}

function splitLines(text) {
  const lines = String(text).split(/\r?\n|\s*;\s*/).map((line) => line.trim()).filter(Boolean);
  return lines.length ? lines : [String(text).trim()];
}

function addDerivedEnergy(values, warnings) {
  const byBasis = new Map();
  for (const value of values.filter((item) => item.nutrient === 'energy' && item.declared)) {
    const key = value.basis;
    if (!byBasis.has(key)) byBasis.set(key, []);
    byBasis.get(key).push(value);
  }
  for (const [basis, entries] of byBasis) {
    const kcal = entries.find((entry) => entry.unit === 'kcal');
    const kj = entries.find((entry) => entry.unit === 'kJ');
    if (kcal?.amount !== null && kcal && kj?.amount !== null && kj) {
      const expectedKj = kcal.amount * 4.184;
      const difference = Math.abs(kj.amount - expectedKj);
      if (difference > Math.max(5, expectedKj * 0.02)) {
        warnings.push(`Declared energy values for ${basis} do not reconcile within 2%: ${kcal.amount} kcal converts to about ${expectedKj.toFixed(1)} kJ, while ${kj.amount} kJ was shown. Verify the image.`);
      }
    }
    if (kcal && !kj && kcal.amount !== null) {
      values.push({
        ...kcal,
        amount: Math.round(kcal.amount * 4.184 * 10000) / 10000,
        lower: Math.round(kcal.lower * 4.184 * 10000) / 10000,
        upper: Math.round(kcal.upper * 4.184 * 10000) / 10000,
        displayAmount: (kcal.amount * 4.184).toFixed(1),
        unit: 'kJ',
        declared: false,
        derived: true,
        certainty: 'derived',
        raw: `Derived from declared ${kcal.amount} kcal using 1 kcal = 4.184 kJ`,
        derivation: '1 kcal = 4.184 kJ',
        basis,
      });
      warnings.push(`kJ was not visible for ${basis}; a clearly marked conversion from kcal is shown.`);
    }
    if (kj && !kcal && kj.amount !== null) {
      values.push({
        ...kj,
        amount: Math.round((kj.amount / 4.184) * 10000) / 10000,
        lower: Math.round((kj.lower / 4.184) * 10000) / 10000,
        upper: Math.round((kj.upper / 4.184) * 10000) / 10000,
        displayAmount: (kj.amount / 4.184).toFixed(1),
        unit: 'kcal',
        declared: false,
        derived: true,
        certainty: 'derived',
        raw: `Derived from declared ${kj.amount} kJ using 1 kcal = 4.184 kJ`,
        derivation: '1 kcal = 4.184 kJ',
        basis,
      });
      warnings.push(`kcal was not visible for ${basis}; a clearly marked conversion from kJ is shown.`);
    }
  }
}

export function parseNutrition(input) {
  const raw = String(input || '');
  if (!raw.trim()) {
    return { status: 'missing', raw, serving: {}, values: [], missing: [...REQUIRED_NUTRIENTS], optionalMissing: [...OPTIONAL_NUTRIENTS], warnings: ['No nutrition panel was supplied.'], otherVisible: [] };
  }

  const serving = extractServing(raw);
  const lines = splitLines(raw);
  let currentBasis = basisFromText(raw.match(/(?:per\s*100\s*(?:g|ml)|per\s*(?:serving|container))/i)?.[0]) || null;
  const values = [];
  const warnings = [];
  const otherVisible = [];
  let sawNutrient = false;

  lines.forEach((line) => {
    const lower = line.toLocaleLowerCase('en-IN');
    const explicitBasis = basisFromText(line);
    if (/^per\s+/i.test(line) && !nutrientForLine(line)) {
      currentBasis = explicitBasis || currentBasis;
      return;
    }
    if (explicitBasis) currentBasis = explicitBasis;
    const nutrient = nutrientForLine(line);
    if (!nutrient) {
      const otherTokens = [...line.matchAll(VALUE_PATTERN)];
      if (otherTokens.length) {
        const firstAmount = otherTokens.find((match) => canonicalUnit(match[3]) !== '%');
        const displayName = otherTokens.reduce((label, match) => label.replace(match[0], ''), line).trim();
        otherVisible.push({
          nutrient: 'other_visible',
          displayName: displayName || 'Other visible value',
          amount: firstAmount ? numberValue(firstAmount[2]) : null,
          lower: firstAmount ? numberValue(firstAmount[2]) : null,
          upper: firstAmount ? numberValue(firstAmount[2]) : null,
          displayAmount: firstAmount ? String(numberValue(firstAmount[2])) : 'value shown',
          unit: firstAmount ? canonicalUnit(firstAmount[3]) : null,
          raw: line,
          basis: explicitBasis || currentBasis || (serving.amount ? 'per_serving' : 'unknown'),
          certainty: 'displayed_rounded',
          declared: true,
          derived: false,
          sourceSpan: { field: 'nutritionText', start: raw.indexOf(line), end: raw.indexOf(line) + line.length },
        });
      }
      return;
    }
    sawNutrient = true;

    const notSignificant = /not\s+(?:a\s+)?significant\s+source/i.test(lower);
    if (notSignificant) {
      values.push({
        nutrient,
        amount: null,
        lower: 0,
        upper: null,
        displayAmount: 'not a significant source',
        unit: null,
        raw: line,
        basis: explicitBasis || currentBasis || 'unknown',
        certainty: 'not_significant',
        declared: true,
        derived: false,
        sourceSpan: { field: 'nutritionText', start: raw.indexOf(line), end: raw.indexOf(line) + line.length },
      });
      return;
    }

    const tokens = [...line.matchAll(VALUE_PATTERN)];
    const amountTokens = tokens.filter((match) => canonicalUnit(match[3]) !== '%');
    const percentToken = tokens.find((match) => canonicalUnit(match[3]) === '%');
    if (amountTokens.length === 0 && nutrient === 'energy') {
      const numberOnly = line.match(/(?:^|\s)(\d+(?:[.,]\d+)?)(?:\s|$)/);
      if (numberOnly) {
        const number = numberValue(numberOnly[1]);
        values.push({
          nutrient,
          amount: number,
          lower: number,
          upper: number,
          displayAmount: String(number),
          unit: 'kcal',
          raw: line,
          basis: explicitBasis || currentBasis || (serving.amount ? 'per_serving' : 'unknown'),
          certainty: 'ambiguous',
          declared: true,
          derived: false,
          warning: 'Energy had no visible unit; kcal is a cautious interpretation and needs image verification.',
        });
        warnings.push(`Energy row “${line}” had no visible unit; it was not confidently identified as kcal.`);
      }
    } else if (amountTokens.length) {
      const basis = explicitBasis || currentBasis || (serving.amount ? 'per_serving' : 'unknown');
      amountTokens.forEach((match, index) => {
        const value = parseValueToken(match, line, basis, raw.indexOf(line), index, amountTokens.length);
        value.nutrient = nutrient;
        const dualEnergy = nutrient === 'energy' && amountTokens.every((token) => ['kcal', 'kJ'].includes(canonicalUnit(token[3])));
        if (dualEnergy) value.certainty = 'displayed_rounded';
        if (percentToken) value.declaredDv = numberValue(percentToken[2]);
        if (amountTokens.length > 1 && !dualEnergy) value.warning = 'More than one amount was visible on this row; the column basis needs image verification.';
        values.push(value);
      });
      if (amountTokens.length > 1 && !(nutrient === 'energy' && amountTokens.every((token) => ['kcal', 'kJ'].includes(canonicalUnit(token[3]))))) {
        warnings.push(`The ${nutrient.replaceAll('_', ' ')} row contains multiple amount columns.`);
      }
    }
  });

  addDerivedEnergy(values, warnings);
  const present = new Set(values.map((value) => value.nutrient));
  const missing = REQUIRED_NUTRIENTS.filter((nutrient) => !present.has(nutrient));
  const optionalMissing = OPTIONAL_NUTRIENTS.filter((nutrient) => !present.has(nutrient));
  if (missing.length) warnings.push(`These required Indian label fields were not readable or not declared: ${missing.map((item) => item.replaceAll('_', ' ')).join(', ')}.`);
  const status = !sawNutrient ? 'unreadable' : missing.length ? 'partial' : 'present';

  return { status, raw, serving, values, missing, optionalMissing, warnings, otherVisible };
}

export function valueFor(nutrition, nutrient, basis = null, unit = null) {
  return (nutrition?.values || []).find((value) =>
    value.nutrient === nutrient && (!basis || value.basis === basis) && (!unit || value.unit === unit),
  ) || null;
}

export function calculateEnergyForQuantity(nutrition, quantity, unit) {
  const amount = Number(quantity);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const requestedUnit = unit === 'ml' ? 'per_100ml' : 'per_100g';
  const perHundred = valueFor(nutrition, 'energy', requestedUnit, 'kcal');
  if (perHundred?.amount != null) {
    return { kcal: perHundred.amount * amount / 100, basis: requestedUnit, method: `(${perHundred.amount} kcal ÷ 100) × ${amount} ${unit}` };
  }
  const perServing = valueFor(nutrition, 'energy', 'per_serving', 'kcal');
  const serving = nutrition?.serving;
  if (perServing?.amount != null && serving?.amount && serving.unit === unit) {
    return { kcal: perServing.amount * amount / serving.amount, basis: 'per_serving', method: `(${perServing.amount} kcal ÷ ${serving.amount} ${unit}) × ${amount} ${unit}` };
  }
  return null;
}

export { REQUIRED_NUTRIENTS, OPTIONAL_NUTRIENTS, NUTRIENTS };
