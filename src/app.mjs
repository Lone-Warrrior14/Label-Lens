import { analyzeLabel } from './core/analyze.mjs';

const $ = (selector) => document.querySelector(selector);

function element(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(attributes).forEach(([key, value]) => {
    if (value === null || value === undefined) return;
    if (key === 'className') node.className = value;
    else if (key === 'textContent') node.textContent = value;
    else node.setAttribute(key, value);
  });
  for (const child of children) {
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function statusTag(text, status) {
  return element('span', { className: `tag ${status}` }, [text]);
}

function basisLabel(basis) {
  return {
    per_serving: 'per serving',
    per_100g: 'per 100 g',
    per_100ml: 'per 100 ml',
    per_container: 'per container',
    unknown: 'basis not clear',
  }[basis] || basis?.replaceAll('_', ' ') || 'basis not clear';
}

function amountLabel(value) {
  if (value.displayAmount) return value.displayAmount;
  if (value.amount !== null && value.amount !== undefined) return String(value.amount);
  return 'not quantified';
}

function unitLabel(value) {
  return value.unit ? ` ${value.unit}` : '';
}

function statusLabel(status) {
  return {
    complete: 'Full label analysed',
    partial: 'Partial label analysis',
    present: 'Readable',
    missing: 'Missing',
    unreadable: 'Unreadable',
  }[status] || status.replaceAll('_', ' ');
}

function flattenWithPath(items, parentPath = []) {
  return items.flatMap((item, index) => {
    const path = [...parentPath, index + 1];
    return [{ item, path }, ...flattenWithPath(item.children || [], path)];
  });
}

function renderProductCard(report) {
  const card = element('article', { className: 'result-card' });
  card.append(element('div', { className: 'card-heading' }, [
    element('div', {}, [element('h3', {}, ['1. Product and serving information']), element('span', { className: 'card-kicker' }, ['What was supplied and what the values are based on'])]),
    statusTag(statusLabel(report.fullLabelStatus), report.fullLabelStatus === 'complete' ? 'present' : 'uncertain'),
  ]));
  const serving = report.nutrition.serving;
  const imageLabel = report.evidence.images.length
    ? report.evidence.images.map((image) => `${image.kind}: ${image.name}${image.ocrConfidence === null || image.ocrConfidence === undefined ? '' : ` (${image.ocrConfidence}% OCR)`}`).join(' · ')
    : 'Not supplied';
  const dualLabel = report.evidence.dualValidation.length
    ? report.evidence.dualValidation.map((validation) => `${validation.kind}: ${validation.status.replaceAll('_', ' ')}`).join(' · ')
    : 'Not run';
  const info = [
    ['Product', report.product.name],
    ['Serving size', serving.sizeText || 'Not declared / not readable'],
    ['Servings per container', serving.servingsPerContainer ? `${serving.servingsPerContainer}${serving.servingsApproximate ? ' (about)' : ''}` : 'Not declared / not readable'],
    ['Image evidence', imageLabel],
    ['Ingredients section', statusLabel(report.ingredients.status)],
    ['Nutrition section', statusLabel(report.nutrition.status)],
    ['Dual validation', dualLabel],
    ['Interpretation profile', report.profile.jurisdiction],
    ['Analysis status', report.fullLabelStatus === 'complete' ? 'Both sections readable' : 'Do not treat as complete'],
  ];
  card.append(element('div', { className: 'info-grid' }, info.map(([label, value]) => element('div', { className: 'info-tile' }, [element('span', { className: 'label' }, [label]), element('span', { className: 'value' }, [value])] ))));
  return card;
}

function renderIngredientsCard(report) {
  const card = element('article', { className: 'result-card' });
  card.append(element('div', { className: 'card-heading' }, [
    element('div', {}, [element('h3', {}, ['2. Ingredient-by-ingredient explanations']), element('span', { className: 'card-kicker' }, [`${report.ingredientCount} readable item${report.ingredientCount === 1 ? '' : 's'} retained in label order`])]),
  ]));
  if (!report.ingredients.items.length) {
    card.append(element('div', { className: 'alert' }, ['No ingredient items were supplied, so ingredient explanations and an allergen conclusion are not available.']));
    return card;
  }
  const table = element('table');
  table.append(element('thead', {}, [element('tr', {}, ['Order', 'Ingredient as declared', 'What it is', 'Typical purpose', 'Declared %'].map((text) => element('th', {}, [text])))]));
  const body = element('tbody');
  for (const { item, path } of flattenWithPath(report.ingredients.items)) {
    const nameCell = element('td', { className: 'ingredient-name' }, [element('strong', {}, [item.name]), element('span', { className: 'subtle' }, [`Original: ${item.raw}`])]);
    if (path.length > 1) nameCell.classList.add('nested');
    body.append(element('tr', {}, [
      element('td', {}, [path.join('.')]),
      nameCell,
      element('td', {}, [item.explanation]),
      element('td', {}, [item.purpose]),
      element('td', {}, [item.percentage === null ? 'Not declared' : `${item.percentage}% (declared)`]),
    ]));
  }
  table.append(body);
  card.append(element('div', { className: 'table-wrap' }, [table]));
  if (report.ingredients.warnings.length) card.append(element('ul', { className: 'notice-list' }, report.ingredients.warnings.map((warning) => element('li', {}, [warning]))));
  return card;
}

function renderOrderCard(report) {
  const card = element('article', { className: 'result-card' });
  card.append(element('div', { className: 'card-heading' }, [element('div', {}, [element('h3', {}, ['3. Ingredient order insights']), element('span', { className: 'card-kicker' }, ['Order is evidence, not a percentage'])])]));
  const text = report.ingredients.status === 'present'
    ? `The readable top-level ingredients are shown in the order supplied: ${report.ingredients.items.map((item) => item.name).join(' → ')}.`
    : 'Ingredient order cannot be interpreted until a readable ingredient list is supplied.';
  card.append(element('p', {}, [text]));
  card.append(element('ul', { className: 'notice-list' }, [
    element('li', {}, [report.profile.ingredientOrderRule]),
    element('li', {}, ['A later position can suggest lower relative weight than an earlier position, but LabelLens never infers an exact percentage from order alone.']),
    element('li', {}, ['Parenthetical compound ingredients retain their own order. Exceptions, grouped small-quantity ingredients and manufacturer-specific rules may need the original specification.']),
  ]));
  if (report.ingredients.unparsed) card.append(element('div', { className: 'alert' }, [`Text after the ingredient list was kept as a separate advisory: ${report.ingredients.unparsed}`]));
  return card;
}

function renderNutritionCard(report) {
  const card = element('article', { className: 'result-card' });
  card.append(element('div', { className: 'card-heading' }, [element('div', {}, [element('h3', {}, ['4. Nutrition facts table, including kcal']), element('span', { className: 'card-kicker' }, ['Original units and basis are preserved'])]), statusTag(statusLabel(report.nutrition.status), report.nutrition.status === 'present' ? 'present' : 'uncertain')]));
  if (!report.nutrition.values.length) {
    card.append(element('div', { className: 'alert' }, ['No nutrition values were readable. Upload another image or enter the panel manually; missing values are not treated as zero.']));
    return card;
  }
  const table = element('table');
  table.append(element('thead', {}, [element('tr', {}, ['Nutrient', 'Label value', 'Basis', '%DV', 'Evidence'].map((text) => element('th', {}, [text])))]));
  const body = element('tbody');
  const allVisibleValues = [...report.nutrition.values, ...(report.nutrition.otherVisible || [])];
  for (const value of allVisibleValues) {
    const evidence = value.derived ? `${value.derivation} · derived` : value.certainty.replaceAll('_', ' ');
    const label = value.displayName || value.nutrient.replaceAll('_', ' ');
    body.append(element('tr', {}, [
      element('td', {}, [element('strong', {}, [label]), value.nutrient === 'energy' ? element('span', { className: 'subtle' }, ['Calories and energy are shown separately from kJ.']) : value.nutrient === 'other_visible' ? element('span', { className: 'subtle' }, ['Additional visible row retained as supplied.']) : '']),
      element('td', {}, [`${amountLabel(value)}${unitLabel(value)}`]),
      element('td', {}, [basisLabel(value.basis)]),
      element('td', {}, [value.declaredDv === undefined ? 'Not declared' : `${value.declaredDv}%`]),
      element('td', {}, [evidence, value.warning ? element('span', { className: 'subtle' }, [value.warning]) : '']),
    ]));
  }
  table.append(body);
  card.append(element('div', { className: 'table-wrap' }, [table]));
  if (report.nutrition.missing.length) {
    card.append(element('p', { className: 'score-note' }, [`Not readable or not declared: ${report.nutrition.missing.map((item) => item.replaceAll('_', ' ')).join(', ')}. This does not mean those nutrients are zero.`]));
  }
  const energyValues = report.nutrition.values.filter((value) => value.nutrient === 'energy');
  const energyText = energyValues.length
    ? energyValues.map((value) => `${amountLabel(value)} ${value.unit || ''} ${basisLabel(value.basis)}${value.derived ? ' (derived, not visible on the label)' : ''}`).join(' · ')
    : 'No kcal value was readable.';
  const explanation = `Declared energy is the amount of food energy represented by the stated basis. It is not a count of “healthy” or “unhealthy” points: ${energyText}.`;
  const energyChildren = [element('strong', {}, ['What the calories mean']), element('p', {}, [explanation])];
  if (report.energyForQuantity) energyChildren.push(element('div', { className: 'energy-calculation' }, [`Planned quantity: ${report.energyForQuantity.kcal.toFixed(1)} kcal · ${report.energyForQuantity.method}`]));
  else if ($('#planned-quantity').value) energyChildren.push(element('p', { className: 'subtle' }, ['A planned quantity was entered, but no matching per-100 basis or serving size made a defensible calculation possible.']));
  card.append(element('div', { className: 'energy-explainer' }, energyChildren));
  return card;
}

function renderConcernsCard(report) {
  const card = element('article', { className: 'result-card' });
  card.append(element('div', { className: 'card-heading' }, [element('div', {}, [element('h3', {}, ['5. Potential concerns and declared allergens']), element('span', { className: 'card-kicker' }, ['Flags are prompts for investigation, not diagnoses'])])]));
  const panels = element('div', { className: 'two-panels' });
  const allergenPanel = element('div', { className: 'panel' }, [element('h3', {}, ['Declared / detected allergens'])]);
  if (report.allergens.status === 'unknown') {
    allergenPanel.append(element('p', {}, ['Unknown because the ingredient list was not supplied. Absence of a result is not an allergen-free claim.']));
  } else if (!report.allergens.findings.length) {
    allergenPanel.append(element('p', {}, ['No configured allergen alias was detected in the supplied text. This is not a guarantee that the product is allergen-free.']));
  } else {
    allergenPanel.append(element('div', { className: 'allergen-row' }, report.allergens.findings.map((finding) => element('div', { className: 'allergen-item' }, [
      element('strong', {}, [finding.allergen]),
      element('small', {}, [`${finding.status} · matched “${finding.matchedText}”`]),
    ]))));
  }
  const concernPanel = element('div', { className: 'panel' }, [element('h3', {}, ['Potential concerns / investigate'])]);
  if (!report.concerns.length) concernPanel.append(element('p', {}, ['No additional parser concern was raised. Always verify the original packaging before relying on the report.']));
  else concernPanel.append(element('ul', { className: 'notice-list' }, report.concerns.map((concern) => element('li', {}, [statusTag(concern.severity, concern.severity), ` ${concern.text}`]))));
  panels.append(allergenPanel, concernPanel);
  card.append(panels);
  return card;
}

function renderScoreCard(report) {
  const card = element('article', { className: 'result-card' });
  card.append(element('div', { className: 'card-heading' }, [element('div', {}, [element('h3', {}, ['6. Transparent rating and scoring breakdown']), element('span', { className: 'card-kicker' }, ['Separate nutrition signal — not a universal health score'])])]));
  const score = report.score;
  const scoreText = score.status === 'not_available' ? 'Not available' : score.status === 'not_enough_declared_data' ? 'Insufficient declared %DV' : score.low === score.high ? `${score.low}/100` : `${score.low}–${score.high}/100`;
  const scoreDescription = score.status === 'available' ? `${score.knownWeight} of ${score.maximumWeight} possible points are based on usable declared label data.` : score.status === 'not_enough_declared_data' ? 'Amounts without a clear serving-basis %DV are displayed but not converted into an unsupported universal rating.' : 'A nutrition panel is required before this separate nutrition signal can be calculated.';
  card.append(element('div', { className: 'score-hero' }, [element('div', { className: 'score-number' }, [scoreText]), element('p', {}, [scoreDescription])]));
  card.append(element('p', { className: 'score-note' }, [score.criteria || score.notice]));
  const table = element('table');
  // Build the table with text nodes so user-supplied label text is never HTML.
  table.append(element('thead', {}, [element('tr', {}, ['Component', 'Label evidence', 'Points', 'Why'].map((text) => element('th', {}, [text])))]));
  const body = element('tbody');
  for (const component of score.components) {
    const evidence = component.value ? `${amountLabel(component.value)}${unitLabel(component.value)} · ${basisLabel(component.value.basis)}${component.value.declaredDv === undefined ? '' : ` · ${component.value.declaredDv}% DV`}` : 'Not usable / missing';
    const points = component.low === null ? '—' : component.low === component.high ? `${component.low.toFixed(1)} / ${component.weight}` : `${component.low.toFixed(1)}–${component.high.toFixed(1)} / ${component.weight}`;
    body.append(element('tr', {}, [element('td', {}, [element('strong', {}, [component.label])]), element('td', {}, [evidence]), element('td', { className: 'points' }, [points]), element('td', {}, [component.explanation])]));
  }
  table.append(body);
  card.append(element('div', { className: 'table-wrap' }, [table]));
  return card;
}

function renderEvidenceCard(report) {
  const card = element('article', { className: 'result-card' });
  card.append(element('div', { className: 'card-heading' }, [element('div', {}, [element('h3', {}, ['7. Evidence, uncertainty and limitations']), element('span', { className: 'card-kicker' }, ['What this report can and cannot prove'])])]));
  const grid = element('div', { className: 'evidence-grid' });
  grid.append(element('div', { className: 'evidence-item' }, [element('h3', {}, ['Cross-check status']), element('p', {}, [report.evidence.crossCheckMessage])]));
  grid.append(element('div', { className: 'evidence-item' }, [element('h3', {}, ['Section completeness']), element('p', {}, [`Ingredients: ${statusLabel(report.evidence.sectionStatus.ingredients)} · Nutrition: ${statusLabel(report.evidence.sectionStatus.nutrition)}`])]));
  const dualText = report.evidence.dualValidation.length
    ? report.evidence.dualValidation.map((validation) => `${validation.kind}: ${validation.status.replaceAll('_', ' ')}${validation.correctionStatus && validation.correctionStatus !== 'not_run' ? ` · ${validation.correctionStatus.replaceAll('_', ' ')}` : ''}${validation.models.length ? ` (${validation.models.join(' + ')})` : ''}`).join(' · ')
    : 'Not run. The deterministic OCR transcription remains the source for analysis.';
  grid.append(element('div', { className: 'evidence-item' }, [element('h3', {}, ['Independent validators']), element('p', {}, [dualText])]));
  card.append(grid);
  for (const validation of report.evidence.dualValidation) {
    if (validation.correctionStatus === 'confirmed_correction' && validation.consensusText) {
      card.append(element('div', { className: 'llm-correction confirmed' }, [
        element('strong', {}, [`LLM correction confirmed for ${validation.kind}`]),
        element('p', {}, ['Both independent validators agreed on this corrected transcription, which was used for the deterministic analysis:']),
        element('pre', {}, [validation.consensusText]),
      ]));
    } else if (validation.status === 'conflict') {
      card.append(element('div', { className: 'llm-correction conflict' }, [
        element('strong', {}, [`LLM conflict for ${validation.kind}`]),
        element('p', {}, ['The validators returned different interpretations. No LLM correction was applied; verify the image manually.']),
        ...validation.correctedTexts.map((text, index) => element('pre', {}, [`Validator ${index + 1}:\n${text}`])),
      ]));
    }
  }
  card.append(element('ul', { className: 'source-list' }, report.evidence.sources.map((source) => element('li', {}, [source]))));
  if (report.missingRequests.length) card.append(element('div', { className: 'alert' }, [report.missingRequests.join(' ')]));
  card.append(element('p', { className: 'score-note' }, ['Ingredient explanations are typical-purpose descriptions, not a complete additive specification. Ingredient order does not reveal exact percentages. Values marked derived are conversions, not declarations visible on the package. A medical professional or manufacturer should answer medical, allergy and regulatory questions.']));
  return card;
}

function render(report) {
  const results = $('#results');
  const content = $('#results-content');
  clear(content);
  $('#completion-badge').textContent = statusLabel(report.fullLabelStatus);
  $('#completion-badge').className = `status-badge ${report.fullLabelStatus === 'complete' ? 'complete' : 'partial'}`;
  const alert = $('#completion-alert');
  clear(alert);
  if (report.fullLabelStatus !== 'complete') alert.append(element('div', { className: 'alert' }, ['Full-label analysis is not complete. ', ...report.missingRequests]));
  content.append(renderProductCard(report), renderIngredientsCard(report), renderOrderCard(report), renderNutritionCard(report), renderConcernsCard(report), renderScoreCard(report), renderEvidenceCard(report));
  results.classList.remove('hidden');
  results.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

const selectedImages = { ingredients: null, nutrition: null };
const ocrComplete = { ingredients: false, nutrition: false };
const ocrConfidence = { ingredients: null, nutrition: null };
const validationComplete = { ingredients: false, nutrition: false };
const validationResults = { ingredients: null, nutrition: null };
const imageRefs = {
  ingredients: {
    input: $('#ingredients-image'),
    preview: $('#ingredients-preview'),
    previewImage: $('#ingredients-preview-image'),
    name: $('#ingredients-image-name'),
    size: $('#ingredients-image-size'),
    button: $('#ingredients-ocr'),
    validateButton: $('#ingredients-validate'),
    status: $('#ingredients-ocr-status'),
    text: $('#ingredient-text'),
  },
  nutrition: {
    input: $('#nutrition-image'),
    preview: $('#nutrition-preview'),
    previewImage: $('#nutrition-preview-image'),
    name: $('#nutrition-image-name'),
    size: $('#nutrition-image-size'),
    button: $('#nutrition-ocr'),
    validateButton: $('#nutrition-validate'),
    status: $('#nutrition-ocr-status'),
    text: $('#nutrition-text'),
  },
};

function setOcrStatus(kind, message, state = '') {
  const status = imageRefs[kind].status;
  status.textContent = message;
  status.className = `ocr-status ${state}`;
}

function setSelectedImage(kind, file) {
  selectedImages[kind] = file || null;
  ocrComplete[kind] = false;
  ocrConfidence[kind] = null;
  validationComplete[kind] = false;
  validationResults[kind] = null;
  const refs = imageRefs[kind];
  refs.button.disabled = !file;
  refs.validateButton.disabled = true;
  if (!file) {
    refs.preview.classList.add('hidden');
    setOcrStatus(kind, 'Choose a clear, tightly cropped image.');
    return;
  }
  refs.name.textContent = file.name;
  refs.size.textContent = `${(file.size / 1024).toFixed(0)} KB · ${file.type || 'image'}`;
  refs.previewImage.src = URL.createObjectURL(file);
  refs.preview.classList.remove('hidden');
  setOcrStatus(kind, 'Ready. OCR runs locally when you analyse or press the button.');
}

async function runOcr(kind) {
  const file = selectedImages[kind];
  if (!file) {
    setOcrStatus(kind, 'Choose an image before running OCR.', 'error');
    return false;
  }
  const refs = imageRefs[kind];
  refs.button.disabled = true;
  setOcrStatus(kind, 'Running local OCR… this can take a moment for the first image.', 'busy');
  try {
    const formData = new FormData();
    formData.append('image', file, file.name);
    formData.append('kind', kind);
    const response = await fetch('/api/ocr', { method: 'POST', body: formData });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'OCR request failed.');
    refs.text.value = payload.text || '';
    ocrComplete[kind] = Boolean(payload.text);
    ocrConfidence[kind] = payload.confidence;
    validationComplete[kind] = false;
    validationResults[kind] = null;
    refs.validateButton.disabled = !payload.text;
    if (payload.text) {
      const confidence = payload.confidence === null ? 'confidence unavailable' : `${payload.confidence}% confidence estimate`;
      setOcrStatus(kind, `OCR complete · ${confidence}. Review the transcription against the image.`, 'success');
    } else {
      setOcrStatus(kind, payload.warning || 'OCR found no readable text. Enter this section manually.', 'error');
    }
    return Boolean(payload.text);
  } catch (error) {
    setOcrStatus(kind, `${error.message} You can still enter this section manually.`, 'error');
    return false;
  } finally {
    refs.button.disabled = false;
  }
}

async function runDualValidation(kind) {
  const file = selectedImages[kind];
  const ocrText = imageRefs[kind].text.value.trim();
  if (!file || !ocrText || validationComplete[kind]) return validationResults[kind];
  const refs = imageRefs[kind];
  refs.button.disabled = true;
  refs.validateButton.disabled = true;
  setOcrStatus(kind, 'OCR complete. Running two local validators sequentially…', 'busy');
  try {
    const formData = new FormData();
    formData.append('image', file, file.name);
    formData.append('kind', kind);
    formData.append('ocrText', ocrText);
    const response = await fetch('/api/dual-validate', { method: 'POST', body: formData });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Dual validation failed.');
    validationResults[kind] = payload;
    validationComplete[kind] = true;
    if (payload.comparison.status === 'agreement') {
      if (payload.comparison.correctionStatus === 'confirmed_correction' && payload.comparison.consensusText) {
        refs.text.value = payload.comparison.consensusText;
        setOcrStatus(kind, 'Both validators agreed and corrected the OCR transcription. Review the corrected text against the image.', 'success');
      } else {
        setOcrStatus(kind, 'OCR + two validators agree. Review the image before relying on the result.', 'success');
      }
    } else {
      setOcrStatus(kind, 'The two validators disagree. Review the highlighted uncertainty in the report.', 'error');
    }
    return payload;
  } catch (error) {
    validationResults[kind] = {
      kind,
      models: [],
      validators: [],
      comparison: { status: 'unavailable', conflicts: [error.message] },
    };
    setOcrStatus(kind, `Dual validation unavailable: ${error.message} OCR remains available.`, 'error');
    return validationResults[kind];
  } finally {
    refs.button.disabled = false;
    refs.validateButton.disabled = !refs.text.value.trim();
  }
}

for (const [kind, refs] of Object.entries(imageRefs)) {
  refs.input.addEventListener('change', (event) => setSelectedImage(kind, event.target.files?.[0] || null));
  refs.button.addEventListener('click', () => runOcr(kind));
  refs.validateButton.addEventListener('click', () => runDualValidation(kind));
  refs.text.addEventListener('input', () => {
    validationComplete[kind] = false;
    validationResults[kind] = null;
    refs.validateButton.disabled = !selectedImages[kind] || !refs.text.value.trim();
  });
}

$('#analysis-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = $('#form-error');
  const submitButton = event.submitter || $('#analysis-form button[type="submit"]');
  if (!selectedImages.ingredients && !selectedImages.nutrition && !$('#ingredient-text').value.trim() && !$('#contains-text').value.trim() && !$('#nutrition-text').value.trim()) {
    error.textContent = 'Choose an ingredient image, a nutrition image, or enter label text to begin. Missing sections will still be reported clearly.';
    error.classList.remove('hidden');
    return;
  }
  error.classList.add('hidden');
  submitButton.disabled = true;
  submitButton.textContent = 'Running OCR…';
  for (const kind of ['ingredients', 'nutrition']) {
    if (selectedImages[kind] && !ocrComplete[kind]) await runOcr(kind);
    if (selectedImages[kind] && imageRefs[kind].text.value.trim()) await runDualValidation(kind);
  }
  const ingredientText = $('#ingredient-text').value;
  const containsText = $('#contains-text').value;
  const nutritionText = $('#nutrition-text').value;
  render(analyzeLabel({
    productName: $('#product-name').value,
    ingredientText,
    containsText,
    nutritionText,
    plannedQuantity: $('#planned-quantity').value,
    plannedUnit: $('#planned-unit').value,
    images: {
      ingredients: selectedImages.ingredients ? { present: true, name: selectedImages.ingredients.name, type: selectedImages.ingredients.type, size: selectedImages.ingredients.size, ocrComplete: ocrComplete.ingredients, ocrConfidence: ocrConfidence.ingredients, validation: validationResults.ingredients } : { present: false },
      nutrition: selectedImages.nutrition ? { present: true, name: selectedImages.nutrition.name, type: selectedImages.nutrition.type, size: selectedImages.nutrition.size, ocrComplete: ocrComplete.nutrition, ocrConfidence: ocrConfidence.nutrition, validation: validationResults.nutrition } : { present: false },
    },
    imageChecks: { ingredientsChecked: $('#ingredients-checked').checked, nutritionChecked: $('#nutrition-checked').checked },
  }));
  submitButton.disabled = false;
  submitButton.textContent = 'OCR and analyse label →';
});
