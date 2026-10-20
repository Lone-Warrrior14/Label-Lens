import test from 'node:test';
import assert from 'node:assert/strict';
import { extractAllergens } from '../src/core/allergens.mjs';
import { analyzeLabel, calculateTransparentScore } from '../src/core/analyze.mjs';
import { parseIngredients } from '../src/core/ingredients.mjs';
import { calculateEnergyForQuantity, parseNutrition, valueFor } from '../src/core/nutrition.mjs';
import { correctionStatus, normalizeValidatorPayload, nutritionTextFromValidatorPayload, parseValidatorJson } from '../src/core/validation.mjs';
import { nextTheme, resolveTheme } from '../src/core/theme.mjs';

const nutritionFixture = `Nutrition Information
Serving size: 30 g
Servings per container: 4
Per serving
Energy 135 kcal (565 kJ)
Total fat 6 g 8%
Saturated fat 3 g 14%
Trans fat 0 g
Total carbohydrate 18 g 7%
Total sugars 10 g
Added sugars 8 g 16%
Dietary fibre 2 g 7%
Protein 3 g 6%
Sodium 90 mg 4%
Salt 0.2 g
Per 100 g
Energy 450 kcal (1883 kJ)`;

test('preserves ingredient order and parses nested compound ingredients', () => {
  const result = parseIngredients('Ingredients: wheat flour (12%), sugar, chocolate coating (cocoa butter, soy lecithin), salt');
  assert.equal(result.status, 'present');
  assert.deepEqual(result.items.map((item) => item.name), ['wheat flour', 'sugar', 'chocolate coating', 'salt']);
  assert.equal(result.items[0].percentage, 12);
  assert.deepEqual(result.items[2].children.map((item) => item.name), ['cocoa butter', 'soy lecithin']);
  assert.equal(result.items[2].children[1].parentId, result.items[2].id);
});

test('keeps malformed ingredient delimiters visible as warnings', () => {
  const result = parseIngredients('Ingredients: flour (sugar, cocoa, oil');
  assert.equal(result.status, 'present');
  assert.ok(result.warnings.some((warning) => /unclosed/i.test(warning)));
  assert.equal(result.items[0].name, 'flour');
});

test('separates ingredient allergens from precautionary declarations', () => {
  const ingredients = parseIngredients('Ingredients: wheat flour, cocoa butter, soy lecithin, sugar');
  const result = extractAllergens(ingredients, 'May contain peanuts.');
  assert.ok(result.findings.some((finding) => finding.allergen === 'soybeans' && finding.status === 'present'));
  assert.ok(result.findings.some((finding) => finding.allergen === 'cereals containing gluten' && finding.status === 'present'));
  assert.ok(result.findings.some((finding) => finding.allergen === 'peanuts' && finding.status === 'precautionary'));
  assert.equal(result.findings.some((finding) => finding.allergen === 'milk' && finding.evidenceType === 'ingredient'), false);
});

test('parses serving basis, kcal, kJ, sugars, fats and other declared nutrients', () => {
  const result = parseNutrition(nutritionFixture);
  assert.equal(result.serving.amount, 30);
  assert.equal(result.serving.unit, 'g');
  assert.equal(result.serving.servingsPerContainer, 4);
  assert.equal(result.status, 'present');
  assert.equal(valueFor(result, 'energy', 'per_serving', 'kcal').amount, 135);
  assert.equal(valueFor(result, 'energy', 'per_serving', 'kJ').amount, 565);
  assert.equal(valueFor(result, 'added_sugars', 'per_serving').declaredDv, 16);
  assert.equal(valueFor(result, 'sodium', 'per_serving').unit, 'mg');
  assert.equal(valueFor(result, 'energy', 'per_100g', 'kcal').amount, 450);
  assert.equal(result.optionalMissing.includes('dietary_fibre'), false);
  assert.equal(result.optionalMissing.includes('salt'), false);
});

