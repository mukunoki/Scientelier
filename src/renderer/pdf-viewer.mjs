import * as pdfjs from "../../node_modules/pdfjs-dist/build/pdf.mjs";
// The official viewer component consumes the API exported by pdf.mjs.
const { EventBus, PDFLinkService, PDFFindController, PDFViewer } = await import("../../node_modules/pdfjs-dist/web/pdf_viewer.mjs");
pdfjs.GlobalWorkerOptions.workerSrc = new URL("../../node_modules/pdfjs-dist/build/pdf.worker.mjs", import.meta.url).href;

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const taskId = params.get("task");
const round = params.has("round") ? Number(params.get("round")) : undefined;
const documentId = params.get("document") ?? "report";
const pageKey = `pdf-page:${taskId}:${round ?? "current"}:${documentId}`;
const widthKey = "pdf-sidebar-width";
const saved = (key, fallback) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
const persist = (key, value) => { try { localStorage.setItem(key, String(value)); } catch { /* Optional preference storage. */ } };
let sidebarWidth = Number(saved(widthKey, 180)) || 180;
function setWidth(value, remember = true) {
  const max = Math.max(100, Math.min(450, Math.floor(innerWidth * .55)));
  const width = Math.max(100, Math.min(max, value));
  document.documentElement.style.setProperty("--sidebar-width", `${width}px`);
  $("splitter").setAttribute("aria-valuemin", "100");
  $("splitter").setAttribute("aria-valuemax", String(max));
  $("splitter").setAttribute("aria-valuenow", String(Math.round(width)));
  if (remember) { sidebarWidth = width; persist(widthKey, width); }
}
setWidth(sidebarWidth, false);
addEventListener("resize", () => setWidth(sidebarWidth, false));
$("splitter").addEventListener("pointerdown", event => {
  if (event.button !== 0) return;
  event.preventDefault();
  const splitter = event.currentTarget;
  splitter.setPointerCapture(event.pointerId);
  document.body.classList.add("resizing");
  const onMove = e => setWidth(e.clientX);
  const finish = () => {
    document.body.classList.remove("resizing");
    splitter.removeEventListener("pointermove", onMove);
    splitter.removeEventListener("lostpointercapture", finish);
  };
  splitter.addEventListener("pointermove", onMove);
  splitter.addEventListener("lostpointercapture", finish);
});
$("splitter").addEventListener("dblclick", () => setWidth(180));
$("splitter").addEventListener("keydown", e => {
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); setWidth($("sidebar").offsetWidth + (e.key === "ArrowLeft" ? -10 : 10)); }
});
$("toggle").addEventListener("click", () => {
  const hidden = document.body.classList.toggle("sidebar-hidden");
  $("toggle").setAttribute("aria-expanded", String(!hidden));
});
for (const name of ["pages", "outline"]) $(name + "Tab").addEventListener("click", () => {
  $("thumbnails").hidden = name !== "pages";
  $("outline").hidden = name !== "outline";
  $("pagesTab").setAttribute("aria-pressed", String(name === "pages"));
  $("outlineTab").setAttribute("aria-pressed", String(name === "outline"));
});

