// The package's default (bundler) entry imports the .wasm as an ES module,
// which Vite does not support natively, so use the web target with an explicit URL.
import init, { convert } from 'docling.rs-wasm/web';
import wasmUrl from 'docling.rs-wasm/web/docling_wasm_bg.wasm?url';

let ready = null;

self.onmessage = async ({ data: { id, name, buffer } }) => {
  let initialized = false;
  try {
    if (!ready) self.postMessage({ id, status: 'loading' });
    ready ??= init({ module_or_path: wasmUrl });
    await ready;
    initialized = true;
    self.postMessage({ id, status: 'converting' });

    const markdown = convert(new Uint8Array(buffer), name, 'md');
    self.postMessage({ id, ok: true, markdown });
  } catch (error) {
    const message = error?.message ?? String(error);
    const code = !initialized ? 'loadFailed'
      // This engine also uses this message for malformed PDFs, so avoid diagnosing a scan.
      : /no embedded text layer/i.test(message) ? 'noText'
      : /encrypted|password.protected/i.test(message) ? 'encrypted'
      : /not compiled in|unsupported|unknown format/i.test(message) ? 'unsupported'
      : /parse error|bad zip/i.test(message) ? 'malformed' : null;
    const fatal = !initialized || error instanceof WebAssembly.RuntimeError;
    self.postMessage({ id, ok: false, code, pages: null, message, fatal });
  }
};