test('does not treat missing nutrition values as zero and calculates only with a matching basis', () => {
  const result = parseNutrition('Serving size: 30 g\nPer serving\nEnergy 135 kcal\nProtein 3 g');
  assert.ok(result.missing.includes('sodium'));
  assert.equal(valueFor(result, 'sodium'), null);
  const noCalculation = calculateEnergyForQuantity(result, 60, 'g');
  assert.equal(noCalculation.kcal, 270);

  const perServingOnly = parseNutrition('Serving size: 30 g\nPer serving\nEnergy 135 kcal');
  assert.equal(calculateEnergyForQuantity(perServingOnly, 60, 'ml'), null);
});

test('uses the declared conversion factor and labels derived energy', () => {
  const result = parseNutrition('Per 100 g\nEnergy 100 kcal');
  const derived = valueFor(result, 'energy', 'per_100g', 'kJ');
  assert.equal(derived.declared, false);
  assert.equal(derived.derived, true);
  assert.equal(derived.amount, 418.4);
  assert.match(derived.raw, /4\.184/);
});

test('keeps bounded amounts and additional visible nutrient rows uncertain', () => {
  const result = parseNutrition('Per serving\nSodium less than 140 mg\nVitamin E 2 mg 3%\nTrans fat —');
  const sodium = valueFor(result, 'sodium', 'per_serving');
  assert.equal(sodium.amount, null);
  assert.equal(sodium.upper, 140);
  assert.equal(sodium.upperExclusive, true);
  assert.equal(result.otherVisible[0].displayName, 'Vitamin E');
  assert.ok(result.missing.includes('trans_fat'));
});

test('flags inconsistent declared kcal and kJ instead of silently choosing one', () => {
  const result = parseNutrition('Per serving\nEnergy 100 kcal (300 kJ)');
  assert.ok(result.warnings.some((warning) => /do not reconcile/i.test(warning)));
});

test('produces a transparent score range when only some score data is declared', () => {
  const nutrition = parseNutrition('Per serving\nDietary fibre 2 g 7%\nSodium 90 mg 4%');
  const score = calculateTransparentScore(nutrition);
  assert.equal(score.status, 'available');
  assert.equal(score.knownWeight, 35);
  assert.ok(score.low < score.high);
  assert.ok(score.components.some((component) => component.label === 'Added sugars' && !component.known));
});

test('does not score a per-100-g value as if it were per serving', () => {
  const nutrition = parseNutrition('Per 100 g\nSodium 300 mg 13%');
  const score = calculateTransparentScore(nutrition);
  const sodium = score.components.find((component) => component.key === 'sodium');
  assert.equal(sodium.known, false);
  assert.equal(score.knownWeight, 0);
});

test('only reports complete full-label analysis when both sections are readable', () => {
  const complete = analyzeLabel({
    productName: 'Test bar',
    ingredientText: 'Ingredients: oats, sugar, soy lecithin',
    nutritionText: nutritionFixture,
  });
  assert.equal(complete.fullLabelStatus, 'complete');
  assert.equal(complete.evidence.sectionStatus.ingredients, 'present');
  assert.equal(complete.evidence.sectionStatus.nutrition, 'present');

  const partial = analyzeLabel({ ingredientText: 'Ingredients: oats' });
  assert.equal(partial.fullLabelStatus, 'partial');
  assert.ok(partial.missingRequests.some((request) => /Nutrition panel/i.test(request)));
  assert.equal(partial.score.status, 'not_available');
});

test('records separate ingredient and nutrition OCR evidence without calling it verified', () => {
  const report = analyzeLabel({
    ingredientText: 'Ingredients: oats, sugar',
    nutritionText: 'Per serving\nEnergy 100 kcal',
    images: {
      ingredients: { present: true, name: 'ingredients.png', ocrComplete: true, ocrConfidence: 93 },
      nutrition: { present: true, name: 'nutrition.png', ocrComplete: true, ocrConfidence: 88 },
    },
  });
  assert.equal(report.evidence.images.length, 2);
  assert.equal(report.evidence.crossCheckStatus, 'ocr_needs_review');
  assert.match(report.evidence.crossCheckMessage, /ingredients: 93%/);
});

