import init, { formatFromBytes, formatFromExtension, toMarkdownBytes } from '@firecrawl/anydoc-wasm';
import wasmUrl from '@firecrawl/anydoc-wasm/anydoc_wasm_bg.wasm?url';

let ready = null;

self.onmessage = async ({ data: { id, name, buffer } }) => {
  let initialized = false;
  try {
    if (!ready) self.postMessage({ id, status: 'loading' });
    ready ??= init({ module_or_path: wasmUrl });
    await ready;
    initialized = true;
    self.postMessage({ id, status: 'converting' });

    const bytes = new Uint8Array(buffer);
    // Signature-less formats (CSV) can only be identified by extension
    const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
    const format = formatFromBytes(bytes) ?? formatFromExtension(ext);
    const markdown = toMarkdownBytes(bytes, format);

    self.postMessage({ id, ok: true, markdown });
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      code: initialized ? error?.code ?? null : 'loadFailed',
      pages: error?.pages ?? null,
      message: error?.message ?? String(error),
      fatal: !initialized || error instanceof WebAssembly.RuntimeError
    });
  }
};
