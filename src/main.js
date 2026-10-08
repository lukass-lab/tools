import { PDFDocument } from 'pdf-lib';
import { downloadFile, formatFileSize, generateAnonymousId } from './utils';
import { convertPdfToMarkdown } from './pdf2md';
import { convertDocumentToMarkdown } from './docConverters';
import { 
  processDicomBatch, 
  analyzeDicomFiles, 
  TAGS_TO_ANONYMIZE 
} from './dicomUtils';

const ANYDOC_EXTENSIONS = [
  '.docx', '.docm', '.doc', '.odt', '.rtf', '.epub',
  '.pptx', '.pptm', '.ppsx', '.ppt', '.odp',
  '.xlsx', '.xlsm', '.xls', '.ods', '.csv', '.pdf'
];

// From docling.rs-wasm's supported_extensions() for the pinned version
const DOCLING_EXTENSIONS = [
  'docx', 'dotx', 'docm', 'dotm', 'pptx', 'potx', 'ppsx', 'pptm', 'potm', 'ppsm',
  'md', 'txt', 'text', 'qmd', 'rmd', 'html', 'htm', 'xhtml', 'xml', 'nxml', 'dclg', 'dclx',
  'adoc', 'asciidoc', 'asc', 'csv', 'tsv', 'xlsx', 'xlsm', 'xlsb', 'xltx', 'xltm',
  'odt', 'ott', 'ods', 'ots', 'odp', 'otp', 'sxw', 'stw', 'sxg', 'sxc', 'stc', 'sxi', 'sti',
  'fodt', 'fods', 'fodp', 'json', 'sdw', 'sda', 'sdd', 'vor', 'abw', 'zabw', 'awt',
  'wpd', 'wp', 'wp5', 'wp6', 'wpt', 'wps', 'dbf', 'dif', 'slk', 'sylk',
  'wk1', 'wk2', 'wk3', 'wk4', 'wks', 'wrk', '123', 'wq1', 'wq2', 'wb1', 'wb2', 'wb3', 'qpw', 'xlr',
  'vtt', 'tex', 'latex', 'eml', 'epub', 'mhtml', 'mht', 'rtf', 'vsdx', 'vsdm', 'pdf', 'djvu', 'djv'
].map(ext => `.${ext}`);

