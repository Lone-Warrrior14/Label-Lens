# LabelLens

LabelLens is a local, evidence-first food-label reader. It analyses the **ingredient list and nutrition panel together**, uses local Tesseract.js OCR to transcribe one image of each section, preserves the order and units supplied by the user, and marks missing or uncertain information instead of filling gaps.

The current implementation is a local Node/browser app using Node's built-in test runner. It uses an India/FSSAI-oriented interpretation profile for ingredient order and allergen prompts. It is not a legal compliance determination, food-safety guarantee or medical recommendation.

## What it does

- Accepts separate ingredient-list and nutrition-panel images.
- Runs Tesseract.js 7 OCR on the local Node server using a bundled English model; image bytes are not sent to a third-party OCR endpoint. Non-English or bilingual small print may need manual correction.
- Shows the OCR confidence estimate and keeps both transcriptions editable so users can correct small-print mistakes before analysis.
- Allows manual transcription of either label section when OCR is unavailable or does not find readable text.
- Retains top-level and parenthetical ingredient order, readable percentages and source text.
- Explains each ingredient's common identity and typical purpose without claiming an exact formulation.
- Detects declared ingredient/allergen aliases, `Contains` statements and precautionary `May contain` statements separately.
- Reads energy in kcal and kJ, serving size, serving basis, per-100-g/per-100-ml values, `% RDA/serve`, sugars, fats, protein, fibre, sodium, salt and other visible nutrients.
- Reconstructs multi-column nutrition tables from OCR pipes plus LLM-read headers, preserving per-100-g, per-serving and visible `%RDA` columns while keeping blank cells blank.
- Uses an India-oriented core nutrition set: energy, protein, carbohydrate, total sugars, added sugars, total fat, saturated fat, trans fat and sodium. Fibre, salt, cholesterol, vitamins and minerals are reported when visible but are not incorrectly marked as missing core fields when an Indian label does not declare them.
- Converts kcal ↔ kJ only when one is declared, and labels the result as derived using `1 kcal = 4.184 kJ`.
- Calculates planned-quantity calories only when a matching quantity basis is available.
- Provides a bounded, documented nutrition signal rather than an unsupported universal health score.
- Clearly asks for another image or manual entry if ingredients or nutrition are absent/unreadable.
- Includes a light/dark theme toggle that follows the system preference initially and remembers the user's choice locally.

OCR is a transcription aid, not proof that every pixel was read correctly. The results screen always asks the user to compare the OCR text with the corresponding image. A low-confidence or empty OCR result remains uncertain and does not create invented ingredient or nutrient values.

## Setup

Requirements: Node.js `22.22.1` (the version is pinned in `.nvmrc`). No global package installation is required.

```bash
npm ci
```

## Run

```bash
npm start
```

Open <http://localhost:4173>. The server binds to `0.0.0.0`; set `PORT` to use another local port:

```bash
PORT=4174 npm start
```

## Optional local LLM processing

LabelLens can use one local Ollama vision model after Tesseract OCR. A single model is selected and kept warm for five minutes so ingredient and nutrition images can be processed without loading two models or repeating the model startup for every section.

The defaults are:

```text
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=gemma3:latest
```

If the configured model is not installed, the server uses the first installed vision model. Install the recommended local model with:

```bash
ollama pull gemma3:latest
```

Or choose the model for one run:

```bash
OLLAMA_MODEL=gemma3:latest \
npm start
```

The model receives the image and OCR transcription and returns a corrected transcription plus structured facts. A returned correction is shown clearly and must be reviewed against the original image. If Ollama is unavailable, the application continues with local OCR and clearly reports that LLM processing was not run.

In the form:

1. Upload a clear, tightly cropped image containing the ingredient list.
2. Upload a separate clear, tightly cropped image containing the nutrition panel.
3. Press **OCR and analyse label**; the app sends each image only to the local `/api/ocr` endpoint and runs the bundled English Tesseract.js model.
4. Review and correct both editable OCR transcriptions, including parenthetical ingredient order, decimals, kcal/kJ units and serving basis.
5. Enter any `Contains` or `May contain` statement if it is outside the ingredient image.
6. Optionally enter a planned quantity for a defensible calorie calculation.
7. Mark the two visual cross-check boxes only after comparing each transcription with its image.

The individual **Extract ingredients with OCR**, **Extract nutrition with OCR**, and **Process with local LLM** buttons can be used before submitting the report. When the model returns a corrected transcription, it is applied to the editable field and shown in the report for image review. If the model response is unusable, OCR remains the source. If an image is missing or unreadable, the report explicitly requests another image or manual entry and does not call itself a full-label analysis.

## Test

The single reproducible check command is:

```bash
make test
```

It runs `npm test`, which uses only `node --test` and has no network dependency.

## Docker

```bash
docker build -t labellens .
docker run --rm -p 4173:4173 labellens
```

Then open <http://localhost:4173>. The first OCR request may take longer while the local worker and English model initialize.

## Report interpretation

The report always contains these sections:

1. Product and serving information
2. Ingredient-by-ingredient explanations
3. Ingredient order insights
4. Nutrition facts table, including kcal
5. Potential concerns and declared allergens
6. Transparent rating and scoring breakdown
7. Evidence, uncertainty and limitations

Ingredient order is explained as generally descending by weight under the selected India profile, subject to applicable exceptions. It never becomes an exact percentage. “No configured allergen alias detected” is not presented as allergen-free. Missing rows are not converted into zero.

The optional nutrition signal has six visible components: dietary fibre (10), protein (5), sodium (25), saturated fat (20), added sugars (20), and trans fat (20). It uses declared serving-basis `% RDA/serve` for the first five applicable components and the displayed trans-fat amount for the last. Unknown components widen the displayed range; they do not become assumed zeros. This is a documented label signal, not a health grade.

The prominent A–D health signal layers ingredient cues on top of that nutrition signal. Grades are A (75–100), B (55–74), C (35–54) and D (0–34). A sweetener or refined flour in the first three ingredients receives a visible deduction; palm-derived fat receives a moderate deduction (more when it is in the first three), while hydrogenated fat, hydrogenated vegetable oil and vanaspati receive a substantially larger deduction. High declared sodium and saturated-fat `% RDA` receive a 3-point adjustment each; high added-sugars `% RDA` receives a 5-point adjustment. These adjustments are shown on the rating card and are not hidden inside an unexplained score.

See [`algorithm.md`](algorithm.md) for the summarized extraction, OCR, LLM, nutrition and A–D rating algorithm.