test('missing ingredients leave allergen status unknown', () => {
  const report = analyzeLabel({ nutritionText: nutritionFixture });
  assert.equal(report.allergens.status, 'unknown');
  assert.equal(report.fullLabelStatus, 'partial');
  assert.ok(report.concerns.some((concern) => /ingredient list/i.test(concern.text)));
});

test('accepts fenced single-model validator JSON and classifies corrections', () => {
  const parsed = parseValidatorJson('```json\n{"section_header":"Nutrition Information","headers":[{"name":"Serving size","value":"30 g","type":"serving"}],"corrected_text":"Energy 135 kcal","facts":[{"key":"energy","value":"135","unit":"kcal","basis":"per_serving"}]}\n```');
  assert.equal(parsed.facts[0].value, '135');
  assert.equal(parsed.section_header, 'Nutrition Information');
  assert.equal(parsed.headers[0].name, 'Serving size');
  assert.equal(correctionStatus(parsed.corrected_text, 'Energy 135 kcal'), 'no_change');
});

test('converts structured nutrition columns into parser-readable basis rows', () => {
  const text = nutritionTextFromValidatorPayload({
    section_header: 'Nutrition Information',
    facts: [
      { key: 'Energy (kcal)', values: [
        { amount: '283.1', unit: 'kcal', basis: 'Per 100g', percent_rda: '', evidence: '283.1' },
        { amount: '42.46', unit: 'kcal', basis: 'Per serve 15g', percent_rda: '', evidence: '42.46' },
        { amount: '', unit: '%', basis: '% RDA/serve', percent_rda: '2.1', evidence: '2.1' },
      ] },
      { key: 'Sodium (mg)', values: [
        { amount: '683.8', unit: 'mg', basis: 'Per 100g', percent_rda: '', evidence: '683.8' },
        { amount: '102.6', unit: 'mg', basis: 'Per serve 15g', percent_rda: '5.1', evidence: '102.6 5.1' },
      ] },
    ],
  }, 'Energy (kcal) | 2831 | 4246 | 21 |\nSodium (mg) | 6838 | 1026 | 51 |');
  assert.match(text, /Per 100 g/);
  assert.match(text, /Energy \(kcal\): 283\.1 kcal/);
  assert.match(text, /Per serving/);
  assert.match(text, /Sodium \(mg\): 102\.6 mg 5\.1%/);
});

test('reconstructs the supplied multi-column nutrition table for deterministic parsing', () => {
  const facts = [
    ['Energy', '283.1', 'kcal', '21'],
    ['Protein', '0.4', 'g', '0.1'],
    ['Carbohydrate', '13.8', 'g', ''],
    ['Total Sugars', '8.5', 'g', ''],
    ['Added Sugars', '8.5', 'g', '2.6'],
    ['Total Fat', '25.1', 'g', '5.63'],
    ['Saturated Fat', '2.3', 'g', '1.6'],
    ['Trans Fat', '0.5', 'g', '3.75'],
    ['Cholesterol', '0.3', 'mg', ''],
    ['Sodium', '683.8', 'mg', '5.1'],
  ].map(([key, amount, unit, percent_rda]) => ({
    key,
    value: amount,
    unit,
    basis: 'Per 100g',
    values: [{ amount, unit, basis: 'Per 100g', percent_rda, evidence: amount }],
    evidence: amount,
  }));
  const ocr = `Energy | 2831 | 4246 | 21 |
Protein | 04 | 006 | 01 |
Carbohydrate | 138 | 207 | |
Total Sugars | 85 | 128 | |
Added Sugars | 85 | 128 | 26 |
Total Fat | 251 | 377 | 563 |
Saturated Fat | 23 | 034 | 16 |
Trans Fat | 05 | 008 | 375 |
Cholesterol | 03 | 005 | |
Sodium | 6838 | 1026 | 51 |`;
  const text = nutritionTextFromValidatorPayload({ section_header: 'Nutrition Information', headers: [{ name: 'Per serve 15g', value: 'Per serve 15g', type: 'column' }], facts }, ocr);
  const parsed = parseNutrition(text);
  assert.equal(parsed.status, 'present');
  assert.equal(parsed.values.find((value) => value.nutrient === 'energy' && value.basis === 'per_100g')?.amount, 283.1);
  assert.equal(parsed.values.find((value) => value.nutrient === 'energy' && value.basis === 'per_serving')?.amount, 42.46);
  assert.equal(parsed.values.find((value) => value.nutrient === 'saturated_fat' && value.basis === 'per_100g')?.amount, 2.3);
  assert.equal(parsed.values.find((value) => value.nutrient === 'sodium' && value.basis === 'per_serving')?.amount, 102.6);
});

