import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import tesseract from 'tesseract.js';
import { correctionStatus, normalizeValidatorPayload, nutritionTextFromValidatorPayload, parseValidatorJson } from '../src/core/validation.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '');
const port = Number(process.env.PORT || 4173);
const maxUploadBytes = 15 * 1024 * 1024;
const ollamaUrl = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const requestedModel = process.env.OLLAMA_MODEL || 'gemma3:latest';
const validatorJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['section_status', 'section_header', 'headers', 'corrected_text', 'facts', 'warnings'],
  properties: {
    section_status: { type: 'string', enum: ['present', 'partial', 'unreadable'] },
    section_header: { type: 'string' },
    headers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'value', 'type', 'evidence'],
        properties: {
          name: { type: 'string' },
          value: { type: 'string' },
          type: { type: 'string', enum: ['section', 'serving', 'column', 'advisory', 'other'] },
          evidence: { type: 'string' },
          values: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['amount', 'unit', 'basis', 'percent_rda', 'evidence'],
              properties: {
                amount: { type: 'string' },
                unit: { type: 'string' },
                basis: { type: 'string' },
                percent_rda: { type: 'string' },
                evidence: { type: 'string' },
              },
            },
          },
        },
      },
    },
    corrected_text: { type: 'string' },
    facts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'value', 'unit', 'basis', 'values', 'evidence'],
        properties: {
          key: { type: 'string' },
          value: { type: 'string' },
          unit: { type: 'string' },
          basis: { type: 'string' },
          values: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['amount', 'unit', 'basis', 'percent_rda', 'evidence'],
              properties: {
                amount: { type: 'string' },
                unit: { type: 'string' },
                basis: { type: 'string' },
                percent_rda: { type: 'string' },
                evidence: { type: 'string' },
              },
            },
          },
          evidence: { type: 'string' },
        },
      },
    },
    warnings: { type: 'array', items: { type: 'string' } },
  },
};
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};
const { createWorker } = tesseract;
const ocrPaths = {
  corePath: join(root, 'node_modules', 'tesseract.js-core'),
  langPath: join(root, 'node_modules', '@tesseract.js-data', 'eng', '4.0.0'),
  workerPath: join(root, 'node_modules', 'tesseract.js', 'src', 'worker-script', 'node', 'index.js'),
  cachePath: join(root, '.ocr-cache'),
};
let ocrWorkerPromise;

function json(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    request.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxUploadBytes) {
        reject(new Error(`Image exceeds the ${maxUploadBytes / 1024 / 1024} MB upload limit.`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function parseMultipart(body, contentType) {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) throw new Error('The upload did not include a multipart boundary.');
  const boundary = Buffer.from(`--${boundaryMatch[1] || boundaryMatch[2]}`);
  const parts = [];
  let cursor = body.indexOf(boundary);
  while (cursor !== -1) {
    const start = cursor + boundary.length;
    const next = body.indexOf(boundary, start);
    if (next === -1) break;
    const part = body.subarray(start, next);
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd !== -1) {
      const headers = part.subarray(0, headerEnd).toString('utf8');
      let data = part.subarray(headerEnd + 4);
      if (data.subarray(-2).toString() === '\r\n') data = data.subarray(0, -2);
      const name = headers.match(/name="([^"]+)"/i)?.[1];
      const filename = headers.match(/filename="([^"]*)"/i)?.[1] || '';
      const type = headers.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim() || '';
      if (name) parts.push({ name, filename, type, data });
    }
    cursor = next;
  }
  return parts;
}

async function getOcrWorker() {
  if (!ocrWorkerPromise) {
    await mkdir(ocrPaths.cachePath, { recursive: true });
    ocrWorkerPromise = createWorker('eng', 1, {
      ...ocrPaths,
      gzip: true,
      logger: () => {},
      errorHandler: () => {},
    }).catch((error) => {
      ocrWorkerPromise = undefined;
      throw error;
    });
  }
  return ocrWorkerPromise;
}

async function runOcr(image, kind) {
  const worker = await getOcrWorker();
  await worker.setParameters({
    preserve_interword_spaces: '1',
    tessedit_pageseg_mode: kind === 'nutrition' ? '6' : '6',
  });
  const result = await worker.recognize(image);
  const text = result?.data?.text?.trim() || '';
  const confidence = Number.isFinite(result?.data?.confidence) ? Math.round(result.data.confidence) : null;
  return { text, confidence };
}

