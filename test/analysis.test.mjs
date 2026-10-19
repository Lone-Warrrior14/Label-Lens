import test from 'node:test';
import assert from 'node:assert/strict';
import { extractAllergens } from '../src/core/allergens.mjs';
import { analyzeLabel, calculateTransparentScore } from '../src/core/analyze.mjs';
import { parseIngredients } from '../src/core/ingredients.mjs';
import { calculateEnergyForQuantity, parseNutrition, valueFor } from '../src/core/nutrition.mjs';
import { compareValidatorResults, parseValidatorJson } from '../src/core/validation.mjs';

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

test('accepts fenced validator JSON and confirms equivalent independent facts', () => {
  const parsed = parseValidatorJson('```json\n{"corrected_text":"Energy 135 kcal","facts":[{"key":"energy","value":"135","unit":"kcal","basis":"per_serving"}]}\n```');
  const comparison = compareValidatorResults([
    { status: 'ok', parsed },
    { status: 'ok', parsed: { corrected_text: 'Energy 135 kcal', facts: [{ key: 'ENERGY', value: 135, unit: 'KCAL', basis: 'PER_SERVING' }] } },
  ]);
  assert.equal(comparison.status, 'agreement');
  assert.equal(comparison.agreedFacts[0].value, '135');
  assert.equal(comparison.correctionStatus, 'confirmed_correction');
  assert.equal(comparison.consensusText, 'Energy 135 kcal');
});

test('treats alternate ingredient keys as agreement when ordered visible values match', () => {
  const comparison = compareValidatorResults([
    { status: 'ok', parsed: { facts: [{ key: 'ingredient_1', value: 'wheat flour', basis: 'visible' }] } },
    { status: 'ok', parsed: { facts: [{ key: 'wheat flour', value: 'wheat flour', basis: 'unknown' }] } },
  ]);
  assert.equal(comparison.status, 'agreement');
});

test('uses matching corrected transcriptions when validator JSON formatting differs', () => {
  const correctedText = 'Nutrition Information\nEnergy 135 kcal (565 kJ)';
  const comparison = compareValidatorResults([
    { status: 'ok', parsed: { corrected_text: correctedText, facts: [{ key: 'stable field key or energy', value: '135', unit: 'kcal', basis: 'per serving' }] } },
    { status: 'ok', parsed: { corrected_text: correctedText, facts: [{ key: 'Energy', value: '135', unit: 'kcal (565 kJ)', basis: 'per serving' }] } },
  ], { kind: 'nutrition', ocrText: 'Energy 135 kcal (565 kJ)' });
  assert.equal(comparison.status, 'agreement');
  assert.equal(comparison.correctionStatus, 'confirmed_correction');
  assert.equal(comparison.consensusText, correctedText);
  assert.equal(comparison.factConflicts.length, 1);
});

test('does not choose a winner when independent validators disagree', () => {
  const comparison = compareValidatorResults([
    { status: 'ok', parsed: { facts: [{ key: 'energy', value: '135', unit: 'kcal', basis: 'per_serving' }] } },
    { status: 'ok', parsed: { facts: [{ key: 'energy', value: '185', unit: 'kcal', basis: 'per_serving' }] } },
  ]);
  assert.equal(comparison.status, 'conflict');
  assert.equal(comparison.agreedFacts.length, 0);
  assert.equal(comparison.conflicts[0].validatorA.value, '135');
});

test('keeps unavailable dual validation visible without blocking OCR analysis', () => {
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
  assert.equal(report.evidence.dualValidation[0].status, 'unavailable');
  assert.ok(report.concerns.some((concern) => /dual validation was unavailable/i.test(concern.text)));
});
