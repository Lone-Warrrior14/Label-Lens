export function parseValidatorJson(text) {
  const fenced = String(text || '').match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('Validator did not return a JSON object.');
  return JSON.parse(candidate.slice(start, end + 1));
}

const HEADER_TYPES = new Set(['section', 'serving', 'column', 'advisory', 'other']);

export function normalizeValidatorPayload(value) {
  const source = value && typeof value === 'object' ? value : {};
  const sectionStatus = ['present', 'partial', 'unreadable'].includes(source.section_status)
    ? source.section_status
    : 'partial';
  const headers = Array.isArray(source.headers) ? source.headers.map((header) => ({
    name: String(header?.name ?? '').trim(),
    value: String(header?.value ?? '').trim(),
    type: HEADER_TYPES.has(header?.type) ? header.type : 'other',
    evidence: String(header?.evidence ?? '').trim(),
  })).filter((header) => header.name || header.value || header.evidence) : [];
  const facts = Array.isArray(source.facts) ? source.facts.map((fact, index) => ({
    key: String(fact?.key || `fact_${index + 1}`).trim(),
    value: String(fact?.value ?? '').trim(),
    unit: String(fact?.unit ?? '').trim(),
    basis: String(fact?.basis || 'unknown').trim(),
    values: Array.isArray(fact?.values) ? fact.values.map((item) => ({
      amount: String(item?.amount ?? '').trim(),
      unit: String(item?.unit ?? '').trim(),
      basis: String(item?.basis || 'unknown').trim(),
      percent_rda: String(item?.percent_rda ?? '').trim(),
      evidence: String(item?.evidence ?? '').trim(),
    })).filter((item) => item.amount || item.percent_rda || item.evidence) : [],
    evidence: String(fact?.evidence ?? '').trim(),
  })).filter((fact) => fact.key || fact.value || fact.evidence) : [];
  return {
    section_status: sectionStatus,
    section_header: String(source.section_header ?? '').trim(),
    headers,
    corrected_text: String(source.corrected_text ?? '').trim(),
    facts,
    warnings: Array.isArray(source.warnings) ? source.warnings.map((warning) => String(warning).trim()).filter(Boolean) : [],
  };
}

function basisGroup(value) {
  const basis = String(value?.basis || '').toLocaleLowerCase('en-IN');
  if (/100\s*(?:g|gram)/i.test(basis)) return 'per_100g';
  if (/100\s*(?:ml|millilit)/i.test(basis)) return 'per_100ml';
  if (/serve|portion/i.test(basis)) return 'per_serving';
  if (/container|pack/i.test(basis)) return 'per_container';
  if (/rda|dv|daily/i.test(basis)) return 'dv';
  return 'unknown';
}

function nutritionLabelForRow(label) {
  const normalized = String(label || '').toLocaleLowerCase('en-IN').replace(/[^a-z]+/g, '');
  const aliases = [
    ['energy', 'Energy (kcal)', 'kcal'],
    ['protein', 'Protein (g)', 'g'],
    ['garbohydrate', 'Carbohydrate (g)', 'g'],
    ['carbohydrate', 'Carbohydrate (g)', 'g'],
    ['totalsugars', 'Total Sugars (g)', 'g'],
    ['addedsugars', 'Added Sugars (g)', 'g'],
    ['tomlfat', 'Total Fat (g)', 'g'],
    ['totalfat', 'Total Fat (g)', 'g'],
    ['saturatedfat', 'Saturated Fat (g)', 'g'],
    ['fransfat', 'Trans Fat (g)', 'g'],
    ['transfat', 'Trans Fat (g)', 'g'],
    ['dietaryfibre', 'Dietary Fibre (g)', 'g'],
    ['dietaryfiber', 'Dietary Fibre (g)', 'g'],
    ['salt', 'Salt (g)', 'g'],
    ['cholesterol', 'Cholesterol (mg)', 'mg'],
    ['sodum', 'Sodium (mg)', 'mg'],
    ['sodium', 'Sodium (mg)', 'mg'],
  ];
  return aliases.find(([alias]) => normalized.includes(alias)) || null;
}

function numberFromCell(cell) {
  const match = String(cell || '').match(/(?:<|≤|about\s*)?\s*(\d+(?:[.,]\d+)?)/);
  return match ? Number(match[1].replace(',', '.')) : null;
}

function formatNumber(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  return String(Number(value.toFixed(4)));
}

function valueFromStrippedCell(cell, reference, ratio = null) {
  const direct = numberFromCell(cell);
  if (direct === null) return '';
  if (/[.,]/.test(String(cell))) return formatNumber(direct);
  const candidates = [0, 1, 2, 3, 4].map((decimalPlaces) => direct / (10 ** decimalPlaces));
  if (reference !== null && ratio !== null) {
    const target = reference * ratio;
    return formatNumber(candidates.reduce((best, candidate) => Math.abs(candidate - target) < Math.abs(best - target) ? candidate : best, candidates[0]));
  }
  if (direct > 10) return formatNumber(direct / 10);
  return formatNumber(direct);
}

function percentFromCell(cell) {
  const direct = numberFromCell(cell);
  if (direct === null) return '';
  if (/[.,]/.test(String(cell))) return formatNumber(direct);
  return formatNumber(direct >= 100 ? direct / 100 : direct / 10);
}

