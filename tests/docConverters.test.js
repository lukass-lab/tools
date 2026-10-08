import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';

let moduleId = 0;
const documentFile = { name: 'report.csv', arrayBuffer: async () => new ArrayBuffer(4) };

async function harness(t) {
  const instances = [];
  const previousWorker = globalThis.Worker;
  globalThis.Worker = class extends EventTarget {
    constructor() { super(); instances.push(this); this.requests = []; }
    postMessage(data) { this.requests.push(data); }
    terminate() { this.terminated = true; }
    reply(data) { this.dispatchEvent(new MessageEvent('message', { data })); }
  };
  t.after(() => { globalThis.Worker = previousWorker; });
  const { convertDocumentToMarkdown } = await import(`../src/docConverters.js?test=${++moduleId}`);
  return { convert: convertDocumentToMarkdown, instances };
}

test('successful conversion reuses the worker and does not settle on status messages', async t => {
  const { convert, instances } = await harness(t);
  const statuses = [];
  const first = convert('anydoc', documentFile, { onStatus: status => statuses.push(status) });
  await setImmediate();
  const worker = instances[0];
  const id = worker.requests[0].id;
  worker.reply({ id, status: 'loading' });
  worker.reply({ id, status: 'converting' });
  worker.reply({ id: id + 100, ok: true, markdown: 'unrelated result' });
  worker.reply({ id, ok: true, markdown: '# Report' });
  assert.equal(await first, '# Report');
  assert.deepEqual(statuses, ['loading', 'converting']);
  const second = convert('anydoc', documentFile);
  await setImmediate();
  worker.reply({ id: worker.requests[1].id, ok: true, markdown: 'Second report' });
  assert.equal(await second, 'Second report');
  assert.equal(instances.length, 1);
});

test('a failed WASM load rejects all pending work and creates a new worker on retry', async t => {
  const { convert, instances } = await harness(t);
  const first = convert('docling', documentFile);
  const second = convert('docling', documentFile);
  const rejected = Promise.all([
    assert.rejects(first, /Failed to load the Docling engine/),
    assert.rejects(second, /Failed to load the Docling engine/)
  ]);
  await setImmediate();
  const worker = instances[0];
  worker.reply({ id: worker.requests[0].id, ok: false, fatal: true, code: 'loadFailed' });
  await rejected;
  assert.equal(worker.terminated, true);
  const retry = convert('docling', documentFile);
  await setImmediate();
  const replacement = instances[1];
  replacement.reply({ id: replacement.requests[0].id, ok: true, markdown: 'Recovered' });
  assert.equal(await retry, 'Recovered');
});

for (const eventName of ['error', 'messageerror']) {
  test(`${eventName} rejects the request and retires the worker`, async t => {
    const { convert, instances } = await harness(t);
    const pending = convert('anydoc', documentFile);
    const rejected = assert.rejects(pending, /Failed to load|unreadable result/);
    await setImmediate();
    instances[0].dispatchEvent(new Event(eventName));
    await rejected;
    assert.equal(instances[0].terminated, true);
  });
}

test('cancel terminates running work, ignores late replies and allows retry', async t => {
  const { convert, instances } = await harness(t);
  const controller = new AbortController();
  const pending = convert('anydoc', documentFile, { signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await setImmediate();
  const worker = instances[0];
  controller.abort();
  await rejected;
  assert.equal(worker.terminated, true);
  worker.reply({ id: worker.requests[0].id, ok: true, markdown: 'Late result' });
  const retry = convert('anydoc', documentFile);
  await setImmediate();
  instances[1].reply({ id: instances[1].requests[0].id, ok: true, markdown: 'Retried' });
  assert.equal(await retry, 'Retried');
});

test('cancel during file reading settles immediately and never starts a worker', async t => {
  const { convert, instances } = await harness(t);
  let finishReading;
  const file = { name: 'large.docx', arrayBuffer: () => new Promise(resolve => { finishReading = resolve; }) };
  const controller = new AbortController();
  const pending = convert('docling', file, { signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await setImmediate();
  controller.abort();
  await rejected;
  finishReading(new ArrayBuffer(0));
  await setImmediate();
  assert.equal(instances.length, 0);
});

test('empty results are rejected and a normal file error does not discard the engine', async t => {
  const { convert, instances } = await harness(t);
  const empty = convert('anydoc', documentFile);
  const emptyRejected = assert.rejects(empty, /No readable content/);
  await setImmediate();
  const worker = instances[0];
  worker.reply({ id: worker.requests[0].id, ok: true, markdown: ' \n ' });
  await emptyRejected;
  const scan = convert('anydoc', documentFile);
  const scanRejected = assert.rejects(scan, /pages \(2, 4\)/);
  await setImmediate();
  worker.reply({ id: worker.requests[1].id, ok: false, code: 'needsOcr', pages: [2, 4] });
  await scanRejected;
  assert.equal(worker.terminated, undefined);
  assert.equal(instances.length, 1);
});

test('unknown engines and file-reading errors reject without starting a worker', async t => {
  const { convert, instances } = await harness(t);
  await assert.rejects(convert('__proto__', documentFile), /Unknown document conversion engine/);
  await assert.rejects(convert('anydoc', { arrayBuffer: async () => { throw new Error('Read failed'); } }), /Read failed/);
  assert.equal(instances.length, 0);
});

test('a pre-cancelled request does not read the file', async t => {
  const { convert, instances } = await harness(t);
  let reads = 0;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(convert('anydoc', {
    name: 'report.csv', arrayBuffer: async () => { reads++; return new ArrayBuffer(0); }
  }, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(reads, 0);
  assert.equal(instances.length, 0);
});

test('a transfer error settles the request and retires the worker', async t => {
  const { convert, instances } = await harness(t);
  const first = convert('anydoc', documentFile);
  await setImmediate();
  const worker = instances[0];
  worker.reply({ id: worker.requests[0].id, ok: true, markdown: 'Ready' });
  await first;
  worker.postMessage = () => { throw new Error('Transfer failed'); };
  await assert.rejects(convert('anydoc', documentFile), /Transfer failed/);
  assert.equal(worker.terminated, true);
});