test('retains a nutrition row when OCR drops it but the vision model reads it', () => {
  const text = nutritionTextFromValidatorPayload({
    section_header: 'Nutrition Information',
    headers: [{ name: 'Per serve 15g', value: 'Per serve 15g', type: 'column' }],
    facts: [{
      key: 'Saturated Fat',
      value: '2.3',
      unit: 'g',
      basis: 'Per 100g',
      values: [{ amount: '2.3', unit: 'g', basis: 'Per 100g', percent_rda: '1.6', evidence: '2.3' }],
    }],
  }, 'Energy | 2831 | 4246 | 21 |');
  assert.match(text, /Saturated Fat \(g\): 2\.3 g/);
});

test('retains optional Indian fibre and salt rows when the vision model reads them', () => {
  const text = nutritionTextFromValidatorPayload({
    section_header: 'Nutrition Information',
    headers: [{ name: 'Per serve 15g', value: 'Per serve 15g', type: 'column' }],
    facts: [
      {
        key: 'Dietary Fibre',
        value: '4',
        unit: 'g',
        basis: 'Per 100g',
        values: [
          { amount: '4', unit: 'g', basis: 'Per 100g', percent_rda: '', evidence: '4' },
          { amount: '0.6', unit: 'g', basis: 'Per serve 15g', percent_rda: '2', evidence: '0.6 2' },
        ],
      },
      {
        key: 'Salt',
        value: '1.2',
        unit: 'g',
        basis: 'Per 100g',
        values: [{ amount: '0.18', unit: 'g', basis: 'Per serve 15g', percent_rda: '', evidence: '0.18' }],
      },
    ],
  }, 'Dietary Fibre | 4 | 06 | 2 |\nSalt | 12 | 018 | |');
  assert.match(text, /Dietary Fibre \(g\): 4 g/);
  assert.match(text, /Dietary Fibre \(g\): 0\.6 g 2%/);
  assert.match(text, /Salt \(g\): 1\.2 g/);
  const parsed = parseNutrition(text);
  assert.equal(parsed.optionalMissing.includes('dietary_fibre'), false);
  assert.equal(parsed.optionalMissing.includes('salt'), false);
});

test('normalizes validator output into the stable JSON contract', () => {
  const normalized = normalizeValidatorPayload({
    section_status: 'unknown',
    section_header: 42,
    headers: [{ name: 'Serving size', value: 30, type: 'bad-type', evidence: null }, { value: 'Per serving' }],
    corrected_text: null,
    facts: [{ key: 'energy', value: 135, unit: 'kcal', basis: null, evidence: 'Energy' }],
    warnings: ['check image', 7],
    ignored: 'not returned',
  });
  assert.deepEqual(normalized, {
    section_status: 'partial',
    section_header: '42',
    headers: [
      { name: 'Serving size', value: '30', type: 'other', evidence: '' },
      { name: '', value: 'Per serving', type: 'other', evidence: '' },
    ],
    corrected_text: '',
    facts: [{ key: 'energy', value: '135', unit: 'kcal', basis: 'unknown', values: [], evidence: 'Energy' }],
    warnings: ['check image', '7'],
  });
});

