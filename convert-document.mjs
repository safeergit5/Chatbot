import { parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

async function convertPdf(bytes) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const assets = import.meta.resolve('pdfjs-dist/package.json');
  const assetPath = directory => fileURLToPath(new URL(directory, assets)).replaceAll('\\', '/');
  const task = getDocument({
    data: bytes,
    stopAtErrors: true,
    useSystemFonts: false,
    cMapUrl: assetPath('./cmaps/'),
    standardFontDataUrl: assetPath('./standard_fonts/'),
  });
  try {
    const pdf = await task.promise;
    const pages = [];
    let length = 0;
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const { items } = await page.getTextContent();
      let text = '';
      for (const item of items) {
        if ('str' in item) text += item.str + (item.hasEOL ? '\n' : '');
      }
      if (text.trim()) {
        const markdown = `### Page ${number}\n\n${text.trim()}`;
        pages.push(markdown);
        length += markdown.length + (pages.length > 1 ? 2 : 0);
      }
      page.cleanup();
      if (length > workerData.maxLength) throw new Error('too-long');
    }
    return pages.join('\n\n');
  } finally {
    await task.destroy();
  }
}

async function convertDocx(bytes) {
  const { default: mammoth } = await import('mammoth');
  const { default: Turndown } = await import('turndown');
  const { default: markdownPlugins } = await import('turndown-plugin-gfm');
  const { value: html } = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) }, {
    externalFileAccess: false,
    convertImage: mammoth.images.imgElement(async () => ({})),
  });
  const converter = new Turndown({ headingStyle: 'atx', bulletListMarker: '-' });
  converter.use(markdownPlugins.gfm);
  converter.addRule('tableWithoutHeader', {
    filter: node => node.nodeName === 'TABLE'
      && node.rows[0]?.parentNode.nodeName !== 'THEAD'
      && Array.from(node.rows[0]?.cells ?? []).some(cell => cell.nodeName === 'TD'),
    replacement: (content, node) => {
      const columns = node.rows[0].cells.length;
      const header = '|' + '   |'.repeat(columns);
      const separator = '|' + ' --- |'.repeat(columns);
      return `\n\n${header}\n${separator}\n${content.trim()}\n\n`;
    },
  });
  converter.addRule('singleLineTableCell', {
    filter: ['td', 'th'],
    replacement: (content, node) => {
      const prefix = node.previousElementSibling ? ' ' : '| ';
      const text = content.trim().replaceAll('|', '\\|').replace(/\s*\n\s*/g, ' ');
      return `${prefix}${text} |`;
    },
  });
  converter.remove('img');
  return converter.turndown(html).trim();
}

async function convertDoc(bytes) {
  const { default: WordExtractor } = await import('word-extractor');
  const document = await new WordExtractor().extract(Buffer.from(bytes));
  return [
    document.getBody(),
    document.getFootnotes(),
    document.getEndnotes(),
    document.getHeaders(),
  ].map(text => text.trim()).filter(Boolean).join('\n\n');
}

const converters = { pdf: convertPdf, docx: convertDocx, doc: convertDoc };
try {
  const markdown = await converters[workerData.format](workerData.bytes);
  parentPort.postMessage(markdown.length > workerData.maxLength ? { error: 'too-long' } : { markdown });
} catch (error) {
  parentPort.postMessage({ error: error.name === 'PasswordException' ? 'password'
    : error.message === 'too-long' ? 'too-long' : 'invalid' });
}
