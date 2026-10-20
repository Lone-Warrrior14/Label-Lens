import { extractAllergens, findInvestigationFlags } from './allergens.mjs';
import { flattenIngredients, parseIngredients } from './ingredients.mjs';
import { calculateEnergyForQuantity, parseNutrition } from './nutrition.mjs';
import { INDIA_LABEL_PROFILE } from '../rules/india-label-profile.mjs';

const COMPONENTS = [
  { key: 'dietary_fibre', label: 'Dietary fibre', weight: 10, type: 'positive', target: 20, basis: 'per_serving', reason: 'A higher declared % RDA contributes positively, capped at the documented target.' },
  { key: 'protein', label: 'Protein', weight: 5, type: 'positive', target: 20, basis: 'per_serving', reason: 'A higher declared % RDA contributes positively, capped at the documented target.' },
  { key: 'sodium', label: 'Sodium', weight: 25, type: 'negative', target: 100, basis: 'per_serving', reason: 'A higher declared % RDA reduces this signal.' },
  { key: 'saturated_fat', label: 'Saturated fat', weight: 20, type: 'negative', target: 100, basis: 'per_serving', reason: 'A higher declared % RDA reduces this signal.' },
  { key: 'added_sugars', label: 'Added sugars', weight: 20, type: 'negative', target: 100, basis: 'per_serving', reason: 'A higher declared % RDA reduces this signal.' },
  { key: 'trans_fat', label: 'Trans fat', weight: 20, type: 'trans', target: 0, basis: 'per_serving', reason: 'A displayed zero contributes the full component; a positive declared amount contributes zero.' },
];

const SWEETENER_ALIASES = ['sugar', 'sucrose', 'glucose syrup', 'corn syrup', 'invert sugar', 'maltodextrin', 'jaggery', 'honey'];
const REFINED_GRAIN_ALIASES = ['maida', 'refined wheat flour', 'refined flour', 'white flour'];
const WHOLE_GRAIN_ALIASES = ['whole wheat', 'wholegrain', 'whole grain', 'oats', 'oat flour', 'brown rice', 'millet', 'ragi'];
const PALM_FAT_ALIASES = ['palm oil', 'palmolein', 'palm fat'];

function includesAlias(text, aliases) {
  const normalized = String(text || '').toLocaleLowerCase('en-IN');
  return aliases.find((alias) => normalized.includes(alias));
}

function gradeForScore(score) {
  if (score >= 75) return 'A';
  if (score >= 55) return 'B';
  if (score >= 35) return 'C';
  return 'D';
}

