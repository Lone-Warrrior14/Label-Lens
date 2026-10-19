import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import tesseract from 'tesseract.js';
import { compareValidatorResults, parseValidatorJson } from '../src/core/validation.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '');
const port = Number(process.env.PORT || 4173);
const maxUploadBytes = 15 * 1024 * 1024;
const ollamaUrl = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const requestedValidatorA = process.env.OLLAMA_VALIDATOR_A || 'gemma3:latest';
const requestedValidatorB = process.env.OLLAMA_VALIDATOR_B || 'qwen3-vl:4b';
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

function chooseValidatorModels(available) {
  const fallbackOrder = ['qwen3-vl:4b', 'qwen2.5vl:7b', 'gemma3:latest'];
  const first = available.includes(requestedValidatorA) ? requestedValidatorA : available[0];
  const secondCandidates = [requestedValidatorB, ...fallbackOrder];
  const second = secondCandidates.find((candidate) => candidate !== first && available.includes(candidate));
  if (!first || !second) {
    throw new Error(`Dual validation needs two installed vision models. Available: ${available.join(', ') || 'none'}. Configure OLLAMA_VALIDATOR_A/B or install another vision model.`);
  }
  return [first, second];
}

function validatorPrompt(kind, ocrText) {
  const sectionInstructions = kind === 'nutrition'
    ? 'Extract every visible nutrition value. Keep kcal and kJ separate, preserve units, and label each value as per serving, per 100 g, per 100 ml, per container, or unknown. Do not infer missing values.'
    : 'Extract every visible ingredient in original order. Preserve parenthetical compound ingredients and any explicitly printed percentages. Do not infer percentages from order.';
  return `You are one independent validator in a food-label extraction system. The image is primary evidence; OCR is only an aid. ${sectionInstructions}

Return JSON only with this exact shape:
{
  "section_status": "present" | "partial" | "unreadable",
  "facts": [
    {"key": "stable field key or ingredient_1", "value": "exact visible value", "unit": "visible unit or empty", "basis": "visible basis or unknown", "evidence": "short exact text from image"}
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
      keep_alive: 0,
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
    return { model, status: 'ok', parsed: parseValidatorJson(raw), raw };
  } catch (error) {
    return { model, status: 'invalid', parsed: null, raw, error: error.message };
  }
}

async function handleDualValidation(request, response) {
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
      json(response, 400, { error: 'An image and non-empty OCR text are required for dual validation.' });
      return;
    }
    const models = chooseValidatorModels(await availableVisionModels());
    // Deliberately sequential: only one vision model is loaded at a time on a small GPU.
    const results = [];
    for (const model of models) results.push(await callOllamaValidator(model, image.data, kind, ocrText));
    json(response, 200, { kind, models, validators: results, comparison: compareValidatorResults(results), engine: 'local Ollama sequential dual validation' });
  } catch (error) {
    console.error('Dual validation failed:', error);
    json(response, 503, { error: `Dual validation unavailable: ${error.message}` });
  }
}

const server = createServer(async (request, response) => {
  if (request.method === 'POST' && request.url?.split('?')[0] === '/api/ocr') {
    await handleOcr(request, response);
    return;
  }
  if (request.method === 'POST' && request.url?.split('?')[0] === '/api/dual-validate') {
    await handleDualValidation(request, response);
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
