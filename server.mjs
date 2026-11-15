import { createServer } from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findPassages } from './search.mjs';
import { askGemini } from './gemini.mjs';
import { BlobPreconditionFailedError, get, put } from '@vercel/blob';

const port = Number(process.env.PORT ?? 3000);
const hosted = process.env.VERCEL === '1';
const password = process.env.DOCUMENT_DESK_PASSWORD;
const credentials = password ? `Basic ${Buffer.from(`document-desk:${password}`).toString('base64')}` : null;
const blobPath = 'document-desk/documents.md';
const localDataRoot = process.platform === 'win32'
  ? process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  : process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
const libraryDirectory = join(localDataRoot, 'Document Desk');
const library = join(libraryDirectory, 'documents.md');
const libraryHeading = '# Document library\n';
const maxDocumentLength = 200_000;
const maxUploadBytes = (hosted ? 4 : 10) * 1024 * 1024;
const maxLibraryLength = 700_000;
let pendingWrite = Promise.resolve();

function failure(status, message) {
  return Object.assign(new Error(message), { status });
}

async function readMarkdown() {
  if (hosted) {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      throw failure(503, 'Connect a private Vercel Blob store to enable the document library.');
    }
    const current = await get(blobPath, { access: 'private', useCache: false });
    if (!current) return { markdown: libraryHeading };
    return { markdown: await new Response(current.stream).text(), etag: current.blob.etag };
  }
  try {
    return { markdown: await readFile(library, 'utf8') };
  } catch (error) {
    if (error.code === 'ENOENT') return { markdown: libraryHeading };
    throw error;
  }
}

function parseLibrary(markdown) {
  const boundary = /\n## ([^\n]+)\n<!-- document:([\w-]+):(\d+) -->\n(`{3,})text\n/y;
  if (!markdown.startsWith(libraryHeading)) throw new Error('Invalid document library');
  boundary.lastIndex = libraryHeading.length;
  const documents = [];
  while (boundary.lastIndex < markdown.length) {
    const match = boundary.exec(markdown);
    if (!match) throw new Error('Invalid document header');
    const [, name, id, length, fence] = match;
    const end = boundary.lastIndex + Number(length);
    const closing = `\n${fence}\n`;
    if (markdown.slice(end, end + closing.length) !== closing) throw new Error('Invalid document boundary');
    documents.push({ id, name, content: markdown.slice(boundary.lastIndex, end) });
    boundary.lastIndex = end + closing.length;
  }
  return documents;
}

async function readLibrary() {
  return parseLibrary((await readMarkdown()).markdown);
}

function saveDocument(document) {
  const operation = pendingWrite.then(async () => {
    const fenceLength = [...document.content.matchAll(/`{3,}/g)]
      .reduce((length, match) => Math.max(length, match[0].length + 1), 3);
    const fence = '`'.repeat(fenceLength);
    const section = `\n## ${document.name}\n<!-- document:${document.id}:${document.content.length} -->\n${fence}text\n${document.content}\n${fence}\n`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const { markdown, etag } = await readMarkdown();
      const documents = parseLibrary(markdown);
      const total = documents.reduce((sum, item) => sum + item.content.length, document.content.length);
      if (total > maxLibraryLength || documents.length >= 100) {
        throw failure(413, 'The Markdown library is full (700,000 characters or 100 documents).');
      }
      const updated = markdown + section;
      if (!hosted) {
        const temporary = join(libraryDirectory, 'documents.tmp');
        await mkdir(libraryDirectory, { recursive: true });
        await writeFile(temporary, updated, 'utf8');
        await rename(temporary, library);
        return;
      }
      try {
        await put(blobPath, updated, {
          access: 'private',
          contentType: 'text/markdown; charset=utf-8',
          allowOverwrite: Boolean(etag),
          ifMatch: etag,
        });
        return;
      } catch (error) {
        if (error instanceof BlobPreconditionFailedError) continue;
        if (!etag && (await readMarkdown()).etag) continue;
        throw error;
      }
    }
    throw failure(409, 'The library changed during upload. Please try uploading again.');
  });
  pendingWrite = operation.catch(() => {});
  return operation;
}

async function readBody(request, maximum) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > maximum) throw failure(413, 'The upload or request exceeds the size limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw failure(415, 'Send a JSON request.');
  }
  const body = await readBody(request, 1_300_000);
  try {
    const value = JSON.parse(body.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw failure(400, 'Invalid JSON request.');
  }
}

function documentFormat(name) {
  if (typeof name !== 'string' || name.length > 240 || /[<>\p{Cc}]/u.test(name)) {
    throw failure(400, 'Choose a document with a valid filename.');
  }
  const format = /\.(md|markdown|txt|pdf|docx|doc)$/i.exec(name)?.[1].toLowerCase();
  if (!format) throw failure(400, 'Choose a PDF, Word, Markdown, or plain-text document.');
  return format;
}