test('keeps unavailable LLM processing visible without blocking OCR analysis', () => {
  const report = analyzeLabel({
    ingredientText: 'Ingredients: oats',
    images: {
      ingredients: {
        present: true,
        name: 'ingredients.png',
        ocrComplete: true,
        validation: { kind: 'ingredients', comparison: { status: 'unavailable', conflicts: ['Ollama is not running.'] } },
      },
    },
  });
  assert.equal(report.evidence.llmValidation[0].status, 'unavailable');
  assert.ok(report.concerns.some((concern) => /LLM processing was unavailable/i.test(concern.text)));
});

test('resolves and toggles the persisted theme without browser dependencies', () => {
  assert.equal(resolveTheme('dark', false), 'dark');
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme(null, true), 'dark');
  assert.equal(resolveTheme('unexpected', false), 'light');
  assert.equal(nextTheme('light'), 'dark');
  assert.equal(nextTheme('dark'), 'light');
});

test('creates an A-D rating with visible nutrition and ingredient reasons', () => {
  const report = analyzeLabel({
    ingredientText: 'Ingredients: sugar, maida, palm oil, cocoa powder',
    nutritionText: 'Nutrition Information\nServing size: 30 g\nPer serving\nEnergy 180 kcal\nTotal fat 10 g 15%\nSaturated fat 6 g 27%\nTrans fat 0 g\nTotal carbohydrate 20 g 8%\nTotal sugars 14 g\nAdded sugars 12 g 24%\nDietary fibre 1 g 4%\nProtein 2 g 4%\nSodium 520 mg 23%\nSalt 1.3 g',
  });
  assert.match(report.rating.grade, /^[A-D]$/);
  assert.notEqual(report.rating.status, 'not_rated');
  assert.ok(report.rating.reasons.some((reason) => /sugar/i.test(reason.title)));
  assert.ok(report.rating.reasons.some((reason) => /sodium|saturated fat/i.test(reason.title)));
  assert.ok(report.rating.reasons.some((reason) => /palm-derived/i.test(reason.title)));
  assert.ok(report.rating.ingredientPenalty > 0);
  assert.ok(report.rating.nutritionPenalty >= 11);
});

test('highlights oil when it appears in the first two ingredients', () => {
  const report = analyzeLabel({
    ingredientText: 'Ingredients: water, refined sunflower oil, sugar, thickeners',
    nutritionText: 'Nutrition Information\nServing size: 15 g\nPer serving\nEnergy 42 kcal\nTotal carbohydrate 2 g\nTotal sugars 1 g\nAdded sugars 1 g 2%\nTotal fat 4 g 6%\nSaturated fat 1 g 5%\nTrans fat 0 g\nProtein 0 g\nSodium 100 mg 5%',
  });
  assert.ok(report.rating.reasons.some((reason) => /oil is high in the ingredient list/i.test(reason.title)));
  assert.ok(report.rating.reasons.some((reason) => /first two/i.test(reason.detail)));
  assert.ok(report.rating.ingredientPenalty >= 5);
});

test('hydrogenated oils materially lower the ingredient-adjusted rating', () => {
  const nutritionText = 'Serving size: 30 g\nPer serving\nEnergy 100 kcal\nTotal fat 4 g 6%\nSaturated fat 1 g 5%\nTrans fat 0 g\nAdded sugars 2 g 4%\nDietary fibre 3 g 11%\nProtein 4 g 8%\nSodium 80 mg 3%';
  const base = analyzeLabel({ ingredientText: 'Ingredients: oats, cocoa powder', nutritionText });
  const hydrogenated = analyzeLabel({ ingredientText: 'Ingredients: oats, hydrogenated vegetable oil, cocoa powder', nutritionText });
  assert.ok(hydrogenated.rating.ingredientPenalty >= base.rating.ingredientPenalty + 15);
  assert.ok(hydrogenated.rating.scoreLow < base.rating.scoreLow);
  assert.ok(hydrogenated.rating.reasons.some((reason) => /hydrogenated/i.test(reason.title)));
});

test('withholds the A-D grade when a required label section is missing', () => {
  const report = analyzeLabel({
    ingredientText: 'Ingredients: oats, sugar',
  });
  assert.equal(report.rating.status, 'not_rated');
  assert.equal(report.rating.grade, null);
  assert.match(report.rating.notice, /both sections/i);
});

