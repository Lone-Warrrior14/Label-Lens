import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import tesseract from 'tesseract.js';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '');
const port = Number(process.env.PORT || 4173);
const maxUploadBytes = 15 * 1024 * 1024;
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

const server = createServer(async (request, response) => {
  if (request.method === 'POST' && request.url?.split('?')[0] === '/api/ocr') {
    await handleOcr(request, response);
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
