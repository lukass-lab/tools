import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import JSZip from 'jszip';

// Run against the production build and installed Chrome/Chromium; no extra test dependencies.
const root = fileURLToPath(new URL('../../', import.meta.url));
const browserCandidates = process.env.CHROME_PATH ? [process.env.CHROME_PATH] : [
  ...[process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
    .filter(Boolean).flatMap(dir => [
      path.join(dir, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(dir, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    ]),
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
  '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
];
let chromePath;
for (const candidate of browserCandidates) {
  try { await fs.access(candidate); chromePath = candidate; break; } catch {}
}
if (!chromePath) throw new Error('Chrome/Chromium was not found. Set CHROME_PATH to its executable path.');
await fs.access(path.join(root, 'docs', 'index.html'));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'medical-tools-browser-'));
const requests = [];
let failWasm = false;
let holdWasm = false;
const heldResponses = [];
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  requests.push(url.pathname);
  if (url.pathname.includes('anydoc_wasm_bg')) {
    if (holdWasm) {
      await new Promise(resolve => { heldResponses.push(resolve); res.on('close', resolve); });
      if (res.destroyed) return;
    }
    if (failWasm) { failWasm = false; res.writeHead(503); res.end('Simulated unavailable engine'); return; }
  }
  const rel = url.pathname.replace(/^\/tools\/?/, '') || 'index.html';
  const file = path.resolve(root, 'docs', rel);
  if (!file.startsWith(path.join(root, 'docs') + path.sep)) { res.writeHead(404); res.end(); return; }
  try {
    const content = await fs.readFile(file);
    const types = { '.wasm': 'application/wasm', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(content);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
let launchError;
chrome.on('error', error => { launchError = error; });
const browserExited = new Promise(resolve => chrome.once('close', resolve));
chrome.stderr.on('data', data => { stderr += data; });
let cdp;
let navigationId = 0;
const failures = [];
const alerts = [];

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const pending = new Map();
  const listeners = new Map();
  let nextId = 0;
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timeout);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    } else {
      for (const fn of listeners.get(message.method) || []) fn(message.params);
    }
  };
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
        pending.set(id, { resolve, reject, timeout });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    on(method, fn) { listeners.set(method, [...listeners.get(method) || [], fn]); },
    close() { ws.close(); }
  };
}

async function evaluate(expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function waitFor(expression, label = expression) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { if (await evaluate(expression)) return; }
    catch (error) {
      if (!/Execution context was destroyed|Cannot find context/.test(error.message)) throw error;
    }
    await delay(30);
  }
  throw new Error(`Timed out: ${label}`);
}
async function navigate(hash) {
  await cdp.send('Page.navigate', { url: `${origin}/tools/?qa=${++navigationId}#${hash}` });
  await waitFor(`location.search === '?qa=${navigationId}' && document.readyState === 'complete' && document.querySelector('.nav-item.active')?.dataset.tool === ${JSON.stringify(hash === 'unknown' ? 'merge' : hash)}`);
}
async function select(name, bytes, type = '') {
  const base64 = Buffer.from(bytes).toString('base64');
  await evaluate(`(() => {
    const file = new File([Uint8Array.from(atob(${JSON.stringify(base64)}), c => c.charCodeAt(0))], ${JSON.stringify(name)}, {type: ${JSON.stringify(type)}});
    const transfer = new DataTransfer(); transfer.items.add(file);
    const input = document.querySelector('#fileInput'); input.files = transfer.files;
    input.dispatchEvent(new Event('change', {bubbles: true}));
  })()`);
}
async function runConversion(name, bytes, expected, engine) {
  const count = await evaluate('window.__downloads.length');
  await select(name, bytes);
  await evaluate('document.querySelector("#processBtn").click()');
  await waitFor(`!document.querySelector('[aria-busy="true"]')`, `${engine} ${name} finish`);
  assert.equal(await evaluate('window.__downloads.length'), count + 1, `${engine} ${name}: ${alerts.at(-1) || 'no download'}`);
  await waitFor(`typeof window.__downloads[${count}].text === 'string'`);
  const output = await evaluate(`window.__downloads[${count}]`);
  assert.match(output.text, expected, `${engine} ${name} contents`);
  assert.equal(output.name, name.replace(/\.[^.]+$/, '') + '.md');
  console.log(`PASS ${engine}: ${name}`);
}
async function zipFiles(files) {
  const zip = new JSZip();
  for (const [name, text] of Object.entries(files)) zip.file(name, text);
  return zip.generateAsync({ type: 'uint8array' });
}