async function handleOcr(request, response) {
  try {
    const contentType = request.headers['content-type'] || '';
    if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
      json(response, 415, { error: 'Send the image as multipart/form-data.' });
      return;
    }
    const body = await readBody(request);
    const parts = parseMultipart(body, contentType);
    const image = parts.find((part) => part.name === 'image');
    const kind = parts.find((part) => part.name === 'kind')?.data.toString('utf8').trim() || 'label';
    if (!image || !image.data.length) {
      json(response, 400, { error: 'No image file was uploaded.' });
      return;
    }
    if (image.type && !image.type.toLowerCase().startsWith('image/')) {
      json(response, 415, { error: 'Only image uploads are supported.' });
      return;
    }
    const result = await runOcr(image.data, kind);
    json(response, 200, {
      kind,
      filename: image.filename,
      text: result.text,
      confidence: result.confidence,
      warning: result.text ? null : 'OCR did not find readable text. Upload a sharper, well-lit crop or enter the section manually.',
      engine: 'Tesseract.js 7 · English model · local server',
    });
  } catch (error) {
    console.error('OCR request failed:', error);
    json(response, 500, { error: `OCR failed: ${error.message}` });
  }
}

async function availableVisionModels() {
  const response = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status} while listing models.`);
  const payload = await response.json();
  return (payload.models || [])
    .filter((model) => (model.capabilities || model.details?.capabilities || []).includes('vision'))
    .map((model) => model.name);
}

function chooseValidatorModel(available) {
  const model = available.includes(requestedModel) ? requestedModel : available[0];
  if (!model) {
    throw new Error(`No installed vision model was found. Install gemma3:latest or configure OLLAMA_MODEL. Available: ${available.join(', ') || 'none'}.`);
  }
  return model;
}

function validatorPrompt(kind, ocrText) {
  const sectionInstructions = kind === 'nutrition'
    ? 'Extract every visible nutrition value and every nutrition header. First identify the complete column header row and then read each row across all numeric columns from left to right. This image may use four columns: row label, Per 100 g, Per serve 15 g, and % RDA/serve. Capture headers such as Nutrition Information, Serving size, Servings per container, Per serving, Per 100 g, Per serve 15 g and % RDA/serve. Keep kcal and kJ separate, preserve units, and label each value with its visible basis. Check explicitly for these rows if visible: Energy, Protein, Carbohydrate, Total Sugars, Added Sugars, Total Fat, Saturated Fat, Trans Fat, Dietary Fibre, Salt, Cholesterol and Sodium, plus any visible vitamin or mineral rows. The OCR may omit or misspell a row, so inspect the image rather than copying OCR blindly. For every nutrition row, the values array MUST contain one object for EVERY visible numeric cell in left-to-right order, including empty percent cells; never collapse a row to only its first value. Put % RDA numbers in percent_rda, not amount. Use empty strings for unreadable or blank cells and add a warning. The corrected_text MUST preserve the complete table structure with all readable columns. Do not infer missing values.'
    : 'Extract every visible ingredient in original order and every visible section/advisory header. Capture headers such as Ingredients, Contains and May contain. Preserve parenthetical compound ingredients and any explicitly printed percentages. Do not infer percentages from order.';
  return `You are one independent validator in a food-label extraction system. The image is primary evidence; OCR is only an aid. ${sectionInstructions}

Return JSON only with this exact shape:
{
  "section_status": "present" | "partial" | "unreadable",
  "section_header": "exact main section heading, or empty if unreadable",
  "headers": [
    {"name": "exact visible header", "value": "header value or empty", "type": "section | serving | column | advisory | other", "evidence": "short exact text from image"}
  ],
  "corrected_text": "exact complete transcription supported by the image, preserving line order and visible units",
  "facts": [
    {"key": "stable field key or ingredient_1", "value": "first or primary exact visible value", "unit": "visible unit or empty", "basis": "visible basis or unknown", "values": [{"amount": "exact amount", "unit": "visible unit", "basis": "column header basis", "percent_rda": "visible percent or empty", "evidence": "short exact cell text"}], "evidence": "short exact text from image"}
  ],
  "warnings": ["only visible uncertainty or conflict"]
}