test('keeps LLM-extracted nutrition headers in the evidence report', () => {
  const report = analyzeLabel({
    ingredientText: 'Ingredients: oats',
    nutritionText: 'Serving size: 30 g\nPer serving\nEnergy 100 kcal\nSodium 40 mg 2%',
    images: {
      nutrition: {
        present: true,
        name: 'nutrition.png',
        validation: {
          model: 'gemma3:latest',
          parsed: {
            section_header: 'Nutrition Information',
            headers: [{ name: 'Serving size', value: '30 g', type: 'serving' }],
          },
          comparison: { status: 'single_model', correctionStatus: 'no_change', consensusText: null, conflicts: [] },
        },
      },
    },
  });
  assert.equal(report.evidence.llmValidation[0].sectionHeader, 'Nutrition Information');
  assert.equal(report.evidence.llmValidation[0].headers[0].name, 'Serving size');
});

test('parses the supplied ingredient-label transcription with compound INS additives and allergens', () => {
  const text = 'Ingredients: Water, Refined Sunflower Oil, Sugar, Thickeners (INS 1442 & INS 415), Iodized Salt, Milk Solids, Acidity Regulators (INS 260, INS 270 & INS 330), Mustard Powder, Lemon Juice, Preservatives (INS 202 & INS 211), Antioxidant (INS 386), Natural Flavouring Substances.';
  const result = parseIngredients(text);
  assert.equal(result.status, 'present');
  assert.deepEqual(result.items.map((item) => item.name), [
    'Water',
    'Refined Sunflower Oil',
    'Sugar',
    'Thickeners',
    'Iodized Salt',
    'Milk Solids',
    'Acidity Regulators',
    'Mustard Powder',
    'Lemon Juice',
    'Preservatives',
    'Antioxidant',
    'Natural Flavouring Substances',
  ]);
  assert.deepEqual(result.items[3].children.map((item) => item.name), ['INS 1442 & INS 415']);
  const allergens = extractAllergens(result).findings.map((finding) => finding.allergen);
  assert.ok(allergens.includes('milk'));
  assert.ok(allergens.includes('mustard'));
});

test('treats both supplied readable fixture sections as a complete label even when optional rows are absent', () => {
  const ingredients = 'Ingredients: Water, Refined Sunflower Oil, Sugar, Thickeners (INS 1442 & INS 415), Iodized Salt, Milk Solids, Acidity Regulators (INS 260, INS 270 & INS 330), Mustard Powder, Lemon Juice, Preservatives (INS 202 & INS 211), Antioxidant (INS 386), Natural Flavouring Substances.';
  const nutrition = 'Nutritional Facts\nServing size: 15 g\nPer 100 g\nEnergy (kcal): 283.1 kcal\nProtein (g): 0.4 g\nCarbohydrate (g): 13.8 g\nTotal Sugars (g): 8.5 g\nAdded Sugars (g): 8.5 g\nTotal Fat (g): 25.1 g\nSaturated Fat (g): 2.3 g\nTrans Fat (g): 0.5 g\nCholesterol (mg): 0.3 mg\nSodium (mg): 683.8 mg\nPer serving\nEnergy (kcal): 42.46 kcal 2.1%\nProtein (g): 0.06 g 0.1%\nCarbohydrate (g): 2.07 g\nTotal Sugars (g): 1.28 g\nAdded Sugars (g): 1.28 g 2.6%\nTotal Fat (g): 3.77 g 5.63%\nTrans Fat (g): 0.08 g 3.75%\nSodium (mg): 102.6 mg 5.1%';
  const report = analyzeLabel({ ingredientText: ingredients, nutritionText: nutrition });
  assert.equal(report.fullLabelStatus, 'complete');
  assert.equal(report.nutrition.status, 'present');
  assert.ok(report.nutrition.optionalMissing.includes('dietary_fibre'));
  assert.equal(report.rating.status, 'provisional');
  assert.deepEqual(report.missingRequests, []);
});
