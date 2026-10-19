import { extractAllergens, findInvestigationFlags } from './allergens.mjs';
import { flattenIngredients, parseIngredients } from './ingredients.mjs';
import { calculateEnergyForQuantity, parseNutrition } from './nutrition.mjs';
import { INDIA_LABEL_PROFILE } from '../rules/india-label-profile.mjs';

const COMPONENTS = [
  { key: 'dietary_fibre', label: 'Dietary fibre', weight: 10, type: 'positive', target: 20, basis: 'per_serving', reason: 'A higher declared %DV contributes positively, capped at the documented target.' },
  { key: 'protein', label: 'Protein', weight: 5, type: 'positive', target: 20, basis: 'per_serving', reason: 'A higher declared %DV contributes positively, capped at the documented target.' },
  { key: 'sodium', label: 'Sodium', weight: 25, type: 'negative', target: 100, basis: 'per_serving', reason: 'A higher declared %DV reduces this signal.' },
  { key: 'saturated_fat', label: 'Saturated fat', weight: 20, type: 'negative', target: 100, basis: 'per_serving', reason: 'A higher declared %DV reduces this signal.' },
  { key: 'added_sugars', label: 'Added sugars', weight: 20, type: 'negative', target: 100, basis: 'per_serving', reason: 'A higher declared %DV reduces this signal.' },
  { key: 'trans_fat', label: 'Trans fat', weight: 20, type: 'trans', target: 0, basis: 'per_serving', reason: 'A displayed zero contributes the full component; a positive declared amount contributes zero.' },
];

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
    return { ...component, low: 0, high: component.weight, known: false, value, explanation: 'An amount is visible, but a declared %DV on a clear serving basis is required for this documented signal.' };
  }

  const ratio = Math.max(0, Math.min(dv / component.target, 1));
  const contribution = component.type === 'positive' ? component.weight * ratio : component.weight * (1 - ratio);
  return {
    ...component,
    low: contribution,
    high: contribution,
    known: true,
    value,
    explanation: `${dv}% DV per ${value.basis.replaceAll('_', ' ')} produced ${contribution.toFixed(1)} of ${component.weight} points. ${component.reason}`,
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
    criteria: 'Only declared serving-basis %DV is used for fibre, protein, sodium, saturated fat and added sugars. Trans fat uses the displayed amount. Missing or uncertain components remain a range, not an invented zero.',
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
      'No value is silently invented when it is missing or unreadable.',
    ],
    sectionStatus: {
      ingredients: ingredients.status,
      nutrition: nutrition.status,
    },
    dualValidation: imageList.map((image) => ({
      kind: image.kind,
      status: image.validation?.comparison?.status || 'not_run',
      models: image.validation?.models || [],
      conflicts: image.validation?.comparison?.conflicts || [],
    })),
  };
}

export function analyzeLabel(input = {}) {
  const ingredients = parseIngredients(input.ingredientText);
  const nutrition = parseNutrition(input.nutritionText);
  const allergens = extractAllergens(ingredients, input.containsText);
  const claimText = [input.ingredientText, input.containsText, input.nutritionText].filter(Boolean).join('\n');
  const investigationFlags = findInvestigationFlags(claimText);
  const score = calculateTransparentScore(nutrition);
  const ingredientCount = flattenIngredients(ingredients.items).length;
  const validationResults = Object.values(input.images || {})
    .map((image) => image?.validation)
    .filter(Boolean);
  const validationConflicts = validationResults.flatMap((validation) => {
    if (validation.comparison?.status === 'conflict') {
      return [`Independent validators disagreed for the ${validation.kind || 'label'} section. Review the original image before relying on conflicting values.`];
    }
    if (validation.comparison?.status === 'unavailable') {
      return [`Independent dual validation was unavailable for the ${validation.kind || 'label'} section. The OCR transcription remains unconfirmed.`];
    }
    return [];
  });
  const missingRequests = [];
  if (ingredients.status !== 'present') missingRequests.push(sectionRequest('Ingredient list', input.images?.ingredients?.present || input.image?.present));
  if (nutrition.status !== 'present') missingRequests.push(sectionRequest('Nutrition panel', input.images?.nutrition?.present || input.image?.present));

  const energyForQuantity = calculateEnergyForQuantity(nutrition, input.plannedQuantity, input.plannedUnit);
  const fullLabelStatus = ingredients.status === 'present' && nutrition.status === 'present' ? 'complete' : 'partial';
  const concerns = [
    ...ingredients.warnings.map((warning) => ({ severity: 'uncertain', text: warning })),
    ...nutrition.warnings.map((warning) => ({ severity: 'uncertain', text: warning })),
    ...validationConflicts.map((text) => ({ severity: 'uncertain', text })),
    ...allergens.findings.filter((finding) => finding.status === 'precautionary').map((finding) => ({ severity: 'investigate', text: `${finding.allergen}: ${finding.explanation}` })),
    ...investigationFlags.map((flag) => ({ severity: 'investigate', text: `“${flag.text}”: ${flag.reason}` })),
  ];
  if (ingredients.status === 'missing') concerns.unshift({ severity: 'missing', text: 'A full ingredient/allergen assessment cannot be completed without the ingredient list.' });
  if (nutrition.status === 'missing') concerns.unshift({ severity: 'missing', text: 'A calorie and nutrient assessment cannot be completed without the nutrition panel.' });
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
    concerns,
    missingRequests,
    energyForQuantity,
    evidence: buildEvidence({ images: input.images || { label: input.image }, imageChecks: input.imageChecks, ingredients, nutrition }),
  };
}
