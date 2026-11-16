// Diff coordinates use a rotated MediaBox with a top-left origin.
// PDF.js displays the intersection of the CropBox and MediaBox.
export function displayBox(media, view, rotation) {
    const [left, bottom, right, top] = media;
    const [x0, y0, x1, y1] = view;
    switch (rotation) {
        case 90: return [y0 - bottom, x0 - left, y1 - y0, x1 - x0];
        case 180: return [right - x1, y0 - bottom, x1 - x0, y1 - y0];
        case 270: return [top - y1, right - x1, y1 - y0, x1 - x0];
        default: return [x0 - left, top - y1, x1 - x0, y1 - y0];
    }
}

export function pagePoint(box, scale, x, y) {
    return [(x - box[0]) * scale, (y - box[1]) * scale];
}

export function previewScale(width, height, dpr) {
    return Math.min(dpr, 1200 / Math.max(width, height));
}

export function detailScale(cssPixelsPerPoint, dpr) {
    return Math.min(4, Math.max(dpr, 300 / 72 / cssPixelsPerPoint));
}

export function visibleTiles(width, height, left, top, right, bottom) {
    const size = 256;
    const tiles = [];
    for (let y = Math.max(0, Math.floor(top / size) * size); y < Math.min(height, bottom); y += size) {
        for (let x = Math.max(0, Math.floor(left / size) * size); x < Math.min(width, right); x += size) {
            tiles.push({ x, y, width: Math.min(size, width - x), height: Math.min(size, height - y) });
        }
    }
    return tiles;
}

export function rasterTransform(density, x, y) {
    return [density, 0, 0, density, -x * density, -y * density];
}