function buildRatingReasons(ingredients, nutrition, score) {
  const reasons = [];
  const topLevel = ingredients.items || [];
  const topThreeText = topLevel.slice(0, 3).map((item) => item.name).join(', ');
  const allIngredientText = flattenIngredients(topLevel).map((item) => item.name).join(', ');
  let ingredientPenalty = 0;
  let ingredientBonus = 0;
  let nutritionPenalty = 0;

  const hydrogenatedMatches = allIngredientText.match(/\b(?:partially\s+|fully\s+)?hydrogenated(?:\s+vegetable\s+oil|\s+fat)?\b|\bvanaspati\b/gi) || [];
  if (hydrogenatedMatches.length) {
    ingredientPenalty += 15 + Math.min(hydrogenatedMatches.length - 1, 2) * 4;
    reasons.push({ severity: 'concern', title: `Hydrogenated fat ingredient declared (-${15 + Math.min(hydrogenatedMatches.length - 1, 2) * 4} points)`, detail: 'Hydrogenated fat, hydrogenated vegetable oil or vanaspati is named in the ingredient list. This is a major ingredient-level concern; verify the exact formulation and trans-fat declaration on the original package.', evidence: hydrogenatedMatches.join(', ') });
  }

  const palmFat = includesAlias(allIngredientText, PALM_FAT_ALIASES);
  if (palmFat) {
    const palmPenalty = includesAlias(topThreeText, PALM_FAT_ALIASES) ? 6 : 3;
    ingredientPenalty += palmPenalty;
    reasons.push({ severity: 'concern', title: `Palm-derived fat is declared (-${palmPenalty} points)`, detail: `“${palmFat}” is visible in the ingredient list${palmPenalty === 6 ? ' and appears among the first three ingredients' : ''}. Palm oil is not the same as hydrogenated oil, so it receives a moderate, not maximum, adjustment; the nutrition panel’s saturated fat remains important.`, evidence: allIngredientText });
  }

  const topSweetener = includesAlias(topThreeText, SWEETENER_ALIASES);
  if (topSweetener) {
    ingredientPenalty += 8;
    reasons.push({ severity: 'concern', title: 'Sweetener appears near the beginning', detail: `“${topSweetener}” appears among the first three listed ingredients. Ingredient order generally reflects descending weight, but no exact percentage is inferred.`, evidence: topThreeText });
  }

  const topRefinedGrain = includesAlias(topThreeText, REFINED_GRAIN_ALIASES);
  if (topRefinedGrain) {
    ingredientPenalty += 5;
    reasons.push({ severity: 'concern', title: 'Refined flour appears near the beginning', detail: `“${topRefinedGrain}” appears among the first three listed ingredients. This is a label-composition flag, not a medical conclusion.`, evidence: topThreeText });
  }

  const sweetenerCount = flattenIngredients(topLevel).filter((item) => includesAlias(item.name, SWEETENER_ALIASES)).length;
  if (sweetenerCount > 1) {
    ingredientPenalty += 4;
    reasons.push({ severity: 'concern', title: 'More than one sweetening ingredient is declared', detail: 'Several sweetening ingredients are visible in the supplied ingredient text. Total and added sugars should be checked together.', evidence: allIngredientText });
  }

  const wholeGrain = includesAlias(topThreeText, WHOLE_GRAIN_ALIASES);
  if (wholeGrain) {
    ingredientBonus += 2;
    reasons.push({ severity: 'positive', title: 'A whole-grain or less-refined grain is declared early', detail: `“${wholeGrain}” appears among the first three listed ingredients. This is positive label evidence, not a guarantee of overall healthfulness.`, evidence: topThreeText });
  }

  const nutrientReasons = [
    { nutrient: 'sodium', label: 'Sodium', highAt: 20, lowAt: 5, highText: 'Sodium is high', lowText: 'Sodium is relatively low', detail: 'The declared sodium % RDA is compared with the label’s serving basis.' },
    { nutrient: 'saturated_fat', label: 'Saturated fat', highAt: 20, lowAt: 5, highText: 'Saturated fat is high', lowText: 'Saturated fat is relatively low', detail: 'The declared saturated-fat % RDA is compared with the label’s serving basis.' },
    { nutrient: 'added_sugars', label: 'Added sugars', highAt: 20, lowAt: 5, highText: 'Added sugars are high', lowText: 'Added sugars are relatively low', detail: 'The declared added-sugars % RDA is compared with the label’s serving basis; total sugars are not substituted.' },
  ];
  for (const criterion of nutrientReasons) {
    const value = preferredValue(nutrition, criterion.nutrient, 'per_serving');
    if (typeof value?.declaredDv !== 'number') continue;
    if (value.declaredDv >= criterion.highAt) {
      const adjustment = criterion.nutrient === 'added_sugars' ? 5 : 3;
      nutritionPenalty += adjustment;
      reasons.push({ severity: 'concern', title: `${criterion.highText} (${value.declaredDv}% RDA, -${adjustment} points)`, detail: `${criterion.detail} This high-priority flag applies a transparent ${adjustment}-point rating adjustment in addition to the underlying nutrition component.`, evidence: value.raw });
    } else if (value.declaredDv <= criterion.lowAt) {
      reasons.push({ severity: 'positive', title: `${criterion.lowText} (${value.declaredDv}% RDA)`, detail: criterion.detail, evidence: value.raw });
    }
  }

  const transFat = preferredValue(nutrition, 'trans_fat', 'per_serving');
  if (transFat?.amount !== null && transFat?.amount > 0) {
    reasons.push({ severity: 'concern', title: `Trans fat is declared (${transFat.displayAmount} ${transFat.unit || ''})`, detail: 'A positive displayed trans-fat value is treated as a concern signal. Check the original image for the exact row and basis.', evidence: transFat.raw });
  }

  const fibre = preferredValue(nutrition, 'dietary_fibre', 'per_serving');
  if (typeof fibre?.declaredDv === 'number' && fibre.declaredDv >= 10) {
    reasons.push({ severity: 'positive', title: `Dietary fibre contributes positively (${fibre.declaredDv}% RDA)`, detail: 'The declared fibre % RDA is included in the transparent nutrition signal.', evidence: fibre.raw });
  }

  return { reasons, ingredientPenalty, ingredientBonus, nutritionPenalty, topThreeText };
}