const TOOLS = {
  merge: {
    title: 'Merge PDF files',
    description: 'Combine PDFs in the order you want with the easiest PDF merger available.',
    buttonText: 'Merge PDF files',
    icon: '📄',
    uploadText: 'Select PDF files',
    uploadSubtext: 'or drop PDFs here',
    accept: '.pdf',
    extensions: ['.pdf'],
    multiple: true,
    hint: 'Drag and drop files to reorder them before merging'
  },
  split: {
    title: 'Split PDF files',
    description: 'Separate one page or a whole set for easy conversion into independent PDF files.',
    buttonText: 'Split PDF file',
    icon: '✂️',
    uploadText: 'Select PDF file',
    uploadSubtext: 'or drop PDF here',
    accept: '.pdf',
    extensions: ['.pdf'],
    multiple: false,
    hint: null
  },
  dicom: {
    title: 'Anonymize DICOM',
    description: 'Remove patient identifiers from DICOM files while preserving medical imaging data.',
    buttonText: 'Anonymize DICOM files',
    icon: '🏥',
    uploadText: 'Select DICOM folder or files',
    uploadSubtext: 'or drop DICOM folder/files here',
    accept: '.dcm,.dicom',
    extensions: null, // DICOM files often lack extensions; the parser validates them
    multiple: true,
    webkitdirectory: true,
    hint: 'All patient identifiers will be replaced with anonymous values'
  },
  pdf2md: {
    title: 'PDF to Markdown',
    description: 'Convert PDF documents to clean, structured Markdown text with preserved formatting.',
    buttonText: 'Convert & Download',
    icon: '📝',
    uploadText: 'Select PDF file',
    uploadSubtext: 'or drop PDF here',
    accept: '.pdf',
    extensions: ['.pdf'],
    multiple: false,
    hint: null
  },
  mergemd: {
    title: 'Merge Markdown files',
    description: 'Combine multiple Markdown or text files into a single document in your preferred order.',
    buttonText: 'Merge Markdown files',
    icon: '📑',
    uploadText: 'Select Markdown or text files',
    uploadSubtext: 'or drop .md / .txt files here',
    accept: '.md,.markdown,.txt,.text,.mdx',
    extensions: ['.md', '.markdown', '.txt', '.text', '.mdx'],
    multiple: true,
    hint: 'Drag and drop files to reorder them before merging'
  },
  anydoc: {
    title: 'AnyDoc to Markdown',
    description: 'Convert Word, PowerPoint, Excel, OpenDocument, EPUB, RTF, CSV and text-based PDF files to Markdown with the AnyDoc engine.',
    buttonText: 'Convert & Download',
    icon: '🗂️',
    uploadText: 'Select a document',
    uploadSubtext: 'DOCX, DOC, PPTX, XLSX, ODT, EPUB, RTF, CSV, PDF and more',
    accept: ANYDOC_EXTENSIONS.join(','),
    extensions: ANYDOC_EXTENSIONS,
    note: 'Files are converted locally. Scanned PDFs need OCR, which is not included.',
    multiple: false,
    hint: null,
    engine: 'anydoc'
  },
  docling: {
    title: 'Docling to Markdown',
    description: 'Convert Office, OpenDocument, HTML, EPUB, LaTeX, e-mail and text-based PDF files to Markdown with the Docling engine.',
    buttonText: 'Convert & Download',
    icon: '🧾',
    uploadText: 'Select a document',
    uploadSubtext: 'DOCX, PPTX, XLSX, ODT, HTML, EPUB, LaTeX, EML, PDF and more',
    accept: DOCLING_EXTENSIONS.join(','),
    extensions: DOCLING_EXTENSIONS,
    note: 'Files are converted locally. PDF output uses the text layer only, without heading or table detection. Scanned PDFs need OCR, which is not included.',
    multiple: false,
    hint: null,
    engine: 'docling'
  }
};

class ToolManager {
  constructor() {
    this.selectedFiles = [];
    this.currentTool = 'merge';
    this.draggedIndex = null;
    this.busy = false;
    
    this.initElements();
    this.attachListeners();
    this.switchTool(this.toolFromHash());
  }

  toolFromHash() {
    const tool = window.location.hash.slice(1);
    return Object.hasOwn(TOOLS, tool) ? tool : 'merge';
  }

  initElements() {
    this.els = {
      navItems: document.querySelectorAll('.nav-item'),
      toolTitle: document.getElementById('tool-title'),
      toolDescription: document.getElementById('tool-description'),
      toolNote: document.getElementById('tool-note'),
      navigationNotice: document.getElementById('navigation-notice'),
      toolPanel: document.querySelector('.tool-panel'),
      uploadArea: document.getElementById('uploadArea'),
      uploadText: document.getElementById('uploadText'),
      uploadSubtext: document.getElementById('uploadSubtext'),
      fileInput: document.getElementById('fileInput'),
      fileList: document.getElementById('fileList'),
      processBtn: document.getElementById('processBtn'),
      processText: document.getElementById('processText'),
      cancelBtn: document.getElementById('cancelBtn'),
      progressContainer: document.getElementById('progressContainer'),
      progressBar: document.getElementById('progressBar'),
      progressText: document.getElementById('progressText'),
      orderHint: document.getElementById('orderHint'),
      hintText: document.getElementById('hintText'),
      uploadIcon: document.querySelector('.upload-icon')
    };
  }

