import { AnnotationMode, getDocument, GlobalWorkerOptions } from '/pdfjs/build/pdf.mjs';
import { detailScale, previewScale, rasterTransform, visibleTiles } from './viewer-layout.mjs';
export { displayBox, pagePoint } from './viewer-layout.mjs';

GlobalWorkerOptions.workerSrc = '/pdfjs/build/pdf.worker.mjs';

export function openPdf(file) {
    // Blob URLs keep the uploaded originals local and avoid a second server upload.
    const url = URL.createObjectURL(file);
    const task = getDocument({
        url,
        cMapUrl: '/pdfjs/cmaps/',
        standardFontDataUrl: '/pdfjs/standard_fonts/',
        wasmUrl: '/pdfjs/wasm/',
        iccUrl: '/pdfjs/iccs/',
        canvasMaxAreaInBytes: 16 * 1024 * 1024,
    });
    return {
        document: task.promise,
        async destroy() {
            try { await task.destroy(); }
            finally { URL.revokeObjectURL(url); }
        },
    };
}

export class PdfPane {
    constructor(pdfPage, box, layer, scroller, annotations, onError) {
        this.page = pdfPage;
        this.layer = layer;
        this.scroller = scroller;
        this.annotations = annotations ? AnnotationMode.ENABLE : AnnotationMode.DISABLE;
        this.onError = onError;
        this.base = pdfPage.getViewport({ scale: 1 });
        this.box = box;
        this.tiles = new Map();
        this.frame = 0;
        this.active = null;
        this.disposed = false;
    }

    resize(width, inspect) {
        if (this.viewport?.width === width && this.inspect === inspect) return;
        this.viewport = this.page.getViewport({ scale: width / this.base.width });
        this.inspect = inspect;
        this.clearTiles();
        if (!this.preview) {
            // Keep this low-resolution render under the detail tiles while scrolling.
            const density = previewScale(this.viewport.width, this.viewport.height, devicePixelRatio);
            const { canvas, task } = this.draw(this.viewport, density, 0, 0,
                this.viewport.width, this.viewport.height);
            this.preview = canvas;
            this.previewTask = task;
            canvas.className = 'pdf-preview';
            canvas.style.width = `${100 * canvas.width / (this.viewport.width * density)}%`;
            canvas.style.height = `${100 * canvas.height / (this.viewport.height * density)}%`;
            this.layer.prepend(canvas);
            task.promise.catch(error => this.report(error));
        }
        this.schedule();
    }

    draw(viewport, density, x, y, width, height) {
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(width * density);
        canvas.height = Math.ceil(height * density);
        const task = this.page.render({
            canvas, viewport, annotationMode: this.annotations,
            transform: rasterTransform(density, x, y),
        });
        return { canvas, task };
    }

    schedule() {
        if (!this.disposed && !this.frame) {
            this.frame = requestAnimationFrame(() => {
                this.frame = 0;
                this.refreshTiles();
            });
        }
    }

    refreshTiles() {
        if (!this.inspect || !this.viewport) return;
        const bounds = this.layer.getBoundingClientRect();
        const scroll = this.scroller.getBoundingClientRect();
        const { width, height } = this.viewport;
        const left = scroll.left + this.scroller.clientLeft - bounds.left;
        const top = scroll.top + this.scroller.clientTop - bounds.top;
        const wanted = visibleTiles(width, height, left, top,
            left + this.scroller.clientWidth, top + this.scroller.clientHeight);
        const keyFor = tile => `${tile.x}:${tile.y}`;
        const keys = new Set(wanted.map(keyFor));
        for (const [key, canvas] of this.tiles) {
            if (!keys.has(key)) {
                canvas.remove();
                this.tiles.delete(key);
            }
        }
        if (this.active) {
            if (!keys.has(this.active.key)) this.active.task.cancel();
            return;
        }
        const next = wanted.find(tile => !this.tiles.has(keyFor(tile)));
        if (!next) return;

        const { x, y } = next;
        const density = detailScale(this.viewport.scale, devicePixelRatio);
        const { canvas, task } = this.draw(this.viewport, density, x, y, next.width, next.height);
        // Keep the exact transform even when the backing canvas rounds up to whole pixels.
        const tile = document.createElement('div');
        tile.className = 'pdf-tile';
        Object.assign(tile.style, {
            left: `${x}px`, top: `${y}px`,
            width: `${next.width}px`, height: `${next.height}px`,
        });
        canvas.style.width = `${canvas.width / density}px`;
        canvas.style.height = `${canvas.height / density}px`;
        tile.append(canvas);
        const active = { key: keyFor(next), task };
        this.active = active;
        task.promise.then(() => {
            if (this.active !== active) return;
            this.tiles.set(active.key, tile);
            this.layer.append(tile);
            this.schedule();
        }).catch(error => {
            this.report(error);
            if (error.name === 'RenderingCancelledException') this.schedule();
        }).finally(() => {
            if (this.active === active) this.active = null;
        });
    }

    report(error) {
        if (!this.disposed && error.name !== 'RenderingCancelledException') this.onError(error);
    }

    clearTiles() {
        this.active?.task.cancel();
        this.active = null;
        for (const canvas of this.tiles.values()) canvas.remove();
        this.tiles.clear();
    }

    dispose() {
        this.disposed = true;
        cancelAnimationFrame(this.frame);
        this.previewTask?.cancel();
        this.clearTiles();
    }
}