function calculateProductRating(ingredients, nutrition, score) {
  if (ingredients.status !== 'present' || nutrition.status === 'missing' || nutrition.status === 'unreadable' || score.status === 'not_available' || score.status === 'not_enough_declared_data') {
    return {
      status: 'not_rated',
      grade: null,
      scoreLow: null,
      scoreHigh: null,
      reasons: [],
      ingredientPenalty: 0,
      ingredientBonus: 0,
      notice: 'A grade is withheld until both sections are readable and enough declared nutrition data is available. Missing values are not treated as healthy or unhealthy.',
    };
  }
  const ingredientSignals = buildRatingReasons(ingredients, nutrition, score);
  const totalPenalty = ingredientSignals.ingredientPenalty + ingredientSignals.nutritionPenalty;
  const scoreLow = Math.max(0, Math.min(100, score.low - totalPenalty + ingredientSignals.ingredientBonus));
  const scoreHigh = Math.max(0, Math.min(100, score.high - totalPenalty + ingredientSignals.ingredientBonus));
  // Always expose one primary grade. When data is incomplete, use the
  // conservative lower-bound score; the numeric range remains visible beside
  // it so uncertainty is not hidden behind a forced optimistic grade.
  const grade = gradeForScore(scoreLow);
  return {
    status: scoreLow === scoreHigh ? 'available' : 'provisional',
    grade,
    gradeRange: `${gradeForScore(scoreLow)}–${gradeForScore(scoreHigh)}`,
    scoreLow: Math.round(scoreLow * 10) / 10,
    scoreHigh: Math.round(scoreHigh * 10) / 10,
    reasons: ingredientSignals.reasons,
    ingredientPenalty: ingredientSignals.ingredientPenalty,
    nutritionPenalty: ingredientSignals.nutritionPenalty,
    ingredientBonus: ingredientSignals.ingredientBonus,
    notice: 'This A–D label profile is a transparent signal based only on declared serving-basis nutrition data and visible ingredient cues. It is not medical advice, an allergy-safety rating, or a universal definition of health.',
  };
}

function preferredValue(nutrition, nutrient, basis = 'per_serving') {
  const candidates = (nutrition?.values || []).filter((value) => value.nutrient === nutrient && value.declared);
  return candidates.find((value) => value.basis === basis && value.declaredDv !== undefined)
    || candidates.find((value) => value.basis === basis)
    || null;
}

function calculateComponent(component, nutrition) {
  const value = preferredValue(nutrition, component.key, component.basis);
  if (!value) {
    return {
      ...component,
      low: 0,
      high: component.weight,
      known: false,
      value: null,
      explanation: 'Not scored because this value was not readable or declared on a usable serving basis.',
    };
  }

  if (component.type === 'trans') {
    if (value.amount === null || value.certainty === 'not_significant') {
      return { ...component, low: 0, high: component.weight, known: false, value, explanation: 'The label does not provide a sufficiently definite trans-fat amount; “not significant” is not silently treated as zero.' };
    }
    const contribution = value.amount === 0 ? component.weight : 0;
    return { ...component, low: contribution, high: contribution, known: true, value, explanation: `${value.displayAmount} ${value.unit || ''} was displayed on the label. ${component.reason}` };
  }

  const dv = value.declaredDv;
  if (typeof dv !== 'number' || !Number.isFinite(dv) || value.basis === 'unknown') {
    return { ...component, low: 0, high: component.weight, known: false, value, explanation: 'An amount is visible, but a declared % RDA on a clear serving basis is required for this documented signal.' };
  }

  const ratio = Math.max(0, Math.min(dv / component.target, 1));
  const contribution = component.type === 'positive' ? component.weight * ratio : component.weight * (1 - ratio);
  return {
    ...component,
    low: contribution,
    high: contribution,
    known: true,
    value,
    explanation: `${dv}% RDA per ${value.basis.replaceAll('_', ' ')} produced ${contribution.toFixed(1)} of ${component.weight} points. ${component.reason}`,
  };
}

