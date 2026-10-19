import { INGREDIENT_PURPOSES } from '../rules/india-label-profile.mjs';

const HEADING = /^\s*ingredients?\s*[:\-]?\s*/i;
const ADVISORY = /\b(?:contains|may\s+contain|processed\s+in|made\s+in)\b/i;

function matchingClose(open) {
  return { '(': ')', '[': ']', '{': '}' }[open];
}

/** Split a label string without splitting commas inside compound ingredients. */
export function splitTopLevel(text) {
  const parts = [];
  let start = 0;
  const stack = [];
  const warnings = [];
  const openers = new Set(['(', '[', '{']);
  const closers = new Set([')', ']', '}']);

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (openers.has(character)) {
      stack.push(character);
      continue;
    }
    if (closers.has(character)) {
      const expected = stack.length ? matchingClose(stack[stack.length - 1]) : null;
      if (expected !== character) {
        warnings.push(`Unexpected closing delimiter “${character}” near character ${index + 1}.`);
      } else {
        stack.pop();
      }
      continue;
    }
    const separator = character === ',' || character === ';' || character === '\n' || character === '\r';
    if (separator && stack.length === 0) {
      const value = text.slice(start, index).trim();
      if (value) parts.push({ value, start, end: index });
      start = index + 1;
    }
  }

  const finalValue = text.slice(start).trim();
  if (finalValue) parts.push({ value: finalValue, start, end: text.length });
  if (stack.length) warnings.push(`Unclosed ${stack.join('')} delimiter in the ingredient text.`);
  return { parts, warnings };
}

function normalizeName(name) {
  return name
    .replace(/\s+/g, ' ')
    .replace(/[.\s]+$/, '')
    .trim()
    .toLocaleLowerCase('en-IN');
}

function purposeFor(name) {
  const normalized = normalizeName(name);
  const match = INGREDIENT_PURPOSES.find((entry) =>
    entry.names.some((candidate) => normalized === candidate || normalized.startsWith(`${candidate} `)),
  );
  return match || {
    explanation: 'The label names this ingredient, but its precise composition may depend on the manufacturer or additive specification.',
    purpose: 'Typical purpose cannot be confirmed from the name alone; check the product specification for a precise interpretation.',
  };
}

function parseNode(part, parentId, index, sourceText, baseOffset) {
  const raw = part.value.trim();
  const percentageMatch = raw.match(/\(\s*(\d+(?:\.\d+)?)\s*%\s*\)\s*$/);
  const percentage = percentageMatch ? Number(percentageMatch[1]) : null;
  const withoutPercentage = percentageMatch ? raw.slice(0, percentageMatch.index).trim() : raw;
  const openIndex = withoutPercentage.indexOf('(');
  let name = withoutPercentage;
  let childText = '';

  if (openIndex > 0) {
    name = withoutPercentage.slice(0, openIndex).trim();
    childText = withoutPercentage.endsWith(')')
      ? withoutPercentage.slice(openIndex + 1, -1).trim()
      : withoutPercentage.slice(openIndex + 1).trim();
  }

  const id = parentId ? `${parentId}.${index + 1}` : `ingredient-${index + 1}`;
  const purpose = purposeFor(name);
  const childResult = childText ? splitTopLevel(childText) : { parts: [], warnings: [] };
  const children = childResult.parts.map((child, childIndex) =>
    parseNode(child, id, childIndex, sourceText, baseOffset + openIndex + 1),
  );
  const sourceStart = baseOffset + (part.start || 0);
  return {
    id,
    order: index + 1,
    parentId: parentId || null,
    raw,
    name: name || raw,
    normalized: normalizeName(name || raw),
    percentage,
    explanation: purpose.explanation,
    purpose: purpose.purpose,
    children,
    sourceSpan: { field: 'ingredientText', start: sourceStart, end: sourceStart + raw.length },
    warnings: childResult.warnings,
  };
}

export function parseIngredients(input) {
  const raw = String(input || '');
  if (!raw.trim()) {
    return { status: 'missing', raw, items: [], warnings: ['No ingredient list was supplied.'], unparsed: '' };
  }

  const withoutHeading = raw.replace(HEADING, '');
  const advisoryMatch = withoutHeading.search(ADVISORY);
  const body = advisoryMatch > 0 ? withoutHeading.slice(0, advisoryMatch).trim() : withoutHeading.trim();
  const result = splitTopLevel(body);
  const items = result.parts.map((part, index) => parseNode(part, null, index, raw, raw.indexOf(body)));
  const warnings = [...result.warnings, ...items.flatMap((item) => item.warnings)];
  return {
    status: warnings.length && !items.length ? 'unreadable' : 'present',
    raw,
    items,
    warnings,
    unparsed: advisoryMatch > 0 ? withoutHeading.slice(advisoryMatch).trim() : '',
  };
}

export function flattenIngredients(items) {
  return items.flatMap((item) => [item, ...flattenIngredients(item.children || [])]);
}
