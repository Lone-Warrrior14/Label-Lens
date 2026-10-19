export function parseValidatorJson(text) {
  const fenced = String(text || '').match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('Validator did not return a JSON object.');
  return JSON.parse(candidate.slice(start, end + 1));
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

export function compareValidatorResults(results) {
  const valid = results.filter((result) => result.status === 'ok');
  if (valid.length < 2) {
    return {
      status: 'unavailable',
      conflicts: ['Two valid validator responses were not available. The OCR transcription remains the source for analysis.'],
    };
  }
  const first = canonicalFacts(valid[0].parsed);
  const second = canonicalFacts(valid[1].parsed);
  if (!first || !second) {
    return {
      status: 'conflict',
      conflicts: ['One or both validators returned JSON without the required facts array.'],
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
  return {
    status: conflicts.length ? 'conflict' : 'agreement',
    conflicts,
    agreedFacts: conflicts.length ? [] : first,
  };
}