Rules: never invent, never fill a blank with zero, never calculate an ingredient percentage from order, and use needs-review warnings for blurry or conflicting text. The OCR transcription follows for comparison:
---
${String(ocrText || '').slice(0, 50000)}
---`;
}

async function callOllamaValidator(model, image, kind, ocrText) {
  const response = await fetch(`${ollamaUrl}/api/chat`, {
    method: 'POST',
    signal: AbortSignal.timeout(180000),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      format: validatorJsonSchema,
        // Keep one model warm while the user validates the second image.
        // This avoids loading two models and avoids reloading one between sections.
        keep_alive: '5m',
      options: { temperature: 0, num_ctx: 8192, num_predict: 2048 },
      messages: [
        { role: 'system', content: 'You are a conservative, evidence-first food-label validator. Do not reveal reasoning; return only the requested JSON.' },
        { role: 'user', content: validatorPrompt(kind, ocrText), images: [image.toString('base64')] },
      ],
    }),
  });
  if (!response.ok) throw new Error(`${model} returned HTTP ${response.status}.`);
  const payload = await response.json();
  const raw = payload.message?.content || '';
  try {
    return { model, status: 'ok', parsed: normalizeValidatorPayload(parseValidatorJson(raw)), raw };
  } catch (error) {
    return { model, status: 'invalid', parsed: null, raw, error: error.message };
  }
}

async function handleLlmValidation(request, response) {
  try {
    const contentType = request.headers['content-type'] || '';
    if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
      json(response, 415, { error: 'Send the image and OCR text as multipart/form-data.' });
      return;
    }
    const body = await readBody(request);
    const parts = parseMultipart(body, contentType);
    const image = parts.find((part) => part.name === 'image');
    const kind = parts.find((part) => part.name === 'kind')?.data.toString('utf8').trim() || 'label';
    const ocrText = parts.find((part) => part.name === 'ocrText')?.data.toString('utf8') || '';
    if (!image?.data.length || !ocrText.trim()) {
      json(response, 400, { error: 'An image and non-empty OCR text are required for LLM validation.' });
      return;
    }
    const model = chooseValidatorModel(await availableVisionModels());
    const validator = await callOllamaValidator(model, image.data, kind, ocrText);
    const parsed = validator.parsed;
    const canonicalText = kind === 'nutrition' ? nutritionTextFromValidatorPayload(parsed, ocrText) : parsed?.corrected_text;
    if (parsed && canonicalText) parsed.corrected_text = canonicalText;
    const consensusText = String(canonicalText || '').trim() || null;
    const correctionState = validator.status !== 'ok' ? 'needs_review' : correctionStatus(consensusText, ocrText);
    const validation = {
      kind,
      model,
      status: validator.status,
      raw: validator.raw,
      parsed,
      error: validator.error || null,
      correctionStatus: correctionState,
      consensusText,
    };
    json(response, 200, {
      kind,
      model,
      validator,
      comparison: {
        status: 'single_model',
        correctionStatus: correctionState,
        consensusText,
        correctedTexts: consensusText ? [consensusText] : [],
        conflicts: [],
      },
      validation,
      engine: 'local Ollama single vision validator',
    });
  } catch (error) {
    console.error('LLM validation failed:', error);
    json(response, 503, { error: `LLM validation unavailable: ${error.message}` });
  }
}

const server = createServer(async (request, response) => {
  if (request.method === 'POST' && request.url?.split('?')[0] === '/api/ocr') {
    await handleOcr(request, response);
    return;
  }
  if (request.method === 'POST' && request.url?.split('?')[0] === '/api/llm-validate') {
    await handleLlmValidation(request, response);
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    json(response, 405, { error: 'Method not allowed.' });
    return;
  }
  const requested = decodeURIComponent((request.url || '/').split('?')[0]);
  const relative = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');
  const file = normalize(join(root, relative));

  if (!file.startsWith(`${root}${sep}`) || !existsSync(file) || !statSync(file).isFile()) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-type': contentTypes[extname(file)] || 'application/octet-stream',
  });
  createReadStream(file).pipe(response);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`LabelLens is running at http://localhost:${port}`);
});