async function convertUpload(format, bytes) {
  if (['md', 'markdown', 'txt'].includes(format)) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw failure(400, 'Save the text document with UTF-8 encoding and try again.');
    }
  }
  const worker = new Worker(new URL('./convert-document.mjs', import.meta.url), {
    workerData: { format, bytes: Uint8Array.from(bytes), maxLength: maxDocumentLength },
    resourceLimits: { maxOldGenerationSizeMb: 192 },
  });
  const result = await new Promise(resolve => {
    const timeout = setTimeout(() => resolve({ error: 'timeout' }), 30_000);
    worker.once('message', resolve);
    worker.once('error', () => resolve({ error: 'invalid' }));
    worker.once('exit', () => resolve({ error: 'invalid' }));
    worker.once('exit', () => clearTimeout(timeout));
  });
  await worker.terminate();
  if (result.error === 'too-long') throw failure(413, 'The converted document exceeds 200,000 characters.');
  if (result.error === 'password') throw failure(422, 'Unlock the PDF before uploading it.');
  if (result.error === 'timeout') throw failure(422, 'Conversion timed out. Try splitting the document into smaller files.');
  if (result.error) throw failure(422, 'Could not read this document. Check that it opens and matches its file extension.');
  if (!result.markdown.trim() && format === 'pdf') {
    throw failure(422, 'This PDF has no selectable text. Run OCR on the PDF before uploading it.');
  }
  return result.markdown;
}

async function answerQuestion({ question, sourceId, mode = 'offline' }) {
  if (typeof question !== 'string' || !question.trim() || question.length > 4_000) {
    throw failure(400, 'Enter a question of up to 4,000 characters.');
  }
  let documents = await readLibrary();
  if (sourceId) documents = documents.filter(document => document.id === sourceId);
  if (!documents.length) throw failure(400, 'Upload or select a document first.');

  if (mode === 'gemini') return askGemini(question.trim(), documents);
  if (mode === 'offline') return { citations: findPassages(question, documents) };
  throw failure(400, 'Choose Gemini or Offline.');
}

const assets = new Map([
  ['/', [new URL('./public/index.html', import.meta.url), 'text/html; charset=utf-8']],
  ['/app.js', [new URL('./public/app.js', import.meta.url), 'text/javascript; charset=utf-8']],
  ['/styles.css', [new URL('./public/styles.css', import.meta.url), 'text/css; charset=utf-8']],
]);

function authorized(request) {
  const digest = value => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(request.headers.authorization ?? ''), digest(credentials));
}

createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; form-action 'self' https://duckduckgo.com; frame-ancestors 'none'; base-uri 'none'");
  const send = (status, value) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(value));
  };

  try {
    const host = request.headers.host;
    if (!hosted && ![`localhost:${port}`, `127.0.0.1:${port}`].includes(host)) {
      throw failure(403, 'Open the app from its local address.');
    }
    if (!host || !/^[a-z0-9.-]+(?::\d+)?$/i.test(host)) throw failure(400, 'Invalid request host.');
    const origin = new URL(`${hosted ? 'https' : 'http'}://${host}`).origin;
    const { pathname, searchParams, origin: requestOrigin } = new URL(request.url, origin);
    if (requestOrigin !== origin || (request.headers.origin && request.headers.origin !== origin)) {
      throw failure(403, 'Use the app from the same site as this request.');
    }
    if (hosted && credentials && !authorized(request)) {
      response.setHeader('WWW-Authenticate', 'Basic realm="Document Desk", charset="UTF-8"');
      throw failure(401, 'Sign in to Document Desk.');
    }
    if (hosted && pathname.startsWith('/api/') && !credentials) {
      throw failure(503, 'Set DOCUMENT_DESK_PASSWORD in Vercel and redeploy to enable private document access.');
    }
    const asset = assets.get(pathname);
    if (request.method === 'GET' && asset) {
      const [filename, type] = asset;
      let content = await readFile(filename, 'utf8');
      if (hosted && pathname === '/') content = content.replace('data-hosted="false"', 'data-hosted="true"');
      response.writeHead(200, { 'Content-Type': type });
      response.end(content);
    } else if (request.method === 'GET' && pathname === '/api/documents') {
      const documents = await readLibrary();
      send(200, documents.map(({ id, name, content }) => ({ id, name, length: content.length })));
    } else if (request.method === 'POST' && pathname === '/api/documents') {
      let name;
      let content;
      if (request.headers['content-type'] === 'application/octet-stream') {
        name = searchParams.get('name');
        const format = documentFormat(name);
        content = await convertUpload(format, await readBody(request, maxUploadBytes));
      } else {
        ({ name, content } = await readJson(request));
        if (!['md', 'markdown', 'txt'].includes(documentFormat(name))) {
          throw failure(415, 'Upload PDF and Word files as binary data.');
        }
      }
      if (typeof content !== 'string' || !content.trim() || content.includes('\0')) {
        throw failure(400, 'The document must contain readable text.');
      }
      if (content.length > maxDocumentLength) throw failure(413, 'Documents can contain up to 200,000 characters.');
      const id = randomUUID();
      await saveDocument({ id, name, content });
      send(201, { id, name, length: content.length });
    } else if (request.method === 'POST' && pathname === '/api/ask') {
      send(200, await answerQuestion(await readJson(request)));
    } else {
      send(404, { error: 'Page not found.' });
    }
  } catch (error) {
    if (!error.status) console.error(error.message);
    send(error.status ?? 500, { error: error.status ? error.message : 'Could not process the request.' });
  }
}).listen(port, hosted ? undefined : '127.0.0.1', () => {
  console.log(`Document Desk is listening on port ${port}`);
});
