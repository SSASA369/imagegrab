// gen-fixtures.mjs —— 用 Node 内置 zlib 手写 PNG，生成测试固件图片（纯色块）
// 用法：node gen-fixtures.mjs
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'img');
fs.mkdirSync(outDir, { recursive: true });

/* ---- 最小 PNG 编码器 ---- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** 把 RGBA 像素缓冲编码为 PNG 文件缓冲 */
function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  // 每行前置 filter byte 0
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** 纯色块 + 白色圆点 + 白色折线（模拟商品图，方便肉眼区分） */
function drawPicture(size, [r, g, b]) {
  const px = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = b; px[i * 4 + 3] = 255;
  }
  const put = (x, y, w = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = px[i + 1] = px[i + 2] = w;
  };
  // 左上圆形
  const c = size * 0.3, cr = size * 0.08;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if ((x - c) ** 2 + (y - c) ** 2 <= cr * cr) put(x, y);
  }
  // 底部山脉折线（粗线）
  const lw = Math.max(1, Math.round(size * 0.045));
  const pts = [[0.22, 0.74], [0.44, 0.5], [0.58, 0.63], [0.68, 0.53], [0.8, 0.74]].map(
    ([fx, fy]) => [fx * size, fy * size]
  );
  for (let s = 0; s < pts.length - 1; s++) {
    const [x1, y1] = pts[s], [x2, y2] = pts[s + 1];
    const steps = Math.ceil(Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1)));
    for (let i = 0; i <= steps; i++) {
      const x = Math.round(x1 + ((x2 - x1) * i) / steps);
      const y = Math.round(y1 + ((y2 - y1) * i) / steps);
      for (let dy = -lw; dy <= lw; dy++)
        for (let dx = -lw; dx <= lw; dx++)
          if (dx * dx + dy * dy <= lw * lw) put(x + dx, y + dy);
    }
  }
  return px;
}

const FIXTURES = {
  red: [224, 83, 61],
  blue: [61, 125, 224],
  green: [55, 166, 99],
  orange: [224, 138, 61],
  purple: [124, 58, 237],
  pink: [214, 72, 155],
  gold: [201, 162, 39]
};

for (const [name, rgb] of Object.entries(FIXTURES)) {
  fs.writeFileSync(path.join(outDir, `${name}.png`), encodePng(800, 800, drawPicture(800, rgb)));
  console.log(`ok ${name}.png 800x800`);
}

// 16x16 小图标（应被过滤）
fs.writeFileSync(path.join(outDir, 'icon16.png'), encodePng(16, 16, drawPicture(16, [139, 134, 163])));
console.log('ok icon16.png 16x16');
// 1x1 像素图（应被过滤）
const one = Buffer.from([255, 255, 255, 255]);
fs.writeFileSync(path.join(outDir, 'pixel1.png'), encodePng(1, 1, one));
console.log('ok pixel1.png 1x1');