try {
  const deadline = Date.now() + 15000;
  let port;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    if (chrome.exitCode !== null) throw new Error(`Chrome exited early: ${stderr.slice(-600)}`);
    try { port = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch { await delay(50); }
  }
  if (!port) throw new Error(`Chrome did not start: ${stderr.slice(-600)}`);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  cdp = await connect(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  cdp.on('Page.javascriptDialogOpening', params => {
    alerts.push(params.message);
    cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(error => failures.push(String(error)));
  });
  cdp.on('Runtime.exceptionThrown', event => failures.push(event.exceptionDetails.exception?.description || event.exceptionDetails.text));
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__downloads = []; window.__workers = 0;
    const blobs = new Map();
    const createURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = createURL(blob); blobs.set(url, blob); return url; };
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function() {
      if (!this.download) return click.call(this);
      const output = {name: this.download}; window.__downloads.push(output);
      const blob = blobs.get(this.href);
      blob.text().then(text => {output.text = text;});
      blob.arrayBuffer().then(buffer => {
        const bytes = new Uint8Array(buffer); let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        output.base64 = btoa(binary);
      });
    };
    const NativeWorker = Worker;
    window.Worker = class extends NativeWorker {constructor(...args) {super(...args); window.__workers++;}};
  ` });

  const docx = await zipFiles({
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Review report</w:t></w:r></w:p><w:p><w:r><w:t>Conversion works locally.</w:t></w:r></w:p></w:body></w:document>'
  });
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage();
  page.drawText('Review report', { x: 50, y: 750, size: 22, font });
  page.drawText('Conversion works locally.', { x: 50, y: 700, size: 12, font });
  const pdfBytes = await pdf.save();
  const scan = await PDFDocument.create();
  const png = await scan.embedPng(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'));
  scan.addPage().drawImage(png, { x: 20, y: 20, width: 100, height: 100 });
  const scanBytes = await scan.save();
  const csv = Buffer.from('Name,Count\nReview report,7\n');
  const rtf = Buffer.from('{\\rtf1\\ansi Review report\\par Conversion works locally.}');
  const xlsx = await zipFiles({
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Report" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Name</t></is></c><c r="B1" t="inlineStr"><is><t>Count</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Review report</t></is></c><c r="B2"><v>7</v></c></row></sheetData></worksheet>'
  });
  const pptx = await zipFiles({
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>',
    'ppt/presentation.xml': '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>',
    'ppt/_rels/presentation.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>',
    'ppt/slides/slide1.xml': '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Review report</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>'
  });
  const epub = await zipFiles({
    'mimetype': 'application/epub+zip',
    'META-INF/container.xml': '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    'OEBPS/content.opf': '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">review-test</dc:identifier><dc:title>Review report</dc:title><dc:language>en</dc:language></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>',
    'OEBPS/chapter.xhtml': '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Review report</title></head><body><h1>Review report</h1><p>Conversion works locally.</p></body></html>'
  });

  await navigate('anydoc');
  assert.equal(await evaluate('window.__workers'), 0);
  assert.equal(requests.some(url => url.endsWith('.wasm')), false, 'engines must load lazily');
  for (const engine of ['anydoc', 'docling']) {
    await navigate(engine);
    await runConversion('REPORT.DOCX', docx, /Review report/, engine);
    await runConversion('report.pdf', pdfBytes, /Conversion works locally/, engine);
    await runConversion('report.csv', csv, /Review report/, engine);
    await runConversion('report.rtf', rtf, /Review report/, engine);
    await runConversion('report.xlsx', xlsx, /Review report/, engine);
    await runConversion('report.pptx', pptx, /Review report/, engine);
    await runConversion('report.epub', epub, /Review report/, engine);
    const alertCount = alerts.length;
    await select('scan.pdf', scanBytes);
    await evaluate('document.querySelector("#processBtn").click()');
    await waitFor(`!document.querySelector('[aria-busy="true"]')`);
    assert.equal(alerts.length, alertCount + 1);
    assert.match(alerts.at(-1), /OCR/);
    assert.equal(await evaluate('document.querySelector(".file-name").textContent'), 'scan.pdf');
    console.log(`PASS ${engine}: scanned PDF rejected, selection retained`);
    if (engine === 'docling') {
      await select('broken.pdf', [1, 2, 3]);
      await evaluate('document.querySelector("#processBtn").click()');
      await waitFor(`!document.querySelector('[aria-busy="true"]')`);
      assert.match(alerts.at(-1), /may be scanned, image-only, or damaged/);
      assert.equal(await evaluate('document.querySelector(".file-name").textContent'), 'broken.pdf');
      console.log('PASS Docling: corrupt PDF error describes the ambiguity');
    }
  }

  // Engine initialization must recover from an actual failed HTTP request.
  await navigate('anydoc');
  failWasm = true;
  await select('retry.csv', csv);
  await evaluate('document.querySelector("#processBtn").click()');
  await waitFor(`!document.querySelector('[aria-busy="true"]')`);
  assert.match(alerts.at(-1), /Failed to load the AnyDoc engine/);
  await runConversion('retry.csv', csv, /Review report/, 'anydoc retry');

  // A held WASM response makes the busy/cancel path deterministic.
  await navigate('anydoc');
  holdWasm = true;
  await select('cancel.csv', csv);
  await evaluate('document.querySelector("#processBtn").click()');
  await waitFor('document.querySelector("#progressText").textContent.includes("Loading converter")');
  await evaluate('document.querySelector("[data-tool=docling]").click()');
  assert.equal(await evaluate('location.hash'), '#anydoc');
  assert.equal(await evaluate('document.querySelector("#fileInput").disabled'), true);
  assert.equal(await evaluate('document.querySelector(".remove-btn").disabled'), true);
  const downloadCount = await evaluate('window.__downloads.length');
  await evaluate('document.querySelector("#cancelBtn").click()');
  await waitFor(`!document.querySelector('[aria-busy="true"]')`);
  assert.equal(await evaluate('window.__downloads.length'), downloadCount);
  assert.equal(await evaluate('document.querySelector(".file-name").textContent'), 'cancel.csv');
  assert.equal(await evaluate('document.querySelector("#fileInput").disabled'), false);
  holdWasm = false;
  heldResponses.splice(0).forEach(resolve => resolve());
  await runConversion('cancel.csv', csv, /Review report/, 'anydoc cancel/retry');
  console.log('PASS cancellation, blocked navigation, retry after failed download');

  async function beginHeldJob(name, { fail = false } = {}) {
    await navigate('merge');
    await evaluate('document.querySelector("[data-tool=split]").click()');
    await waitFor('document.querySelector(".nav-item.active").dataset.tool === "split"');
    await evaluate('document.querySelector("[data-tool=anydoc]").click()');
    await waitFor('document.querySelector(".nav-item.active").dataset.tool === "anydoc"');
    holdWasm = true;
    failWasm = fail;
    await select(name, csv);
    await evaluate('document.querySelector("#processBtn").click()');
    await waitFor('document.querySelector("#progressText").textContent.includes("Loading converter")');
  }
  async function traverse(method, hash, active = hash) {
    await evaluate(`history.${method}()`);
    await waitFor(`location.hash === '#${hash}' && document.querySelector('.nav-item.active').dataset.tool === '${active}'`);
  }
  function releaseJob() {
    holdWasm = false;
    heldResponses.splice(0).forEach(resolve => resolve());
  }

  await beginHeldJob('history.csv');
  const historyLength = await evaluate('history.length');
  await traverse('back', 'split', 'anydoc');
  await waitFor('!document.querySelector("#navigation-notice").classList.contains("hidden")');
  await traverse('back', 'merge', 'anydoc');
  await traverse('forward', 'split', 'anydoc');
  releaseJob();
  await waitFor(`!document.querySelector('[aria-busy="true"]') && document.querySelector('.nav-item.active').dataset.tool === 'split'`);
  await waitFor('window.__downloads.at(-1)?.text');
  assert.equal(await evaluate('window.__downloads.at(-1).name'), 'history.md');
  assert.equal(await evaluate('history.length'), historyLength);
  await traverse('back', 'merge');
  await traverse('forward', 'split');
  await traverse('forward', 'anydoc');
  console.log('PASS Back/Forward during success preserves every history entry and follows the latest request');

  await beginHeldJob('history-cancel.csv');
  await traverse('back', 'split', 'anydoc');
  const cancelAlertCount = alerts.length;
  await evaluate('document.querySelector("#cancelBtn").click()');
  await waitFor(`!document.querySelector('[aria-busy="true"]') && document.querySelector('.nav-item.active').dataset.tool === 'split'`);
  releaseJob();
  assert.equal(await evaluate('window.__downloads.length'), 0);
  assert.equal(alerts.length, cancelAlertCount);
  await traverse('back', 'merge');
  await traverse('forward', 'split');
  await traverse('forward', 'anydoc');
  console.log('PASS deferred navigation on cancellation preserves Back/Forward');

  await beginHeldJob('return-to-current.csv');
  await traverse('back', 'split', 'anydoc');
  await traverse('forward', 'anydoc', 'anydoc');
  await waitFor('document.querySelector("#navigation-notice").classList.contains("hidden")');
  await evaluate('document.querySelector("#cancelBtn").click()');
  await waitFor(`!document.querySelector('[aria-busy="true"]')`);
  releaseJob();
  assert.equal(await evaluate('document.querySelector(".file-name").textContent'), 'return-to-current.csv');
  assert.equal(await evaluate('document.querySelector("#fileInput").disabled'), false);
  console.log('PASS returning to the running tool cancels deferred navigation and retains the file on cancel');

  await beginHeldJob('history-failure.csv', { fail: true });
  await traverse('back', 'split', 'anydoc');
  releaseJob();
  await waitFor(`!document.querySelector('[aria-busy="true"]') && document.querySelector('.nav-item.active').dataset.tool === 'split'`);
  assert.match(alerts.at(-1), /Failed to load the AnyDoc engine/);
  await traverse('back', 'merge');
  await traverse('forward', 'split');
  await traverse('forward', 'anydoc');
  console.log('PASS deferred navigation on failure preserves Back/Forward');

  // DOM rendering and rejection must preserve the existing selection.
  await select('<img onerror=alert(1)>.csv', csv);
  assert.equal(await evaluate('document.querySelector(".file-name").textContent'), '<img onerror=alert(1)>.csv');
  assert.equal(await evaluate('document.querySelector(".file-name img")'), null);
  await select('wrong.png', [1, 2, 3]);
  assert.match(alerts.at(-1), /Unsupported file type/);
  assert.equal(await evaluate('document.querySelector(".file-name").textContent'), '<img onerror=alert(1)>.csv');

  await evaluate('document.querySelector("[data-tool=mergemd]").click()');
  await waitFor('location.hash === "#mergemd"');
  await select('first.md', Buffer.from('First document'));
  await select('second.md', Buffer.from('Second document'));
  assert.equal(await evaluate('document.querySelector("#orderHint").classList.contains("hidden")'), false);
  assert.match(await evaluate('document.querySelector("#hintText").textContent'), /reorder/);
  await evaluate('document.querySelector("#processBtn").click()');
  await waitFor(`!document.querySelector('[aria-busy="true"]')`);
  await waitFor('window.__downloads.at(-1).text');
  assert.equal(await evaluate('window.__downloads.at(-1).text'), 'First document\n\n---\n\nSecond document\n');
  await evaluate('document.querySelector("[data-tool=split]").click()');
  await waitFor('document.querySelector("#processText").textContent === "Split PDF file"');
  await evaluate('history.back()');
  await waitFor('document.querySelector(".nav-item.active").dataset.tool === "mergemd"');
  await evaluate('history.forward()');
  await waitFor('document.querySelector(".nav-item.active").dataset.tool === "split"');
  await cdp.send('Page.reload');
  await waitFor('document.querySelector(".nav-item.active")?.dataset.tool === "split"');
  await navigate('unknown');
  assert.equal(await evaluate('location.hash'), '#merge');
  console.log('PASS file-name rendering, rejection, merge hint/download, button labels and history');

  await navigate('pdf2md');
  await runConversion('custom.pdf', pdfBytes, /Conversion works locally/, 'existing PDF converter');
  await runConversion('Report.PDF', pdfBytes, /Conversion works locally/, 'uppercase PDF filename');
  await runConversion('a.pdf.b.pdf', pdfBytes, /Conversion works locally/, 'multiple PDF suffixes');
  await navigate('merge');
  await select('first.pdf', pdfBytes);
  await select('second.pdf', pdfBytes);
  await evaluate(`(() => {
    const [first, second] = document.querySelectorAll('.file-item');
    first.dispatchEvent(new Event('dragstart', {bubbles: true}));
    second.dispatchEvent(new Event('drop', {bubbles: true, cancelable: true}));
    first.dispatchEvent(new Event('dragend', {bubbles: true}));
  })()`);
  assert.deepEqual(await evaluate('[...document.querySelectorAll(".file-name")].map(el => el.textContent)'), ['second.pdf', 'first.pdf']);
  await evaluate(`(() => {
    const original = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = async function() {
      if (!window.__releaseRead) await new Promise(resolve => {window.__releaseRead = resolve;});
      return original.call(this);
    };
    return true;
  })()`);
  await evaluate('document.querySelector("#processBtn").click()');
  assert.equal(await evaluate('[...document.querySelectorAll(".file-item")].every(el => !el.draggable)'), true);
  await evaluate(`(() => {
    const [first, second] = document.querySelectorAll('.file-item');
    first.dispatchEvent(new Event('dragstart', {bubbles: true, cancelable: true}));
    second.dispatchEvent(new Event('drop', {bubbles: true, cancelable: true}));
  })()`);
  assert.deepEqual(await evaluate('[...document.querySelectorAll(".file-name")].map(el => el.textContent)'), ['second.pdf', 'first.pdf']);
  await evaluate('window.__releaseRead()');
  await waitFor(`!document.querySelector('[aria-busy="true"]')`);
  await waitFor('window.__downloads.at(-1)?.base64');
  const mergedPdf = await PDFDocument.load(Buffer.from(await evaluate('window.__downloads.at(-1).base64'), 'base64'));
  assert.equal(mergedPdf.getPageCount(), 2);
  const splitBytes = await mergedPdf.save();
  for (const [name, stem] of [['two-pages.pdf', 'two-pages'], ['Report.PDF', 'Report'], ['a.pdf.b.pdf', 'a.pdf.b']]) {
    await navigate('split');
    await select(name, splitBytes);
    await evaluate('document.querySelector("#processBtn").click()');
    await waitFor(`!document.querySelector('[aria-busy="true"]')`);
    await waitFor('window.__downloads.length === 2 && window.__downloads.every(output => output.base64)');
    const outputs = await evaluate('window.__downloads');
    assert.deepEqual(outputs.map(output => output.name), [`${stem}_page_1.pdf`, `${stem}_page_2.pdf`]);
    for (const output of outputs) {
      const splitPdf = await PDFDocument.load(Buffer.from(output.base64, 'base64'));
      assert.equal(splitPdf.getPageCount(), 1);
    }
    console.log(`PASS split PDF filename: ${name}`);
  }
  console.log('PASS existing PDF conversion, PDF merge/split, reordering and busy-state file protection');

  for (const width of [400, 1280]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    for (const tool of ['docling', 'merge', 'mergemd']) {
      await navigate(tool);
      const layout = await evaluate(`(() => {
        const nav = document.querySelector('.nav-menu'), active = document.querySelector('.nav-item.active');
        const rect = active.getBoundingClientRect(), parent = nav.getBoundingClientRect();
        return {pageWidth: document.documentElement.scrollWidth, width: innerWidth, activeVisible: rect.left >= parent.left - 1 && rect.right <= parent.right + 1, oneRow: new Set([...nav.children].map(el => el.offsetTop)).size === 1, left: rect.left, right: rect.right, parentLeft: parent.left, parentRight: parent.right, scroll: nav.scrollLeft};
      })()`);
      assert.ok(layout.pageWidth <= layout.width, `page overflow at ${width}`);
      assert.equal(layout.activeVisible, true, `active tab at ${width}: ${JSON.stringify(layout)}`);
      assert.equal(layout.oneRow, true);
      console.log(`PASS ${tool} responsive layout at ${width}px`);
    }
  }
  assert.deepEqual(failures, [], 'unexpected browser exceptions');
  console.log('All production browser checks passed.');
} finally {
  holdWasm = false;
  heldResponses.splice(0).forEach(resolve => resolve());
  if (cdp) { try { await cdp.send('Browser.close'); } catch {} }
  cdp?.close();
  chrome.kill();
  await Promise.race([browserExited, delay(3000)]);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  // This generated profile is the only recursive deletion target.
  const resolvedProfile = path.resolve(profile);
  const tmpRoot = path.resolve(os.tmpdir());
  if (!resolvedProfile.startsWith(tmpRoot + path.sep) || !path.basename(resolvedProfile).startsWith('medical-tools-browser-')) {
    throw new Error('Refusing to remove an unexpected browser profile path.');
  }
  await fs.rm(resolvedProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
