# Medical Tools

A modern, privacy-focused web application for document processing and medical imaging utilities. Built with Vite and ES modules — everything runs 100% in the browser.

## Features

- **Merge PDF** — Combine multiple PDFs with drag-and-drop reordering
- **Split PDF** — Split a PDF into individual pages, each downloaded separately
- **Anonymize DICOM** — Remove patient identifiers from DICOM files while preserving imaging data
- **PDF to Markdown** — Convert PDF documents to clean, structured Markdown text
- **Merge Markdown** — Combine multiple Markdown or text files into a single document
- **AnyDoc to Markdown** — Convert Word, PowerPoint, Excel, OpenDocument, EPUB, RTF, CSV and text-based PDF files to Markdown
- **Docling to Markdown** — Convert Office, OpenDocument, HTML, EPUB, LaTeX, e-mail and text-based PDF files to Markdown

Each tool has its own URL (e.g. `/tools/#anydoc`, `/tools/#docling`), so tools can be linked directly and work with browser Back/Forward.

All tools share a consistent UI: drag-and-drop or file-picker upload, file list with reordering, progress bar, and automatic download of results.

## Setup

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Build for production (outputs to docs/)
npm run build

# Run converter lifecycle regression tests (Node.js 22+)
npm test

# Build and run production UI regression tests in installed Chrome/Chromium
npm run test:browser

# Preview production build
npm run preview
```

Browser tests require Node.js 22+ and an installed Chrome, Chromium, or Edge browser. Set `CHROME_PATH` to the executable path if it is not detected automatically. The suite runs headlessly against a local server, uses generated documents, and checks conversion, failures, cancellation, navigation, file handling, and mobile layout. It requires no external service or document upload.

## Project Structure

```
├── index.html              # Entry point with navigation and shared layout
├── package.json            # Dependencies and scripts
├── vite.config.js          # Vite config (base path, output to docs/)
└── src/
    ├── main.js             # App logic, tool definitions, ToolManager class
    ├── pdf2md.js           # PDF-to-Markdown conversion engine
    ├── docConverters.js    # AnyDoc / Docling client (lazy Web Workers, error messages)
    ├── workers/            # anydoc.worker.js, docling.worker.js (WASM engines)
    ├── dicomUtils.js       # DICOM parsing, anonymization, ZIP export
    ├── utils.js            # Shared helpers (download, file size, ID generation)
    └── styles.css          # Styling and responsive layout
```

## Tool Details

### Merge PDF

Select two or more PDF files, reorder them via drag-and-drop, and merge into a single PDF.

### Split PDF

Upload a single PDF and receive each page as a separate PDF file.

### Anonymize DICOM

1. Select DICOM files or a folder from a PACS export
2. Review the analysis (file count, studies, series)
3. Set an anonymous patient ID
4. Download a ZIP with anonymized files organized by Study / Series / SOP

**Anonymized tags include:** PatientName, PatientID, PatientBirthDate, PatientSex, PatientAge, InstitutionName, InstitutionAddress, ReferringPhysicianName, PerformingPhysicianName, OperatorsName, and more. UIDs and imaging data are preserved for postprocessing.

### PDF to Markdown

Converts PDF documents to Markdown with:

- Multi-column layout detection
- Heading detection by font size and ALL-CAPS patterns
- Table detection and formatting
- Citation cleanup and DOI extraction
- Math symbol wrapping
- Auto-generated table of contents

### Merge Markdown

Select two or more `.md`, `.markdown`, `.txt`, `.text`, or `.mdx` files, reorder via drag-and-drop, and merge into a single Markdown file. Files are concatenated with horizontal rule (`---`) separators.

### AnyDoc to Markdown

Converts one document at a time with [AnyDoc](https://github.com/firecrawl/anydoc) (WebAssembly).

- **Formats:** DOCX/DOCM, DOC, ODT, RTF, EPUB, PPTX/PPTM/PPSX, PPT, ODP, XLSX/XLSM, XLS, ODS, CSV, PDF
- Produces GitHub-Flavored Markdown with headings, lists, tables and emphasis
- **Limitations:** no OCR, so scanned or image-only PDF pages are reported instead of converted; encrypted files are rejected

### Docling to Markdown

Converts one document at a time with [docling.rs](https://github.com/docling-project/docling.rs) (WebAssembly, basic build).

- **Formats:** DOCX, PPTX, XLSX, ODT/ODS/ODP, HTML, Markdown, AsciiDoc, CSV/TSV, EPUB, LaTeX, EML, MHTML, RTF, WebVTT, legacy WordPerfect/Lotus/StarOffice formats, PDF and more
- **Limitations:** PDFs are read from their embedded text layer only and come out as plain paragraphs (no heading or table detection, which needs Docling's layout models); scanned PDFs and images need OCR and are not supported

Both engines load on first use (AnyDoc ≈ 6.7 MB, Docling ≈ 14 MB of WebAssembly, cached by the browser afterwards) and run in a Web Worker so the page stays responsive.

Conversion status shows when the engine is loading and when it is converting. **Cancel conversion** stops the worker and keeps the selected file for retry. Failed engine loads can also be retried. Header links, uploads, removal and reordering are disabled while a job runs.

Browser Back/Forward preserves its history while processing continues. The current tool stays visible until the job finishes, fails, or is cancelled; the latest requested tool then opens. Returning to the running tool cancels the pending switch. If you switch to a different tool, its file selection starts empty.

Docling can report the same missing-text error for scanned and damaged PDFs. The message describes both possibilities; it does not assume every unreadable PDF needs OCR.

## Privacy & Security

- **100% local processing** — no data leaves your browser
- The document converters need a connection on first use to download their engine. Later offline use depends on the browser retaining the assets in its cache; there is no guaranteed offline mode.
- **No backend required** — pure client-side JavaScript
- **Deployable on GitHub Pages** — static files only

## Technologies

- **Vite** — Build tool and dev server
- **pdf-lib** — PDF creation, merging, and splitting
- **pdfjs-dist** — PDF text extraction for Markdown conversion
- **dicom-parser** — DICOM file parsing and tag modification
- **JSZip** — ZIP file creation for DICOM exports
- **@firecrawl/anydoc-wasm** — AnyDoc document-to-Markdown engine
- **docling.rs-wasm** — Docling document-to-Markdown engine

## Deployment

The app builds to the `docs/` folder for GitHub Pages deployment:

```bash
npm run build
```

Push the `docs/` folder to your repository and enable GitHub Pages from the `docs/` directory in your repo settings. The base path is configured as `/tools/` in `vite.config.js`.

## License

MIT
