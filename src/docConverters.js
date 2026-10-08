// Document → Markdown engines, each running in its own lazily created Web Worker.
// Vite only bundles workers written as a literal `new Worker(new URL(...))`.
const WORKER_FACTORIES = {
  anydoc: () => new Worker(new URL('./workers/anydoc.worker.js', import.meta.url), { type: 'module' }),
  docling: () => new Worker(new URL('./workers/docling.worker.js', import.meta.url), { type: 'module' })
};

const ENGINE_NAMES = { anydoc: 'AnyDoc', docling: 'Docling' };

const workers = {};
let nextId = 0;

function friendlyMessage(engine, { code, pages, message }) {
  const name = ENGINE_NAMES[engine];
  switch (code) {
    case 'needsOcr':
      return pages?.length
        ? `This PDF has scanned or image-only pages (${pages.join(', ')}). ${name} cannot read them without OCR.`
        : `This PDF has no text layer (scanned or image-only). ${name} cannot read it without OCR.`;
    case 'encrypted':
      return 'The file is encrypted or password-protected. Remove the protection and try again.';
    case 'unsupported':
      return `${name} does not support this file type.`;
    case 'malformed':
    case 'missingPart':
      return 'The file appears to be damaged or incomplete, so no content could be extracted.';
    case 'resourceLimit':
      return 'The file exceeds a safety limit (size or complexity) and could not be converted.';
    case 'loadFailed':
      return `Failed to load the ${name} engine. Check your connection and try again.`;
    case 'empty':
      return 'No readable content was found in this document. It may be empty or require OCR.';
    default:
      return `${name} could not convert this file: ${message}`;
  }
}

function discardWorker(engine, state, error) {
  state.worker.terminate();
  if (workers[engine] === state) delete workers[engine];
  // Reject every request using a terminated worker, including concurrent callers.
  for (const request of [...state.pending.values()]) request.finish(error);
}

function getWorker(engine) {
  if (workers[engine]) return workers[engine];

  const state = { worker: WORKER_FACTORIES[engine](), pending: new Map() };
  state.worker.addEventListener('message', ({ data }) => {
    const request = state.pending.get(data?.id);
    if (!request) return;
    if (data.status) {
      request.onStatus?.(data.status);
      return;
    }
    if (data.fatal) {
      discardWorker(engine, state, new Error(friendlyMessage(engine, data)));
    } else if (!data.ok) {
      request.finish(new Error(friendlyMessage(engine, data)));
    } else if (typeof data.markdown !== 'string' || !data.markdown.trim()) {
      request.finish(new Error(friendlyMessage(engine, { code: 'empty' })));
    } else {
      request.finish(null, data.markdown);
    }
  });
  state.worker.addEventListener('error', () => {
    discardWorker(engine, state, new Error(friendlyMessage(engine, { code: 'loadFailed' })));
  });
  state.worker.addEventListener('messageerror', () => {
    discardWorker(engine, state, new Error(`${ENGINE_NAMES[engine]} returned an unreadable result. Please try again.`));
  });
  workers[engine] = state;
  return state;
}

export function convertDocumentToMarkdown(engine, file, { signal, onStatus } = {}) {
  if (!Object.hasOwn(WORKER_FACTORIES, engine)) {
    return Promise.reject(new Error('Unknown document conversion engine.'));
  }
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    let state;
    let settled = false;
    const finish = (error, markdown) => {
      if (settled) return;
      settled = true;
      state?.pending.delete(id);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(markdown);
    };
    const onAbort = () => {
      const error = new DOMException('Conversion cancelled.', 'AbortError');
      // WASM conversion is synchronous, so terminate the worker to stop it.
      if (state) discardWorker(engine, state, error);
      else finish(error);
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(() => file.arrayBuffer()).then(buffer => {
      if (settled) return;
      try {
        state = getWorker(engine);
        state.pending.set(id, { finish, onStatus });
        state.worker.postMessage({ id, name: file.name, buffer }, [buffer]);
      } catch (error) {
        if (state) discardWorker(engine, state, error);
        else finish(error);
      }
    }, finish);
  });
}
