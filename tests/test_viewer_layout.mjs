import assert from 'node:assert/strict';
import { test } from 'node:test';
import { displayBox, pagePoint, detailScale, previewScale, rasterTransform, visibleTiles } from '../static/viewer-layout.mjs';

test('PDF crop is expressed in rotated, media-relative coordinates', () => {
    const media = [10, 20, 310, 220], crop = [30, 50, 250, 210];
    assert.deepEqual(displayBox(media, crop, 0), [20, 10, 220, 160]);
    assert.deepEqual(displayBox(media, crop, 90), [30, 20, 160, 220]);
    assert.deepEqual(displayBox(media, crop, 180), [60, 30, 220, 160]);
    assert.deepEqual(displayBox(media, crop, 270), [10, 60, 160, 220]);
});

test('a cropped overlay point lands on the same pixel inside a panned tile at each zoom', () => {
    const box = [20, 10, 2200, 1600];
    for (const scale of [.5, 1.5, 4, 8]) {
        const [x, y] = pagePoint(box, scale, 330, 450);
        const [tile] = visibleTiles(box[2] * scale, box[3] * scale, x, y, x + 1, y + 1);
        const density = detailScale(scale, 2);
        const [a, , , d, tx, ty] = rasterTransform(density, tile.x, tile.y);
        assert.ok(Math.abs((a * x + tx) / density + tile.x - x) < 1e-9);
        assert.ok(Math.abs((d * y + ty) / density + tile.y - y) < 1e-9);
    }
});

test('A0-sized view keeps the overview and detail buffers bounded', () => {
    assert.equal(previewScale(3400, 2400, 2) * 3400, 1200);
    const tiles = visibleTiles(3400 * 8, 2400 * 8, 10800, 8100, 11400, 8600);
    assert.ok(tiles.length > 0 && tiles.length <= 12);
    assert.equal(detailScale(1.5, 2) * 1.5 * 72, 300);
    assert.equal(detailScale(.1, 2), 4);
    assert.ok(tiles.every(({ width, height }) => width * 4 <= 1024 && height * 4 <= 1024));
});
