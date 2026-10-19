export function parseValidatorJson(text) {
  const fenced = String(text || '').match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('Validator did not return a JSON object.');
  return JSON.parse(candidate.slice(start, end + 1));
}

function normalizeText(text) {
  return String(text || '')
    .toLocaleLowerCase('en-IN')
    .replace(/[“”‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function canonicalFacts(parsed) {
  if (!Array.isArray(parsed?.facts)) return null;
  return parsed.facts.map((fact, index) => {
    const key = String(fact.key || `fact_${index + 1}`).trim().toLocaleLowerCase('en-IN');
    const value = String(fact.value ?? '').trim().toLocaleLowerCase('en-IN');
    const ingredientFact = key.startsWith('ingredient_') || key === value;
    return {
      // Ingredient validators may use either ingredient_1 or the ingredient
      // name as the key. Order plus visible value is the stable evidence.
      key: ingredientFact ? '' : key,
      value,
      unit: ingredientFact ? '' : String(fact.unit ?? '').trim().toLocaleLowerCase('en-IN'),
      basis: ingredientFact ? '' : String(fact.basis ?? '').trim().toLocaleLowerCase('en-IN'),
    };
  });
}

function consensusFromFacts(kind, facts) {
  if (!facts?.length) return '';
  if (kind === 'ingredients') {
    return `Ingredients: ${facts.map((fact) => fact.value).join(', ')}`;
  }
  return facts.map((fact) => {
    const label = fact.key || 'Visible value';
    const amount = [fact.value, fact.unit].filter(Boolean).join(' ');
    const basis = fact.basis && fact.basis !== 'unknown' ? ` (${fact.basis})` : '';
    return `${label}: ${amount}${basis}`;
  }).join('\n');
}

export function compareValidatorResults(results, { kind = 'label', ocrText = '' } = {}) {
  const valid = results.filter((result) => result.status === 'ok');
  if (valid.length < 2) {
    return {
      status: 'unavailable',
      conflicts: ['Two valid validator responses were not available. The OCR transcription remains the source for analysis.'],
      correctionStatus: 'unavailable',
      consensusText: null,
    };
  }
  const first = canonicalFacts(valid[0].parsed);
  const second = canonicalFacts(valid[1].parsed);
  if (!first || !second) {
    return {
      status: 'conflict',
      conflicts: ['One or both validators returned JSON without the required facts array.'],
      correctionStatus: 'needs_review',
      consensusText: null,
    };
  }
  const conflicts = [];
  const length = Math.max(first.length, second.length);
  for (let index = 0; index < length; index += 1) {
    const left = first[index];
    const right = second[index];
    if (JSON.stringify(left) !== JSON.stringify(right)) {
      conflicts.push({ index: index + 1, validatorA: left || null, validatorB: right || null });
    }
  }
  const correctedTexts = valid.map((result) => String(result.parsed.corrected_text || '').trim()).filter(Boolean);
  const correctedTextAgrees = correctedTexts.length === 2 && normalizeText(correctedTexts[0]) === normalizeText(correctedTexts[1]);
  const agreedFacts = conflicts.length ? [] : first;
  // For document extraction, the complete corrected transcription is stronger
  // than cosmetic schema differences such as `total_fat` vs `Total fat` or
  // `kcal` vs `kcal (565 kJ)`. If both independent models return the same
  // image-supported transcription, that is an agreement even when their
  // structured labels are formatted differently.
  const textualAgreement = correctedTextAgrees;
  const agreement = textualAgreement || conflicts.length === 0;
  const consensusText = !agreement
    ? null
    : textualAgreement
      ? correctedTexts[0]
      : consensusFromFacts(kind, agreedFacts);
  const correctionStatus = !agreement
    ? 'needs_review'
    : normalizeText(consensusText) === normalizeText(ocrText)
      ? 'no_change'
      : 'confirmed_correction';
  return {
    status: agreement ? 'agreement' : 'conflict',
    conflicts: agreement ? [] : conflicts,
    factConflicts: agreement && conflicts.length ? conflicts : [],
    agreedFacts: agreement ? agreedFacts : [],
    correctedTexts,
    correctedTextAgrees,
    correctionStatus,
    consensusText,
  };
}
