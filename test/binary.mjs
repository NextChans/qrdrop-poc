// QRDrop v2 — raw 바이너리 프레이밍 검증 (Node, 카메라 광학 제외)
//
// 핵심 리스크: base64를 버리고 임의 바이트(0x00·0xFF·구분자 ':' 포함)를 QR byte mode로
// 보낼 때, qrcode-generator(인코드)와 jsQR(디코드, binaryData)이 바이트를 무손실로
// 왕복하는가. 그리고 17B 고정 바이너리 헤더가 정확히 pack/parse 되는가.
//
// 검증 1: 임의 바이트 → latin1 → QR → jsQR.binaryData → 원본 바이트 일치
// 검증 2: 완전한 바이너리 프레임(magic+seed+k+len+sess+payload) 왕복 후 전 필드 일치

import qrcode from 'qrcode-generator'
import jsQR from 'jsqr'

// --- 프레이밍 (src/fountain.ts 미러) ---
const MAGIC = [0x51, 0x44, 0x34] // 'Q','D','4'
const HEADER = 18

function bytesToLatin1(b) {
  let s = ''
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i])
  return s
}

function buildFrame(seed, k, len, sess, payload, flags = 0) {
  const buf = new Uint8Array(HEADER + payload.length)
  const dv = new DataView(buf.buffer)
  buf[0] = MAGIC[0]
  buf[1] = MAGIC[1]
  buf[2] = MAGIC[2]
  buf[3] = flags & 0xff
  dv.setUint32(4, seed >>> 0)
  dv.setUint16(8, k)
  dv.setUint32(10, len)
  dv.setUint32(14, sess >>> 0)
  buf.set(payload, HEADER)
  return buf
}

function parseFrame(bin) {
  const b = bin instanceof Uint8Array ? bin : Uint8Array.from(bin)
  if (b.length <= HEADER) return null
  if (b[0] !== MAGIC[0] || b[1] !== MAGIC[1] || b[2] !== MAGIC[2]) return null
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  return {
    flags: b[3],
    seed: dv.getUint32(4),
    k: dv.getUint16(8),
    len: dv.getUint32(10),
    sess: dv.getUint32(14),
    data: b.slice(HEADER),
  }
}

// QR 모듈 매트릭스 → RGBA(흰 배경/검은 모듈), quiet zone 포함 (roundtrip.mjs 동일)
function renderRGBA(qr, scale = 6, margin = 4) {
  const count = qr.getModuleCount()
  const size = (count + margin * 2) * scale
  const data = new Uint8ClampedArray(size * size * 4).fill(255)
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (!qr.isDark(r, c)) continue
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const x = (c + margin) * scale + dx
          const y = (r + margin) * scale + dy
          const i = (y * size + x) * 4
          data[i] = data[i + 1] = data[i + 2] = 0
        }
      }
    }
  }
  return { data, size }
}

// 바이트 배열 → QR → jsQR.binaryData
function qrRoundtripBytes(bytes, ecc) {
  const qr = qrcode(0, ecc)
  qr.addData(bytesToLatin1(bytes), 'Byte')
  qr.make()
  const { data, size } = renderRGBA(qr)
  const code = jsQR(data, size, size, { inversionAttempts: 'dontInvert' })
  return { modules: qr.getModuleCount(), binaryData: code?.binaryData ?? null }
}

function equal(a, b) {
  if (!a || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// 0x00~0xFF 전 구간 + 구분자 ':'(0x3a) 를 포함하도록 결정적으로 생성
function adversarialBytes(n) {
  const b = new Uint8Array(n)
  for (let i = 0; i < n; i++) b[i] = (i * 73 + (i % 7) * 31) & 0xff
  // 까다로운 값 강제 삽입
  if (n > 5) {
    b[0] = 0x00
    b[1] = 0xff
    b[2] = 0x3a // ':'
    b[3] = 0x0a // '\n'
    b[4] = 0x51 // 'Q' (magic 충돌 유도)
  }
  return b
}

let pass = 0
let fail = 0

console.log('=== 검증 1: 임의 바이트 QR byte-mode 왕복 (qrcode-generator ↔ jsQR.binaryData) ===')
console.log('bytes | ecc | modules | 결과')
console.log('------|-----|---------|-----')
for (const ecc of ['M', 'Q']) {
  for (const n of [200, 700, 1200]) {
    const src = adversarialBytes(n)
    let r
    try {
      r = qrRoundtripBytes(src, ecc)
    } catch (e) {
      console.log(`${String(n).padStart(5)} |  ${ecc}  |    -    | THROW: ${e.message}`)
      fail++
      continue
    }
    const ok = equal(r.binaryData, src)
    if (ok) pass++
    else fail++
    console.log(`${String(n).padStart(5)} |  ${ecc}  | ${String(r.modules).padStart(7)} | ${ok ? 'OK ✅' : 'FAIL ❌'}`)
  }
}

console.log('\n=== 검증 2: 완전한 바이너리 프레임 왕복 (헤더 17B + 페이로드) ===')
console.log('seed |   k |    len |   sess | payload | 결과')
console.log('-----|-----|--------|--------|---------|-----')
const cases = [
  { seed: 0, k: 1, len: 525, sess: 0x00000000, plen: 525, flags: 0 },
  { seed: 12345, k: 250, len: 130000, sess: 0xdeadbeef, plen: 700, flags: 1 },
  { seed: 0xffffffff, k: 65535, len: 4000000, sess: 0xffffffff, plen: 900, flags: 1 },
]
for (const tc of cases) {
  const payload = adversarialBytes(tc.plen)
  const frame = buildFrame(tc.seed, tc.k, tc.len, tc.sess, payload, tc.flags)
  let parsed = null
  try {
    const r = qrRoundtripBytes(frame, 'M')
    parsed = r.binaryData ? parseFrame(r.binaryData) : null
  } catch (e) {
    console.log(`THROW: ${e.message}`)
    fail++
    continue
  }
  const ok =
    parsed &&
    parsed.seed === tc.seed &&
    parsed.k === tc.k &&
    parsed.len === tc.len &&
    parsed.sess === tc.sess &&
    parsed.flags === tc.flags &&
    equal(parsed.data, payload)
  if (ok) pass++
  else fail++
  console.log(
    `${String(tc.seed).padStart(4)} | ${String(tc.k).padStart(3)} | ${String(tc.len).padStart(6)} | ` +
      `${tc.sess.toString(16).padStart(6)} | ${String(tc.plen).padStart(7)} | ${ok ? 'OK ✅' : 'FAIL ❌'}`
  )
}

console.log(`\n총 ${pass + fail}건 중 통과 ${pass} / 실패 ${fail}`)
console.log('→ base64 없이 raw 바이트가 QR byte mode로 무손실 왕복. 페이로드 33% 오버헤드 제거.')
process.exit(fail ? 1 : 0)
