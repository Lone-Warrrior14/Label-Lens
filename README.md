# LabelLens

LabelLens is a local, evidence-first food-label reader. It analyses the **ingredient list and nutrition panel together**, uses local Tesseract.js OCR to transcribe one image of each section, optionally sends each image to one local Ollama vision model for a structured cross-check, preserves the order and units supplied by the user, and marks missing or uncertain information instead of filling gaps.

The current implementation is a local Node/browser app using Node's built-in test runner. It uses an India/FSSAI-oriented interpretation profile for ingredient order and allergen prompts. It is not a legal compliance determination, food-safety guarantee or medical recommendation.

## What it does

- Accepts separate ingredient-list and nutrition-panel images.
- Runs Tesseract.js 7 OCR on the local Node server using a bundled English model; image bytes are not sent to a third-party OCR endpoint. Non-English or bilingual small print may need manual correction.
- Shows the OCR confidence estimate and keeps both transcriptions editable so users can correct small-print mistakes before analysis.
- Lets the user run OCR and local LLM processing separately, or runs both automatically when the main analysis form is submitted.
- Allows manual transcription of either label section when OCR is unavailable or does not find readable text.
- Retains top-level and parenthetical ingredient order, readable percentages and source text.
- Explains each ingredient's common identity and typical purpose without claiming an exact formulation.
- Detects declared ingredient/allergen aliases, `Contains` statements and precautionary `May contain` statements separately.
- Reads energy in kcal and kJ, serving size, serving basis, per-100-g/per-100-ml values, `% RDA/serve`, sugars, fats, protein, fibre, sodium, salt and other visible nutrients.
- Reconstructs multi-column nutrition tables from OCR rows plus LLM-read headers, preserving `Per 100 g`, `Per serving`, and visible `% RDA/serve` columns while keeping blank cells blank.
- Uses an India-oriented core nutrition set: energy, protein, carbohydrate, total sugars, added sugars, total fat, saturated fat, trans fat and sodium. Fibre, salt, cholesterol, vitamins and minerals are reported when visible but are not incorrectly marked as missing core fields when an Indian label does not declare them.
- Converts kcal ↔ kJ only when one is declared, and labels the result as derived using `1 kcal = 4.184 kJ`.
- Calculates planned-quantity calories only when a matching quantity basis is available.
- Provides a bounded, documented nutrition signal and a separate conservative A–D label signal rather than claiming a universal health score.
- Highlights an oil ingredient in either of the first two positions with **“Oil is high in the ingredient list”** and a transparent five-point adjustment; this flags prominence and does not infer an oil percentage.
- Clearly asks for another image or manual entry if ingredients or nutrition are absent/unreadable.
- Includes a light/dark theme toggle that follows the system preference initially and remembers the user's choice locally.

OCR is a transcription aid, not proof that every pixel was read correctly. The results screen always asks the user to compare the OCR text with the corresponding image. A low-confidence or empty OCR result remains uncertain and does not create invented ingredient or nutrient values.

## Setup

Requirements: Node.js `22.22.1` (the version is pinned in `.nvmrc`). No global package installation is required. The lockfile is `package-lock.json`.

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

The server reads these values from the process environment; `.env.example` is a reference file and is not loaded automatically.

If the configured model is not installed, the server uses the first installed vision model. Install the recommended local model with:

```bash
ollama pull gemma3:latest
```

Or choose the model for one run:

```bash
OLLAMA_MODEL=gemma3:latest \
npm start
```

The model receives the image and OCR transcription and returns strict JSON containing section status, visible headers, a corrected transcription, structured facts, and warnings. For nutrition images it is instructed to read `Per 100 g`, serving, `% RDA/serve`, optional fibre/salt rows, and any visible vitamins or minerals. A returned correction is applied to the editable field, shown in the evidence report, and must be reviewed against the original image. The deterministic parser still controls the report; the LLM does not invent values or determine the grade. If Ollama is unavailable, the application continues with OCR/manual text and clearly reports that LLM processing was not run.

In the form:

1. Upload a clear, tightly cropped image containing the ingredient list.
2. Upload a separate clear, tightly cropped image containing the nutrition panel.
3. Press **OCR and analyse label**; each image is sent to the local `/api/ocr` endpoint for bundled English Tesseract.js OCR. If OCR returns text, the app then calls the local `/api/llm-validate` endpoint for the selected Ollama vision model.
4. Review and correct both editable transcriptions, including parenthetical ingredient order, decimals, kcal/kJ units, serving basis, and `% RDA/serve` columns.
5. Enter any `Contains` or `May contain` statement if it is outside the ingredient image.
6. Optionally enter a planned quantity for a defensible calorie calculation.
7. Mark the two visual cross-check boxes only after comparing each transcription with its image.

The individual **Extract ingredients with OCR**, **Extract nutrition with OCR**, and **Process with local LLM** buttons can be used before submitting the report. When the model returns a corrected transcription, it is applied to the editable field and shown in the report for image review. If the model response is unusable, OCR remains the source. If an image is missing or unreadable, the report explicitly requests another image or manual entry and does not call itself a full-label analysis. Missing optional Indian nutrition rows do not make an otherwise readable label incomplete; they are reported as “not declared” rather than treated as zero.

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

Then open <http://localhost:4173>. The first OCR request may take longer while the local worker and English model initialize. Ollama is not installed inside this image; configure `OLLAMA_URL` to a reachable Ollama service if local LLM processing is needed from Docker.

## Report interpretation

The report currently contains these sections:

1. Product and serving information
2. LabelLens health signal, with one primary A–D grade when enough evidence is available
3. Ingredient-by-ingredient explanations
4. Ingredient order insights
5. Nutrition facts table, including kcal
6. Potential concerns and declared allergens
7. Transparent nutrition rating and scoring breakdown
8. Evidence, uncertainty and limitations

Ingredient order is explained as generally descending by weight under the selected India profile, subject to applicable exceptions. It never becomes an exact percentage. “No configured allergen alias detected” is not presented as allergen-free. Missing rows are not converted into zero.

The nutrition signal has six visible components: dietary fibre (10), protein (5), sodium (25), saturated fat (20), added sugars (20), and trans fat (20). It uses declared serving-basis `% RDA/serve` for the first five applicable components and the displayed trans-fat amount for the last. Unknown components widen the displayed range; they do not become assumed zeros. This is the documented nutrition input to the A–D signal, not a medical or universal health grade.

The prominent A–D health signal layers ingredient cues on top of that nutrition signal. Grades are A (75–100), B (55–74), C (35–54) and D (0–34). An oil in the first two ingredients receives a visible “oil is high in the ingredient list” highlight and a 5-point adjustment; a sweetener or refined flour in the first three ingredients receives a visible deduction; palm-derived fat receives a moderate deduction (more when it is in the first three), while hydrogenated fat, hydrogenated vegetable oil and vanaspati receive a substantially larger deduction. High declared sodium and saturated-fat `% RDA` receive a 3-point adjustment each; high added-sugars `% RDA` receives a 5-point adjustment. These adjustments are shown on the rating card and are not hidden inside an unexplained score.

See [`algorithm.md`](algorithm.md) for the summarized extraction, OCR, LLM, nutrition and A–D rating algorithm. The automated test suite uses text fixtures and does not require uploaded image files.