  attachListeners() {
    document.querySelector('.header').addEventListener('click', (e) => {
      if (this.busy && e.target.closest('a')) e.preventDefault();
    });
    // Navigation: nav links set the URL hash, so tools can be linked, refreshed and use Back/Forward
    window.addEventListener('hashchange', () => this.syncToolFromHash());

    // Upload area
    this.els.uploadArea.addEventListener('click', () => {
      if (!this.busy) this.els.fileInput.click();
    });
    this.els.uploadArea.addEventListener('keydown', (e) => {
      if (e.target === this.els.uploadArea && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        if (!this.busy) this.els.fileInput.click();
      }
    });
    this.els.uploadArea.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (this.busy) return;
      this.els.uploadArea.classList.add('dragover');
    });
    this.els.uploadArea.addEventListener('dragleave', () => {
      this.els.uploadArea.classList.remove('dragover');
    });
    this.els.uploadArea.addEventListener('drop', (e) => {
      e.preventDefault();
      this.els.uploadArea.classList.remove('dragover');
      this.handleFiles(e.dataTransfer.files);
    });

    // File input
    this.els.fileInput.addEventListener('change', (e) => {
      this.handleFiles(e.target.files);
      // Allow re-selecting the same file after it was removed
      e.target.value = '';
    });

    // Process button
    this.els.processBtn.addEventListener('click', () => this.processFiles());
    this.els.cancelBtn.addEventListener('click', () => this.conversionController?.abort());
  }

  syncToolFromHash() {
    const tool = this.toolFromHash();
    const deferred = this.busy && tool !== this.currentTool;
    this.els.navigationNotice.classList.toggle('hidden', !deferred);
    this.els.navigationNotice.textContent = deferred
      ? `${TOOLS[tool].title} will open when processing finishes.${TOOLS[this.currentTool].engine ? ' Cancel conversion to switch sooner.' : ''}`
      : '';
    // Leave browser history untouched during the job. The latest location wins
    // when it settles, even after several Back/Forward requests.
    if (this.busy) return;
    if (tool !== this.currentTool) this.switchTool(tool);
    else if (window.location.hash !== `#${tool}`) history.replaceState(null, '', `#${tool}`);
  }

  switchTool(tool) {
    this.currentTool = tool;
    const toolData = TOOLS[tool];
    if (window.location.hash !== `#${tool}`) history.replaceState(null, '', `#${tool}`);

    this.els.navItems.forEach(nav => {
      const active = nav.dataset.tool === tool;
      nav.classList.toggle('active', active);
      if (active) nav.setAttribute('aria-current', 'page');
      else nav.removeAttribute('aria-current');
    });
    
    this.els.toolTitle.textContent = toolData.title;
    this.els.toolDescription.textContent = toolData.description;
    this.els.toolNote.textContent = toolData.note ?? '';
    this.els.toolNote.classList.toggle('hidden', !toolData.note);
    this.els.processText.textContent = toolData.buttonText;
    this.els.uploadIcon.textContent = toolData.icon;
    this.els.uploadText.textContent = toolData.uploadText;
    this.els.uploadSubtext.textContent = toolData.uploadSubtext;
    this.els.uploadArea.setAttribute('aria-label', toolData.uploadText);
    
    this.els.fileInput.accept = toolData.accept;
    this.els.fileInput.multiple = toolData.multiple;
    
    // Enable directory selection for DICOM
    if (tool === 'dicom') {
      this.els.fileInput.setAttribute('webkitdirectory', '');
      this.els.fileInput.setAttribute('directory', '');
    } else {
      this.els.fileInput.removeAttribute('webkitdirectory');
      this.els.fileInput.removeAttribute('directory');
    }
    
    this.selectedFiles = [];
    this.updateFileList();
    // Update the panel before measuring navigation; its height can add a page scrollbar.
    [...this.els.navItems].find(nav => nav.dataset.tool === tool)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  handleFiles(files) {
    if (this.busy) return;

    const toolData = TOOLS[this.currentTool];
    const allFiles = Array.from(files);
    const isValid = (f) =>
      toolData.extensions.some(ext => f.name.toLowerCase().endsWith(ext)) ||
      (f.type === 'application/pdf' && toolData.extensions.includes('.pdf'));
    const validFiles = toolData.extensions ? allFiles.filter(isValid) : allFiles;

    if (validFiles.length < allFiles.length) {
      const rejected = allFiles.filter(f => !validFiles.includes(f)).map(f => f.name);
      alert(`Unsupported file type for ${toolData.title}:\n\n${rejected.join('\n')}`);
      if (validFiles.length === 0) return;
    }

    if (toolData.multiple) {
      this.selectedFiles = [...this.selectedFiles, ...validFiles];
    } else {
      this.selectedFiles = validFiles.slice(0, 1);
    }
    
    this.updateFileList();
  }

  updateFileList() {
    const toolData = TOOLS[this.currentTool];
    const hasFiles = this.selectedFiles.length > 0;
    const showHint = Boolean(toolData.hint && this.selectedFiles.length > 1);

    this.els.fileList.classList.toggle('hidden', !hasFiles);
    this.els.processBtn.classList.toggle('hidden', !hasFiles);
    this.els.orderHint.classList.toggle('hidden', !showHint);
    
    if (showHint) {
      this.els.hintText.textContent = toolData.hint;
    }
    
    // Keep the original hint nodes attached, and render file names as plain text.
    this.els.fileList.replaceChildren(this.els.orderHint);
    const summary = this.currentTool === 'dicom' && this.selectedFiles.length > 10;
    const displayFiles = summary ? [{
      name: `📁 ${this.selectedFiles.length} DICOM files selected`,
      size: this.selectedFiles.reduce((sum, f) => sum + f.size, 0)
    }] : this.selectedFiles;
    displayFiles.forEach((file, index) => {
      const item = document.createElement('div');
      item.className = 'file-item';
      item.dataset.index = String(index);
      item.draggable = showHint && !summary && !this.busy;
      item.innerHTML = `
        <div class="file-item-content">
          ${showHint && !summary ? '<span class="drag-handle" aria-hidden="true">⋮⋮</span>' : ''}
          <div><div class="file-name"></div><div class="file-size"></div></div>
        </div>
        <button class="remove-btn" type="button">✕</button>`;
      item.querySelector('.file-name').textContent = file.name;
      item.querySelector('.file-size').textContent = `${summary ? 'Total size: ' : ''}${formatFileSize(file.size)}`;
      const removeBtn = item.querySelector('.remove-btn');
      removeBtn.dataset.index = summary ? 'all' : String(index);
      removeBtn.disabled = this.busy;
      removeBtn.setAttribute('aria-label', summary ? 'Remove all files' : `Remove ${file.name}`);
      this.els.fileList.appendChild(item);
    });
    
    // Attach remove handlers
    this.els.fileList.querySelectorAll('.remove-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        if (this.busy) return;
        const idx = e.currentTarget.dataset.index;
        if (idx === 'all') {
          this.selectedFiles = [];
        } else {
          this.selectedFiles.splice(parseInt(idx), 1);
        }
        this.updateFileList();
      });
    });

    // Drag and drop for reordering
    if (showHint && !summary) {
      this.setupDragAndDrop();
    }
  }

  setupDragAndDrop() {
    const fileItems = this.els.fileList.querySelectorAll('.file-item');
    
    fileItems.forEach(item => {
      item.addEventListener('dragstart', (e) => {
        if (this.busy) { e.preventDefault(); return; }
        this.draggedIndex = parseInt(e.currentTarget.dataset.index);
        e.currentTarget.classList.add('dragging');
      });
      
      item.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (this.busy) return;
        const targetIndex = parseInt(e.currentTarget.dataset.index);
        if (targetIndex !== this.draggedIndex) {
          e.currentTarget.classList.add('drag-over');
        }
      });
      
      item.addEventListener('dragleave', (e) => {
        e.currentTarget.classList.remove('drag-over');
      });
      
      item.addEventListener('drop', (e) => {
        e.preventDefault();
        if (this.busy) return;
        const targetIndex = parseInt(e.currentTarget.dataset.index);
        
        if (Number.isInteger(this.draggedIndex) && targetIndex !== this.draggedIndex) {
          const draggedFile = this.selectedFiles[this.draggedIndex];
          this.selectedFiles.splice(this.draggedIndex, 1);
          this.selectedFiles.splice(targetIndex, 0, draggedFile);
          this.updateFileList();
        }
        
        this.els.fileList.querySelectorAll('.file-item').forEach(i => {
          i.classList.remove('drag-over');
        });
      });
      
      item.addEventListener('dragend', (e) => {
        e.currentTarget.classList.remove('dragging');
        this.draggedIndex = null;
      });
    });
  }

  updateProgress(percent) {
    this.els.progressBar.style.width = `${percent}%`;
    this.els.progressText.textContent = `${Math.round(percent)}%`;
  }

  async processFiles() {
    if (this.busy || this.selectedFiles.length === 0) return;
    
    this.busy = true;
    this.syncToolFromHash();
    this.els.toolPanel.setAttribute('aria-busy', 'true');
    this.els.fileInput.disabled = true;
    this.els.uploadArea.setAttribute('aria-disabled', 'true');
    this.els.uploadArea.classList.remove('dragover');
    this.els.navItems.forEach(nav => nav.setAttribute('aria-disabled', 'true'));
    this.draggedIndex = null;
    this.updateFileList();
    const isDocumentConversion = Boolean(TOOLS[this.currentTool].engine);
    this.conversionController = isDocumentConversion ? new AbortController() : null;
    this.els.cancelBtn.classList.toggle('hidden', !isDocumentConversion);
    this.els.processBtn.disabled = true;
    // Set the inner span (not the button) so the label element survives for later tool switches
    this.els.processText.textContent = 'Processing...';
    this.els.progressContainer.classList.remove('hidden');
    this.updateProgress(0);
    this.els.progressContainer.classList.toggle('indeterminate', isDocumentConversion);
    if (isDocumentConversion) this.els.progressText.textContent = 'Reading document…';
    
    try {
      switch (this.currentTool) {
        case 'merge':
          await this.mergePDFs();
          break;
        case 'split':
          await this.splitPDF();
          break;
        case 'dicom':
          await this.anonymizeDICOMs();
          break;
        case 'pdf2md':
          await this.convertPdfToMd();
          break;
        case 'mergemd':
          await this.mergeMarkdown();
          break;
        case 'anydoc':
        case 'docling':
          await this.convertDocumentToMd(TOOLS[this.currentTool].engine);
          break;
      }
      
      this.selectedFiles = [];
      this.updateFileList();
    } catch (error) {
      if (error.name !== 'AbortError') {
        console.error('Processing error:', error);
        alert(`Error: ${error.message}`);
      }
    } finally {
      this.busy = false;
      this.conversionController = null;
      this.els.toolPanel.removeAttribute('aria-busy');
      this.els.fileInput.disabled = false;
      this.els.uploadArea.removeAttribute('aria-disabled');
      this.els.navItems.forEach(nav => nav.removeAttribute('aria-disabled'));
      this.els.cancelBtn.classList.add('hidden');
      this.els.processBtn.disabled = false;
      this.els.processText.textContent = TOOLS[this.currentTool].buttonText;
      this.els.progressContainer.classList.add('hidden');
      this.els.progressContainer.classList.remove('indeterminate');
      this.updateFileList();
      this.syncToolFromHash();
    }
  }

  async mergePDFs() {
    if (this.selectedFiles.length < 2) {
      throw new Error('Please select at least 2 PDF files to merge.');
    }

    const mergedPdf = await PDFDocument.create();
    
    for (let i = 0; i < this.selectedFiles.length; i++) {
      const arrayBuffer = await this.selectedFiles[i].arrayBuffer();
      const pdf = await PDFDocument.load(arrayBuffer);
      const pages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
      pages.forEach(page => mergedPdf.addPage(page));
      
      this.updateProgress(((i + 1) / this.selectedFiles.length) * 100);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    const pdfBytes = await mergedPdf.save();
    downloadFile(pdfBytes, 'merged_document.pdf', 'application/pdf');
  }

  async splitPDF() {
    const file = this.selectedFiles[0];
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await PDFDocument.load(arrayBuffer);
    const pageCount = pdf.getPageCount();
    
    for (let i = 0; i < pageCount; i++) {
      const newPdf = await PDFDocument.create();
      const [page] = await newPdf.copyPages(pdf, [i]);
      newPdf.addPage(page);
      
      const pdfBytes = await newPdf.save();
      const filename = `${file.name.replace('.pdf', '')}_page_${i + 1}.pdf`;
      downloadFile(pdfBytes, filename, 'application/pdf');
      
      this.updateProgress(((i + 1) / pageCount) * 100);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  async anonymizeDICOMs() {
    try {
      // Generate anonymous patient ID
      const anonymousId = generateAnonymousId('ANON');
      
      // Ask user for custom ID or use generated one
      const customId = prompt(
        `Enter patient ID for anonymization:\n(Leave empty to use: ${anonymousId})`,
        anonymousId
      );
      
      if (!customId) {
        alert('Anonymization cancelled - no patient ID provided');
        return;
      }
      
      this.updateProgress(5);
      
      // Analyze files first
      const analysis = await analyzeDicomFiles(this.selectedFiles);
      
      this.updateProgress(15);
      
      if (analysis.validDicoms === 0) {
        throw new Error('No valid DICOM files found');
      }
      
      // Show analysis
      const proceed = confirm(
        `DICOM Analysis:\n\n` +
        `Total files: ${analysis.totalFiles}\n` +
        `Valid DICOM files: ${analysis.validDicoms}\n` +
        `Studies: ${analysis.studies}\n` +
        `Series: ${analysis.series}\n` +
        `Invalid files: ${analysis.invalidFiles.length}\n\n` +
        `New Patient ID: ${customId}\n\n` +
        `All patient identifiable information will be anonymized.\n` +
        `Continue?`
      );
      
      if (!proceed) {
        return;
      }
      
      // Process DICOM files
      const zip = await processDicomBatch(
        this.selectedFiles, 
        customId,
        (progress) => this.updateProgress(15 + (progress * 0.8))
      );
      
      this.updateProgress(95);
      
      // Generate ZIP file
      const zipBlob = await zip.generateAsync({ 
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 }
      });
      
      this.updateProgress(100);
      
      // Download
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${customId}_anonymized.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      alert(
        `Anonymization complete!\n\n` +
        `${analysis.validDicoms} DICOM files anonymized\n` +
        `Organized by Study/Series/SOP structure\n` +
        `Downloaded as: ${customId}_anonymized.zip`
      );
      
    } catch (error) {
      console.error('DICOM anonymization error:', error);
      throw error;
    }
  }

  async convertPdfToMd() {
    const file = this.selectedFiles[0];
    
    this.updateProgress(10);
    
    try {
      // Convert PDF to Markdown
      const markdown = await convertPdfToMarkdown(file);
      
      this.updateProgress(90);
      
      // Generate filename
      const originalName = file.name.replace('.pdf', '');
      const filename = `${originalName}.md`;
      
      // Download markdown file
      downloadFile(markdown, filename, 'text/markdown');
      
      this.updateProgress(100);
      
    } catch (error) {
      console.error('PDF to Markdown conversion error:', error);
      throw new Error('Failed to convert PDF. The file may be corrupted or contain unsupported content.');
    }
  }

  async convertDocumentToMd(engine) {
    const file = this.selectedFiles[0];
    const markdown = await convertDocumentToMarkdown(engine, file, {
      signal: this.conversionController.signal,
      onStatus: (status) => {
        this.els.progressText.textContent = status === 'loading'
          ? 'Loading converter for first use…' : 'Converting document…';
      }
    });

    const baseName = file.name.replace(/\.[^.]+$/, '');
    downloadFile(markdown, `${baseName}.md`, 'text/markdown');

    this.updateProgress(100);
  }

  async mergeMarkdown() {
    if (this.selectedFiles.length < 2) {
      throw new Error('Please select at least 2 Markdown or text files to merge.');
    }

    const parts = [];

    for (let i = 0; i < this.selectedFiles.length; i++) {
      const file = this.selectedFiles[i];
      const text = await file.text();
      parts.push(text.trimEnd());

      this.updateProgress(((i + 1) / this.selectedFiles.length) * 90);
      await new Promise(resolve => setTimeout(resolve, 30));
    }

    const merged = parts.join('\n\n---\n\n') + '\n';

    this.updateProgress(100);

    downloadFile(merged, 'merged_document.md', 'text/markdown');
  }
}

// Initialize app
new ToolManager();
