// 브라우저 안에서 v2 전체 파이프라인을 카메라만 빼고 검증한다.
// send 경로(압축→fountain 인코더→프레임→QR canvas)와 receive 경로
// (canvas getImageData→jsQR→fountain 디코더→재조립)를 직접 연결하고,
// 일부 프레임을 일부러 떨어뜨려(손실) fountain의 재시청 없는 복구를 검증한다.
import imageCompression from 'browser-image-compression'
import qrcode from 'qrcode-generator'
import jsQR from 'jsqr'
import { FountainEncoder, FountainDecoder, parseFrame } from './fountain'

const out = document.getElementById('out')!
const log = (s: string) => {
  out.textContent += s + '\n'
  console.log('[selftest]', s)
}

// 합성 사진(그라데이션 + 도형)을 만들어 압축 대상 File로 변환
async function makeSyntheticPhoto(w = 1000, h = 1000): Promise<File> {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')!
  const grad = g.createLinearGradient(0, 0, w, h)
  grad.addColorStop(0, '#ff6b6b')
  grad.addColorStop(0.5, '#4ecdc4')
  grad.addColorStop(1, '#5567ff')
  g.fillStyle = grad
  g.fillRect(0, 0, w, h)
  for (let i = 0; i < 60; i++) {
    g.fillStyle = `hsl(${(i * 37) % 360}, 70%, 60%)`
    g.beginPath()
    g.arc(((i * 131) % w), ((i * 197) % h), 20 + (i % 40), 0, Math.PI * 2)
    g.fill()
  }
  const blob: Blob = await new Promise((res) => c.toBlob((b) => res(b!), 'image/png'))
  return new File([blob], 'synthetic.png', { type: 'image/png' })
}

// QR 프레임 문자열 → 흰배경 canvas 렌더(송신부와 동일 로직)
function renderFrameToCanvas(payload: string, ecc: 'L' | 'M' | 'Q' | 'H', cell = 6, margin = 4): HTMLCanvasElement {
  const qr = qrcode(0, ecc)
  qr.addData(payload, 'Byte')
  qr.make()
  const count = qr.getModuleCount()
  const size = (count + margin * 2) * cell
  const c = document.createElement('canvas')
  c.width = size
  c.height = size
  const g = c.getContext('2d')!
  g.fillStyle = '#fff'
  g.fillRect(0, 0, size, size)
  g.fillStyle = '#000'
  for (let r = 0; r < count; r++)
    for (let col = 0; col < count; col++)
      if (qr.isDark(r, col)) g.fillRect((col + margin) * cell, (r + margin) * cell, cell, cell)
  return c
}

// canvas → jsQR 디코딩 → raw 바이트(byte mode, 수신부와 동일 로직)
function decodeCanvas(c: HTMLCanvasElement): number[] | null {
  const g = c.getContext('2d', { willReadFrequently: true })!
  const img = g.getImageData(0, 0, c.width, c.height)
  const code = jsQR(img.data, c.width, c.height, { inversionAttempts: 'dontInvert' })
  return code?.binaryData ?? null
}

async function run() {
  const t0 = performance.now()
  log('1) 합성 사진 생성 (1000×1000 PNG)')
  const file = await makeSyntheticPhoto()
  log(`   원본 ${(file.size / 1024).toFixed(0)}KB`)

  const ecc: 'M' = 'M'
  const blockSize = 700 // 프레임당 raw 바이트(base64 없음)

  log('2) 압축 (maxDim=600, q=0.6, jpeg)')
  const compressed = await imageCompression(file, {
    maxWidthOrHeight: 600,
    initialQuality: 0.6,
    fileType: 'image/jpeg',
    useWebWorker: true,
  })
  log(`   압축 ${(compressed.size / 1024).toFixed(0)}KB`)

  const bytes = new Uint8Array(await compressed.arrayBuffer())
  const enc = new FountainEncoder(bytes, blockSize)
  log(`3) fountain 인코더 · ${enc.k} 블록 (sess=${enc.sess})`)

  const LOSS = 0.2 // 프레임 20% 손실 주입(카메라 누락 시뮬레이션)
  log(`4) 각 프레임 QR 렌더 → jsQR 디코딩 → fountain 디코더 (손실 ${Math.round(LOSS * 100)}% 주입)`)
  const dec = new FountainDecoder(enc.k, enc.len, enc.sess, blockSize)
  let seed = 0
  let qrFail = 0
  let dropped = 0
  let firstModules = 0
  const cap = enc.k * 20 + 500
  const decodeStart = performance.now()
  while (!dec.done && seed < cap) {
    const frame = enc.frame(seed)
    const c = renderFrameToCanvas(frame, ecc)
    if (!firstModules) firstModules = c.width / 6 - 8
    seed++
    if (Math.random() < LOSS) {
      dropped++
      continue // 손실: 디코더에 전달하지 않음
    }
    const decoded = decodeCanvas(c)
    if (decoded === null) {
      qrFail++
      continue
    }
    const pf = parseFrame(decoded)
    if (!pf || pf.sess !== enc.sess) {
      qrFail++
      continue
    }
    dec.addSymbol(pf.seed, pf.data)
  }
  const decodeMs = performance.now() - decodeStart
  const overhead = (dec.symbolsSeen / enc.k).toFixed(2)
  log(
    `   QR 모듈수 ≈ ${firstModules} · QR 디코딩 실패 ${qrFail} · 손실주입 ${dropped} · ` +
      `수신 심볼 ${dec.symbolsSeen} (오버헤드 ${overhead}×) · ${(decodeMs / Math.max(1, seed)).toFixed(1)}ms/프레임`
  )

  log('5) 재조립 후 원본 바이트 일치 검증')
  if (!dec.done) {
    log(`   ❌ 복원 미완료 (${dec.recoveredCount}/${enc.k} 블록, ${seed} 프레임 시도)`)
    finish(false, t0)
    return
  }
  const rbytes = dec.result()!
  let identical = rbytes.length === bytes.length
  if (identical) for (let i = 0; i < bytes.length; i++) if (rbytes[i] !== bytes[i]) { identical = false; break }
  log(`   복원 ${(rbytes.length / 1024).toFixed(0)}KB · 바이트 동일: ${identical ? 'YES ✅' : 'NO ❌'}`)

  finish(identical, t0)
}

function finish(ok: boolean, t0: number) {
  const ms = (performance.now() - t0).toFixed(0)
  log(`\n결과: ${ok ? 'PASS ✅ — v2 fountain 파이프라인 정상(손실 복구 포함)' : 'FAIL ❌'} (${ms}ms)`)
  ;(window as any).__selftest = { ok }
  out.setAttribute('data-done', ok ? 'pass' : 'fail')
}

run().catch((e) => {
  log('예외: ' + (e as Error).message)
  finish(false, performance.now())
})