export function calculateTransparentScore(nutrition) {
  if (!nutrition || nutrition.status === 'missing' || nutrition.status === 'unreadable') {
    return {
      status: 'not_available',
      low: null,
      high: null,
      knownWeight: 0,
      components: COMPONENTS.map((component) => ({ ...component, low: null, high: null, known: false, explanation: 'No usable nutrition panel was supplied.' })),
      notice: INDIA_LABEL_PROFILE.scoringNotice,
    };
  }

  const components = COMPONENTS.map((component) => calculateComponent(component, nutrition));
  const low = components.reduce((total, component) => total + component.low, 0);
  const high = components.reduce((total, component) => total + component.high, 0);
  const knownWeight = components.filter((component) => component.known).reduce((total, component) => total + component.weight, 0);
  return {
    status: knownWeight ? 'available' : 'not_enough_declared_data',
    low: Math.round(low * 10) / 10,
    high: Math.round(high * 10) / 10,
    knownWeight,
    maximumWeight: COMPONENTS.reduce((total, component) => total + component.weight, 0),
    components,
    notice: INDIA_LABEL_PROFILE.scoringNotice,
    criteria: 'Only declared serving-basis % RDA is used for fibre, protein, sodium, saturated fat and added sugars. Trans fat uses the displayed amount. Missing or uncertain components remain a range, not an invented zero.',
  };
}

function sectionRequest(section, imagePresent) {
  if (!imagePresent) return `${section} text is not present. Upload a clear image containing this section or enter it manually.`;
  return `${section} was not readable from the supplied evidence. Upload another, sharper image containing this section or enter it manually.`;
}

function buildEvidence({ images, imageChecks, ingredients, nutrition }) {
  const imageList = Object.entries(images || {})
    .filter(([, image]) => image?.present)
    .map(([kind, image]) => ({ kind, ...image }));
  const present = imageList.length > 0;
  const checks = imageChecks || {};
  let crossCheckStatus = 'no_image';
  let crossCheckMessage = 'No packaging image was supplied; the report is based only on the entered text.';
  if (present) {
    if (checks.ingredientsChecked && checks.nutritionChecked) {
      crossCheckStatus = 'user_checked';
      crossCheckMessage = 'You marked both sections as visually checked against the uploaded image. OCR is a transcription aid, not an independent verification of the pixels.';
    } else if (imageList.some((image) => image.ocrComplete)) {
      crossCheckStatus = 'ocr_needs_review';
      const confidence = imageList.filter((image) => image.ocrComplete && image.ocrConfidence !== null).map((image) => `${image.kind}: ${image.ocrConfidence}%`).join(' · ');
      crossCheckMessage = `Local OCR produced the transcriptions${confidence ? ` (${confidence})` : ''}, but OCR is not proof of what is printed. Review every ingredient, digit, decimal, unit and serving basis against the corresponding image.`;
    } else {
      crossCheckStatus = 'needs_manual_check';
      crossCheckMessage = 'The image is available for visual comparison, but OCR was not completed. Review the entered text against the image or run the OCR button.';
    }
  }
  return {
    images: imageList,
    crossCheckStatus,
    crossCheckMessage,
    sources: [
      'Ingredient and nutrition values come from the user-reviewed OCR transcription or text supplied manually.',
      `Interpretation profile: ${INDIA_LABEL_PROFILE.id}.`,
      INDIA_LABEL_PROFILE.nutritionInformation,
      'No value is silently invented when it is missing or unreadable.',
    ],
    sectionStatus: {
      ingredients: ingredients.status,
      nutrition: nutrition.status,
    },
    llmValidation: imageList.map((image) => {
      const parsed = image.validation?.parsed || image.validation?.validation?.parsed || null;
      return {
      kind: image.kind,
      status: image.validation?.comparison?.status || 'not_run',
      correctionStatus: image.validation?.comparison?.correctionStatus || 'not_run',
      consensusText: image.validation?.comparison?.consensusText || null,
      correctedTexts: image.validation?.comparison?.correctedTexts || [],
      model: image.validation?.model || null,
      conflicts: image.validation?.comparison?.conflicts || [],
      sectionHeader: parsed?.section_header || '',
      headers: Array.isArray(parsed?.headers) ? parsed.headers : [],
      };
    }),
  };
}