function factValueForBasis(fact, group) {
  const values = Array.isArray(fact?.values) ? fact.values : [];
  const match = values.find((value) => basisGroup(value) === group && value.amount);
  if (match) return match;
  if (group === 'per_100g' && fact?.value && basisGroup(fact) === 'per_100g') {
    return { amount: fact.value, unit: fact.unit, basis: fact.basis, percent_rda: '' };
  }
  return null;
}

function tableTextFromOcr(payload, ocrText) {
  const lines = String(ocrText || '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line.includes('|'));
  if (!lines.length) return '';
  const facts = payload.facts || [];
  const serveHeader = (payload.headers || []).find((header) => /per\s+(?:serve|serving|portion)/i.test(`${header.name} ${header.value}`));
  const serveAmount = String(serveHeader?.value || '').match(/(\d+(?:\.\d+)?)\s*g/i);
  const serveRatio = serveAmount ? Number(serveAmount[1]) / 100 : 0.15;
  const output = [payload.section_header || 'Nutrition Information'];
  if (serveAmount) output.push(`Serving size: ${serveAmount[1]} g`);
  const rowsByBasis = { per100: [], perServing: [] };
  const seenLabels = new Set();
  for (const line of lines) {
    const cells = line.split('|').map((cell) => cell.trim());
    const row = nutritionLabelForRow(cells[0]);
    if (!row) continue;
    const [, label, unit] = row;
    const fact = facts.find((candidate) => nutritionLabelForRow(candidate.key)?.[1] === label) || null;
    const per100Value = factValueForBasis(fact, 'per_100g');
    const perServingValue = factValueForBasis(fact, 'per_serving');
    const first = per100Value?.amount ? numberFromCell(per100Value.amount) : valueFromStrippedCell(cells[1], null);
    const second = perServingValue?.amount ? numberFromCell(perServingValue.amount) : valueFromStrippedCell(cells[2], first, serveRatio);
    // Do not let a model invent a %RDA for a column that OCR shows as blank.
    // When a percent cell is visible, prefer the model's image reading and use
    // OCR only to recover stripped decimal points.
    const rawPercent = numberFromCell(cells[3]);
    let percent = rawPercent === null ? '' : perServingValue?.percent_rda || '';
    if (!percent && rawPercent !== null) percent = fact?.values?.map((value) => value.percent_rda).find((value) => value && !/^n\/a$/i.test(value)) || '';
    if (rawPercent !== null && !percent) percent = percentFromCell(cells[3]);
    rowsByBasis.per100.push(`${label}: ${formatNumber(first)} ${unit}`.trim());
    seenLabels.add(label);
    if (second) rowsByBasis.perServing.push(`${label}: ${second} ${unit}${percent && percent !== '0' ? ` ${percent}%` : ''}`.trim());
  }
  // If OCR dropped a row but the vision model still identified it, retain the
  // visible first-column value rather than silently omitting the nutrient.
  for (const fact of facts) {
    const row = nutritionLabelForRow(fact.key);
    if (!row || seenLabels.has(row[1])) continue;
    const [, label, unit] = row;
    const per100Value = factValueForBasis(fact, 'per_100g');
    const perServingValue = factValueForBasis(fact, 'per_serving');
    const amount = per100Value?.amount || fact.value || fact.values?.[0]?.amount || '';
    if (!amount) continue;
    rowsByBasis.per100.push(`${label}: ${amount} ${per100Value?.unit || fact.unit || unit}`.trim());
    if (perServingValue) {
      rowsByBasis.perServing.push(`${label}: ${perServingValue.amount} ${perServingValue.unit || unit}${perServingValue.percent_rda ? ` ${perServingValue.percent_rda}%` : ''}`.trim());
    }
    seenLabels.add(label);
  }
  if (!rowsByBasis.per100.length) return '';
  output.push('Per 100 g', ...rowsByBasis.per100);
  if (rowsByBasis.perServing.length) output.push('Per serving', ...rowsByBasis.perServing);
  return output.join('\n');
}

export function nutritionTextFromValidatorPayload(payload, ocrText = '') {
  const tableText = tableTextFromOcr(payload, ocrText);
  if (tableText) return tableText;
  const groups = new Map([
    ['per_100g', 'Per 100 g'],
    ['per_100ml', 'Per 100 ml'],
    ['per_serving', 'Per serving'],
    ['per_container', 'Per container'],
  ]);
  const rows = new Map();
  for (const fact of payload?.facts || []) {
    const values = fact.values?.length ? fact.values : [{ amount: fact.value, unit: fact.unit, basis: fact.basis, percent_rda: '' }];
    for (const value of values) {
      const group = basisGroup(value);
      if (group === 'unknown' || group === 'dv') continue;
      if (!rows.has(group)) rows.set(group, []);
      const amount = value.amount ? `${value.amount}${value.unit ? ` ${value.unit}` : ''}` : '';
      const percent = value.percent_rda ? ` ${value.percent_rda}%` : '';
      if (amount || percent) rows.get(group).push(`${fact.key}: ${amount}${percent}`.trim());
    }
  }
  if (!rows.size) return payload?.corrected_text || '';
  const output = [payload.section_header || 'Nutrition Information'];
  for (const [group, label] of groups) {
    if (!rows.has(group)) continue;
    output.push(label, ...rows.get(group));
  }
  return output.join('\n');
}

export function correctionStatus(correctedText, sourceText) {
  const corrected = String(correctedText || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-IN');
  const source = String(sourceText || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-IN');
  if (!corrected) return 'needs_review';
  return corrected === source ? 'no_change' : 'model_correction';
}
