# LabelLens algorithm

This is a short summary of how LabelLens turns two label images into a report. The system is evidence-first: it preserves what is visible, marks uncertainty, and never invents missing label values.

## 1. Image extraction

1. The user uploads an ingredient-list image and a nutrition-panel image.
2. Local Tesseract.js OCR transcribes each image separately.
3. The OCR text is placed in editable fields so the user can correct small-print errors.
4. The app keeps the image, OCR text, OCR confidence and section identity as evidence.

## 2. Optional local LLM processing

The user can run one local Ollama vision model after OCR. The default is `gemma3:latest`, configurable with `OLLAMA_MODEL`.

The model receives:

- The original section image
- The OCR transcription
- Section-specific instructions

It returns JSON containing a corrected transcription and structured facts. If a corrected transcription is returned, LabelLens displays it and applies it to the editable text for review. The user must still compare it with the original image.

The LLM does not determine the final grade, infer exact ingredient percentages, fill missing nutrient values, or override the deterministic parser. If Ollama is unavailable or returns unusable data, OCR/manual text remains available.

## 3. Ingredient analysis

1. Remove only the `Ingredients:` heading.
2. Split at top-level commas, semicolons and line breaks while respecting parentheses.
3. Preserve top-level order and nested compound-ingredient order.
4. Keep explicitly printed percentages, but never infer percentages from position.
5. Attach a typical identity and purpose explanation from the ingredient dictionary.
6. Match configured allergen aliases in ingredients and `Contains`/`May contain` statements.
7. Keep precautionary statements separate from confirmed ingredient matches.

## 4. Nutrition analysis

The parser retains each visible nutrient value with:

- Nutrient name
- Amount
- Original unit
- Basis, such as per serving, per 100 g or per 100 ml
- Declared `% RDA/serve` or equivalent printed contribution, if visible
- OCR/source text
- Certainty state

The Indian label profile treats energy, protein, carbohydrate, total sugars, added sugars, total fat, saturated fat, trans fat and sodium as the core nutrition fields. Fibre, salt, cholesterol, vitamins and minerals are optional label fields: if they are absent, LabelLens says they were not declared rather than incorrectly calling the Indian label incomplete or treating them as zero. Printed `%RDA`/`% contribution` values remain tied to the label's stated serving.

For multi-column Indian-style tables, the LLM JSON includes the header row and the OCR pipe-separated rows are rebuilt into explicit `Per 100 g` and `Per serving` blocks. OCR decimal-loss errors such as `2831`, `4246`, `006` and `1026` are repaired using the visible column relationship and the serving header. A row read by the vision model but dropped by OCR is retained as an uncertain first-column value rather than silently discarded. Blank `%RDA` cells stay blank.

Energy values stay separate as kcal and kJ. If only one is declared, the other may be shown as a clearly marked conversion using:

```text
1 kcal = 4.184 kJ
```

Missing rows are not converted to zero. Bounded values such as `less than 1 g` remain bounded. Conflicting kcal/kJ values are flagged for review.

## 5. Transparent nutrition signal

The base nutrition signal is 0–100 with these weights:

| Component | Weight | Direction |
|---|---:|---|
| Dietary fibre | 10 | Higher declared `% RDA` helps |
| Protein | 5 | Higher declared `% RDA` helps |
| Sodium | 25 | Higher declared `% RDA` hurts |
| Saturated fat | 20 | Higher declared `% RDA` hurts |
| Added sugars | 20 | Higher declared `% RDA` hurts |
| Trans fat | 20 | Displayed zero helps; positive amount hurts |

For fibre and protein, the positive target is 20% RDA. For sodium, saturated fat and added sugars, the negative target is 100% RDA. Only declared, usable serving-basis data is scored. Missing or uncertain components widen the score range instead of being assumed healthy or unhealthy.

## 6. A–D label signal

The prominent A–D card starts with the nutrition signal, then applies visible ingredient and priority-flag adjustments:

- Oil in the first two ingredients: −5, with a visible “oil is high in the ingredient list” highlight. This flags prominence in the ordered list; it does not infer an exact oil percentage.
- Sweetener in the first three ingredients: −8
- Refined flour in the first three ingredients: −5
- Multiple sweetening ingredients: −4
- Palm-derived fat: −3, or −6 when in the first three ingredients
- Hydrogenated fat, hydrogenated vegetable oil or vanaspati: −15, plus up to two additional −4 adjustments when multiple declarations are visible
- Sodium at or above 20% RDA: −3
- Saturated fat at or above 20% RDA: −3
- Added sugars at or above 20% RDA: −5
- Whole-grain or less-refined grain in the first three ingredients: +2

The resulting score maps to:

```text
A: 75–100
B: 55–74
C: 35–54
D: 0–34
```

If missing data creates a range, the card still shows one conservative primary grade based on the lower-bound score. The numeric range and grade range remain visible in the status text so uncertainty is not hidden behind an optimistic grade. If either label section is missing or too incomplete, no grade is issued.

This is a transparent label signal, not medical advice, an allergy-safety guarantee, or a universal definition of a healthy product. The detailed tables and evidence section remain the source of explanation below the summary card.