export function analyzeLabel(input = {}) {
  const ingredients = parseIngredients(input.ingredientText);
  const nutrition = parseNutrition(input.nutritionText);
  const allergens = extractAllergens(ingredients, input.containsText);
  const claimText = [input.ingredientText, input.containsText, input.nutritionText].filter(Boolean).join('\n');
  const investigationFlags = findInvestigationFlags(claimText);
  const score = calculateTransparentScore(nutrition);
  const rating = calculateProductRating(ingredients, nutrition, score);
  const ingredientCount = flattenIngredients(ingredients.items).length;
  const validationResults = Object.values(input.images || {})
    .map((image) => image?.validation)
    .filter(Boolean);
  const validationConflicts = validationResults.flatMap((validation) => {
    if (validation.comparison?.status === 'unavailable') {
      return [`LLM processing was unavailable for the ${validation.kind || 'label'} section. The OCR transcription remains unconfirmed.`];
    }
    return [];
  });
  const missingRequests = [];
  if (['missing', 'unreadable'].includes(ingredients.status)) missingRequests.push(sectionRequest('Ingredient list', input.images?.ingredients?.present || input.image?.present));
  if (['missing', 'unreadable'].includes(nutrition.status)) missingRequests.push(sectionRequest('Nutrition panel', input.images?.nutrition?.present || input.image?.present));

  const energyForQuantity = calculateEnergyForQuantity(nutrition, input.plannedQuantity, input.plannedUnit);
  // A readable panel can legitimately omit optional nutrients. The full-label
  // status concerns whether both sections were readable, while the nutrition
  // status and score range separately expose missing rows.
  const fullLabelStatus = ingredients.status === 'present' && !['missing', 'unreadable'].includes(nutrition.status) ? 'complete' : 'partial';
  const concerns = [
    ...ingredients.warnings.map((warning) => ({ severity: 'uncertain', text: warning })),
    ...nutrition.warnings.map((warning) => ({ severity: 'uncertain', text: warning })),
    ...validationConflicts.map((text) => ({ severity: 'uncertain', text })),
    ...allergens.findings.filter((finding) => finding.status === 'precautionary').map((finding) => ({ severity: 'investigate', text: `${finding.allergen}: ${finding.explanation}` })),
    ...investigationFlags.map((flag) => ({ severity: 'investigate', text: `“${flag.text}”: ${flag.reason}` })),
  ];
  if (['missing', 'unreadable'].includes(ingredients.status)) concerns.unshift({ severity: 'missing', text: 'A full ingredient/allergen assessment cannot be completed without a readable ingredient list.' });
  if (['missing', 'unreadable'].includes(nutrition.status)) concerns.unshift({ severity: 'missing', text: 'A calorie and nutrient assessment cannot be completed without a readable nutrition panel.' });
  if (fullLabelStatus !== 'complete') concerns.unshift({ severity: 'missing', text: 'This is not a completed full-label analysis because one or both label sections are missing, unreadable or incomplete.' });

  return {
    schemaVersion: 1,
    profile: INDIA_LABEL_PROFILE,
    product: { name: input.productName?.trim() || 'Unnamed product' },
    fullLabelStatus,
    ingredients,
    ingredientCount,
    allergens,
    nutrition,
    score,
    rating,
    concerns,
    missingRequests,
    energyForQuantity,
    evidence: buildEvidence({ images: input.images || { label: input.image }, imageChecks: input.imageChecks, ingredients, nutrition }),
  };
}
