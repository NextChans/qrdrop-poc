// PWA 아이콘 생성기 — 외부 이미지 라이브러리 없이 픽셀을 직접 그려 PNG로 인코딩.
// 브랜드 배경 위에 QR 모티프(파인더 패턴 + 모듈)를 그린다. maskable 안전영역(중앙 80%) 고려.
//
// 출력: public/icon-192.png, icon-512.png, maskable-512.png, apple-touch-icon-180.png
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(__dirname, '../public')
mkdirSync(OUT, { recursive: true })

const BG = [0x33, 0x3d, 0x66] // 짙은 남색 배경
const ACCENT = [0x55, 0x67, 0xff] // 브랜드 블루
const WHITE = [0xff, 0xff, 0xff]
const BLACK = [0x10, 0x12, 0x1a]

// 결정적 PRNG (mulberry32) — 매번 같은 모듈 패턴
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// size×size RGB 버퍼에 아이콘을 그린다. safe=true면 QR을 중앙 72%로(maskable 안전영역).
function render(size, safe) {
  const buf = Buffer.alloc(size * size * 3)
  const put = (x, y, c) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return
    const i = (y * size + x) * 3
    buf[i] = c[0]
    buf[i + 1] = c[1]
    buf[i + 2] = c[2]
  }
  const rect = (x0, y0, w, h, c) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) put(x, y, c)
  }

  // 배경: 대각 그라데이션(BG→ACCENT)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = (x + y) / (2 * size)
      put(x, y, [
        Math.round(BG[0] + (ACCENT[0] - BG[0]) * t),
        Math.round(BG[1] + (ACCENT[1] - BG[1]) * t),
        Math.round(BG[2] + (ACCENT[2] - BG[2]) * t),
      ])
    }
  }

  // QR 영역(흰 패널)
  const side = Math.round(size * (safe ? 0.62 : 0.78))
  const off = Math.round((size - side) / 2)
  const N = 21 // 모듈 그리드
  const m = side / N
  const mx = (col) => Math.round(off + col * m)
  rect(off, off, side, side, WHITE)

  // 모듈 채움(파인더 패턴 영역 제외, 결정적 랜덤)
  const r = rng(20240617)
  const inFinder = (cr, cc) =>
    (cr < 8 && cc < 8) || (cr < 8 && cc >= N - 8) || (cr >= N - 8 && cc < 8)
  for (let cr = 0; cr < N; cr++) {
    for (let cc = 0; cc < N; cc++) {
      if (inFinder(cr, cc)) continue
      if (r() < 0.45) rect(mx(cc), mx(cr), Math.ceil(m), Math.ceil(m), BLACK)
    }
  }

  // 파인더 패턴 3개(7×7 외곽 검정 → 5×5 흰 → 3×3 검정)
  const finder = (cr, cc) => {
    rect(mx(cc), mx(cr), Math.ceil(7 * m), Math.ceil(7 * m), BLACK)
    rect(mx(cc + 1), mx(cr + 1), Math.ceil(5 * m), Math.ceil(5 * m), WHITE)
    rect(mx(cc + 2), mx(cr + 2), Math.ceil(3 * m), Math.ceil(3 * m), BLACK)
  }
  finder(0, 0)
  finder(0, N - 7)
  finder(N - 7, 0)

  return buf
}

// --- 최소 PNG 인코더 (RGB, color type 2) ---
function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
  }
  return (~c) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const body = Buffer.concat([typeBuf, data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function encodePNG(rgb, size) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type RGB
  // 10,11,12 = compression/filter/interlace = 0
  // 스캔라인마다 필터 바이트(0) 추가
  const stride = size * 3
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const idat = deflateSync(raw, { level: 9 })
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

const targets = [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['maskable-512.png', 512, true],
  ['apple-touch-icon-180.png', 180, false],
]
for (const [name, size, safe] of targets) {
  const png = encodePNG(render(size, safe), size)
  writeFileSync(resolve(OUT, name), png)
  console.log(`✓ ${name} (${size}×${size}, ${(png.length / 1024).toFixed(1)}KB)`)
}
console.log('아이콘 생성 완료 → public/')
