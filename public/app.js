const element = id => document.getElementById(id);
const documents = element('documents');
const source = element('source');
const mode = element('mode');
const files = element('files');
const question = element('question');
const send = element('send');
const messages = element('messages');
const askStatus = element('ask-status');
const uploadStatus = element('upload-status');

async function api(path, body) {
  const response = await fetch(path, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error);
  return value;
}

function node(tag, text, className) {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (className) item.className = className;
  return item;
}

async function loadLibrary(selected = source.value) {
  const library = await api('/api/documents');
  element('count').textContent = library.length;
  documents.replaceChildren();
  source.replaceChildren(new Option('All documents', ''));
  for (const item of library) {
    const button = node('button', item.name, 'document');
    button.type = 'button';
    button.dataset.id = item.id;
    button.addEventListener('click', () => {
      source.value = item.id;
      updateSource();
    });
    const row = node('li');
    row.append(button);
    documents.append(row);
    source.add(new Option(item.name, item.id));
  }
  source.value = library.some(item => item.id === selected) ? selected : '';
  updateSource();
}

function updateSource() {
  for (const button of documents.querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.id === source.value));
  }
}

source.addEventListener('change', updateSource);
mode.addEventListener('change', () => {
  element('mode-note').textContent = mode.value === 'gemini'
    ? 'Gemini receives your question and the selected document text.'
    : 'Your question and documents stay on this computer.';
  element('model-status').textContent = 'Local app';
});
files.addEventListener('change', async () => {
  const selected = Array.from(files.files);
  if (!selected.length) return;
  files.disabled = true;
  uploadStatus.textContent = 'Uploading and converting documents…';
  const errors = [];
  const saved = [];
  for (const file of selected) {
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('This file exceeds the 10 MB upload limit.');
      const query = new URLSearchParams({ name: file.name });
      const response = await fetch(`/api/documents?${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      saved.push(result);
    } catch (error) {
      errors.push(`${file.name}: ${error.message}`);
    }
  }
  try {
    await loadLibrary(saved.length === 1 ? saved[0].id : saved.length ? '' : source.value);
  } catch (error) {
    errors.push(error.message);
  } finally {
    files.value = '';
    files.disabled = false;
    uploadStatus.textContent = [
      saved.length ? `Uploaded ${saved.length} document${saved.length === 1 ? '' : 's'}.` : '',
      ...errors,
    ].filter(Boolean).join(' ');
  }
});

element('ask').addEventListener('submit', async event => {
  event.preventDefault();
  if (send.disabled) return;
  if (source.options.length === 1) {
    askStatus.textContent = 'Upload a document first.';
    files.focus();
    return;
  }
  const text = question.value.trim();
  if (!text) return;
  element('intro').hidden = true;
  const turn = node('article', undefined, 'turn');
  turn.append(node('p', text, 'user-message'));
  const answer = node('div', undefined, 'assistant-message');
  turn.append(answer);
  messages.append(turn);
  send.disabled = true;
  askStatus.textContent = 'Looking for relevant passages…';
  try {
    const requestedMode = mode.value;
    const { citations, model } = await api('/api/ask', { question: text, sourceId: source.value, mode: requestedMode });
    if (mode.value === requestedMode) element('model-status').textContent = model ?? 'Offline document search';
    if (question.value.trim() === text) question.value = '';
    if (!citations.length) answer.append(node('p', 'I couldn’t find a matching passage. Try using the terms that appear in your documents.'));
    for (const { name, quote } of citations) {
      const passage = node('figure');
      passage.append(node('blockquote', quote), node('figcaption', name));
      answer.append(passage);
    }
    askStatus.textContent = '';
  } catch (error) {
    turn.remove();
    element('intro').hidden = messages.childElementCount > 0;
    askStatus.textContent = error.message;
  } finally {
    send.disabled = false;
    turn.scrollIntoView({ block: 'nearest' });
  }
});

question.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    element('ask').requestSubmit();
  }
});

loadLibrary().catch(error => { uploadStatus.textContent = error.message; });
