import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';

const python = process.env.PYTHON || 'python3';

test('cropped A0 originals, overlays and tiles stay aligned through zoom and pan', { timeout: 45000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'redline-diff-viewer-'));
    let server, browser;
    try {
        execFileSync(python, ['-c', `
import io
import sys
from pathlib import Path
from pypdf import PdfWriter
from pypdf.annotations import FreeText
from reportlab.pdfgen import canvas

for name, label in [('before', 'old'), ('after', 'new')]:
    source = io.BytesIO()
    drawing = canvas.Canvas(source, pagesize=(3370, 2384))
    drawing.setFont('Helvetica', 32)
    drawing.drawString(1580, 1250, label)
    drawing.rect(1600, 1100, 30, 30, stroke=0, fill=1)
    drawing.rect(1510, 1225, 38, 38, stroke=0, fill=1)
    if name == 'before':
        drawing.rect(1500, 1100, 42, 42, stroke=0, fill=1)
    drawing.showPage()
    drawing.save()
    writer = PdfWriter()
    writer.append(io.BytesIO(source.getvalue()))
    page = writer.pages[0]
    page.mediabox.lower_left = (10, 20)
    page.cropbox.lower_left = (100, 150)
    page.cropbox.upper_right = (3200, 2100)
    page.rotate(90)
    if name == 'before':
        writer.add_annotation(0, FreeText(text='Review this area', rect=(1490, 1145, 1550, 1160)))
    if name == 'after':
        writer.add_blank_page(width=300, height=300)
    with (Path(sys.argv[1]) / (name + '.pdf')).open('wb') as out:
        writer.write(out)
`, dir]);

        server = spawn(python, ['server.py', '--port', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
        const [message] = await once(server.stdout, 'data');
        const url = String(message).match(/http:\/\/127\.0\.0\.1:\d+/)[0];
        browser = await chromium.launch(process.env.CHROME_CHANNEL ? { channel: process.env.CHROME_CHANNEL } : {});
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
        let requests = 0;
        page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/jobs')) requests++; });

        await page.goto(url);
        await page.locator('#beforeFile').setInputFiles(join(dir, 'before.pdf'));
        await page.locator('#afterFile').setInputFiles(join(dir, 'after.pdf'));
        await page.locator('#compare').click();
        const before = page.locator('#beforeCanvas');
        await before.locator('.pdf-preview').waitFor();
        assert.equal(await before.locator('svg').getAttribute('viewBox'), '130 90 1950 3100');
        const mark = before.locator('svg path');
        assert.equal(await mark.count(), 1);
        assert.equal(await mark.getAttribute('fill'), '#cc4747');
        assert.equal(await page.locator('#afterCanvas svg rect[fill="#07875c"]').count(), 1);
        assert.ok(await before.locator('.pdf-preview').evaluate(canvas => Math.max(canvas.width, canvas.height) <= 1200));

        for (const zoom of [2, 6]) {
            while (Number((await page.locator('#zoomLabel').textContent()).replace('%', '')) < zoom * 100) {
                await page.locator('#zoomIn').click();
            }
            await mark.evaluate(path => {
                const box = path.getBBox(), point = new DOMPoint(box.x + box.width / 2, box.y + box.height / 2);
                const { x, y } = point.matrixTransform(path.getScreenCTM());
                const view = document.getElementById('beforeViewport'), rect = view.getBoundingClientRect();
                view.scrollBy(x - rect.left - view.clientWidth / 2, y - rect.top - view.clientHeight / 2);
            });
            await page.waitForFunction(() => {
                const mark = document.querySelector('#beforeCanvas svg path'), box = mark.getBBox();
                const { x, y } = new DOMPoint(box.x + box.width / 2, box.y + box.height / 2)
                    .matrixTransform(mark.getScreenCTM());
                return [...document.querySelectorAll('#beforeCanvas .pdf-tile canvas')].some(canvas => {
                    const rect = canvas.getBoundingClientRect();
                    if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) return false;
                    const pixel = canvas.getContext('2d').getImageData(
                        Math.floor((x - rect.left) * canvas.width / rect.width),
                        Math.floor((y - rect.top) * canvas.height / rect.height), 1, 1).data;
                    return pixel[0] < 20 && pixel[3] === 255;
                });
            });
            assert.ok(await page.locator('.pdf-tile canvas').evaluateAll(canvases =>
                canvases.every(canvas => canvas.width <= 1024 && canvas.height <= 1024)));
            await page.waitForFunction(() => {
                const before = document.getElementById('beforeViewport');
                const after = document.getElementById('afterViewport');
                return before.scrollLeft > 0 && before.scrollLeft === after.scrollLeft &&
                    before.scrollTop === after.scrollTop;
            });
        }
        const annotation = before.getByRole('button', { name: /Review this area/ });
        const regionIndex = await annotation.getAttribute('data-region-index');
        const region = page.locator(`.region[data-index="${regionIndex}"]`);
        const scroll = () => page.locator('#beforeViewport').evaluate(view => [view.scrollLeft, view.scrollTop]);
        const position = await scroll();
        await annotation.click();
        const selected = page.locator('#objectRows .selected-object');
        assert.match(await selected.textContent(), /Review this area/);
        assert.match(await region.getAttribute('class'), /active/);
        assert.ok(await page.locator('#objectRows tr').count() > 1);
        assert.equal(await page.locator('#zoomLabel').textContent(), '600%');
        assert.deepEqual(await scroll(), position);
        await annotation.press('Enter');
        assert.match(await selected.textContent(), /Review this area/);
        await selected.locator('button').click();
        assert.equal(await before.locator('.focus-box').getAttribute('visibility'), 'visible');
        assert.equal(await page.locator('#afterCanvas .focus-box').getAttribute('visibility'), 'hidden');
        assert.equal(await page.locator('#zoomLabel').textContent(), '600%');
        assert.equal(requests, 1);

        await page.locator('#mode').selectOption('diff');
        await before.locator('.pdf-layer').waitFor();
        assert.match(await before.locator('.pdf-layer').evaluate(layer => getComputedStyle(layer).clipPath), /before-clips/);
        await page.locator('#pageSelect').selectOption('1');
        await before.getByText('No matching page in this version').waitFor();
        await page.locator('#afterCanvas .pdf-preview').waitFor();
        assert.deepEqual(errors, []);
    } finally {
        await browser?.close();
        server?.kill();
        await rm(dir, { recursive: true, force: true });
    }
});
