// 헤드리스 라운드트립 검증:
//   payload → qrcode-generator(QR) → RGBA 버퍼 렌더 → jsQR 디코딩 → payload 일치?
// 브라우저/카메라 없이 "qrcode-generator ↔ jsQR 상호운용성"과 프로토콜을 검증한다.
import qrcode from 'qrcode-generator'
import jsQR from 'jsqr'

// 프로토콜 함수 인라인(빌드 의존 없이 순수 검증)
const MAGIC = 'QD1'
const buildFrame = (f) => `${MAGIC}:${f.idx}:${f.total}:${f.sess}:${f.data}`
const parseFrame = (raw) => {
  if (!raw.startsWith(MAGIC + ':')) return null
  const p = raw.split(':')
  if (p.length !== 5) return null
  return { idx: +p[1], total: +p[2], sess: p[3], data: p[4] }
}

// QR 모듈 매트릭스 → RGBA(흰 배경/검은 모듈), quiet zone 포함
function renderRGBA(qr, scale = 6, margin = 4) {
  const count = qr.getModuleCount()
  const size = (count + margin * 2) * scale
  const data = new Uint8ClampedArray(size * size * 4).fill(255) // 흰색
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

function roundtrip(payload, ecc) {
  const qr = qrcode(0, ecc)
  qr.addData(payload, 'Byte')
  qr.make()
  const { data, size } = renderRGBA(qr)
  const code = jsQR(data, size, size, { inversionAttempts: 'dontInvert' })
  return { ok: !!code && code.data === payload, decoded: code?.data, modules: qr.getModuleCount(), size }
}

// 다양한 base64 청크 크기에서 검증
const b64alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const makeB64 = (n) => Array.from({ length: n }, (_, i) => b64alphabet[(i * 7 + 13) % 64]).join('')

let pass = 0, fail = 0
console.log('chunk | ecc | modules | imgpx | result')
console.log('------|-----|---------|-------|-------')
for (const ecc of ['L', 'M', 'Q']) {
  for (const chunk of [200, 400, 700, 1000, 1500]) {
    const sess = 'abc12'
    const payload = buildFrame({ idx: 3, total: 180, sess, data: makeB64(chunk) })
    let r
    try {
      r = roundtrip(payload, ecc)
    } catch (e) {
      console.log(`${String(chunk).padStart(5)} |  ${ecc}  |    -    |   -   | THROW: ${e.message}`)
      fail++
      continue
    }
    // parse 검증도 함께
    const parsed = r.ok ? parseFrame(r.decoded) : null
    const parseOk = parsed && parsed.idx === 3 && parsed.total === 180 && parsed.sess === sess
    const status = r.ok && parseOk ? 'OK ✅' : 'FAIL ❌'
    if (r.ok && parseOk) pass++; else fail++
    console.log(
      `${String(chunk).padStart(5)} |  ${ecc}  | ${String(r.modules).padStart(7)} | ${String(r.size).padStart(5)} | ${status}`
    )
  }
}
console.log(`\n총 ${pass + fail}건 중 통과 ${pass} / 실패 ${fail}`)
process.exit(fail ? 1 : 0)