const eventBus = new EventBus();
const linkService = new PDFLinkService({ eventBus });
// Keep internal citations navigable without allowing a PDF to navigate the app externally.
linkService.externalLinkEnabled = false;
const findController = new PDFFindController({ eventBus, linkService });
const viewer = new PDFViewer({
  container: $("viewerContainer"), viewer: $("viewer"), eventBus, linkService, findController,
  annotationMode: pdfjs.AnnotationMode.ENABLE, enableScripting: false,
  imageResourcesPath: new URL("../../node_modules/pdfjs-dist/web/images/", import.meta.url).href
});
linkService.setViewer(viewer);
let ready = false;
let loadingTask;
let blobUrl;
const fit = () => { if (ready) viewer.currentScaleValue = $("zoom").value; };
new ResizeObserver(fit).observe($("viewerContainer"));
eventBus.on("pagesinit", () => {
  ready = true;
  fit();
  const initial = Number(saved(pageKey, 1));
  viewer.currentPageNumber = Math.min(viewer.pagesCount, Math.max(1, initial || 1));
  $("status").hidden = true;
  document.body.dataset.ready = "true";
});
eventBus.on("pagechanging", ({ pageNumber }) => {
  $("page").value = String(pageNumber);
  persist(pageKey, pageNumber);
  $("previous").disabled = pageNumber <= 1;
  $("next").disabled = pageNumber >= viewer.pagesCount;
  for (const button of $("thumbnails").children) button.setAttribute("aria-current", String(Number(button.dataset.page) === pageNumber));
});
$("zoom").addEventListener("change", fit);
$("previous").addEventListener("click", () => { if (ready) viewer.previousPage(); });
$("next").addEventListener("click", () => { if (ready) viewer.nextPage(); });
$("page").addEventListener("change", () => {
  if (ready) viewer.currentPageNumber = Math.min(viewer.pagesCount, Math.max(1, Number($("page").value) || 1));
});
const search = (again = false, previous = false) => eventBus.dispatch("find", {
  source: window, type: again ? "again" : "", query: $("search").value,
  caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: previous, matchDiacritics: false
});
$("search").addEventListener("input", () => search());
$("search").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); search(true, e.shiftKey); } });
eventBus.on("updatefindmatchescount", ({ matchesCount }) => { $("matches").textContent = `${matchesCount.current}/${matchesCount.total}`; });
eventBus.on("updatefindcontrolstate", ({ state }) => { if (state === 1) $("matches").textContent = "0件"; });
addEventListener("keydown", e => { if ((e.metaKey || e.ctrlKey) && e.key === "f") { e.preventDefault(); $("search").focus(); } });
$("download").addEventListener("click", () => {
  if (!blobUrl) return;
  const a = document.createElement("a"); a.href = blobUrl; a.download = `${["paper", "poster"].includes(documentId) ? documentId : "report"}.pdf`; a.click();
});

async function load() {
  const bytes = await window.parent.harness.readReportPdf(taskId, round, documentId);
  blobUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const base = new URL("../../node_modules/pdfjs-dist/", import.meta.url);
  loadingTask = pdfjs.getDocument({
    data: bytes, isEvalSupported: false, enableXfa: false,
    cMapUrl: new URL("cmaps/", base).href, cMapPacked: true,
    standardFontDataUrl: new URL("standard_fonts/", base).href,
    wasmUrl: new URL("wasm/", base).href
  });
  const pdf = await loadingTask.promise;
  $("total").textContent = String(pdf.numPages);
  $("page").max = String(pdf.numPages);
  $("download").disabled = false;
  linkService.setDocument(pdf);
  findController.setDocument(pdf);
  viewer.setDocument(pdf);
  // Only render thumbnails as they enter the visible sidebar, one at a time.
  let thumbnails = Promise.resolve();
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) {
      observer.unobserve(entry.target);
      thumbnails = thumbnails.then(async () => {
        const page = await pdf.getPage(Number(entry.target.dataset.page));
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: 360 / base.width });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        entry.target.prepend(canvas);
      }).catch(() => { /* The full-size page remains available if a thumbnail fails. */ });
    }
  }, { root: $("thumbnails"), rootMargin: "100px" });
  for (let n = 1; n <= pdf.numPages; n++) {
    const button = document.createElement("button");
    button.textContent = String(n); button.dataset.page = String(n);
    button.setAttribute("aria-label", `${n}ページへ移動`);
    button.addEventListener("click", () => { viewer.currentPageNumber = n; });
    $("thumbnails").append(button); observer.observe(button);
  }
  const outline = await pdf.getOutline();
  const addOutline = (items, depth = 0) => {
    for (const item of items) {
      const button = document.createElement("button");
      button.textContent = item.title; button.style.paddingLeft = `${8 + Math.min(depth, 6) * 10}px`;
      button.disabled = !item.dest;
      button.addEventListener("click", () => linkService.goToDestination(item.dest));
      $("outline").append(button);
      if (item.items) addOutline(item.items, depth + 1);
    }
  };
  if (outline?.length) addOutline(outline); else $("outline").textContent = "目次はありません。";
  addEventListener("pagehide", () => observer.disconnect(), { once: true });
}
load().catch(error => { $("status").hidden = false; $("status").textContent = `PDFを表示できません: ${error.message}`; document.body.dataset.error = "true"; });
addEventListener("pagehide", () => { if (blobUrl) URL.revokeObjectURL(blobUrl); void loadingTask?.destroy(); });
