// 브라우저 안에서 전체 파이프라인을 카메라만 빼고 검증한다.
// send 경로(압축→base64→프레임→QR canvas)와 receive 경로(canvas getImageData→jsQR→재조립)를 직접 연결.
import imageCompression from 'browser-image-compression'
import qrcode from 'qrcode-generator'
import jsQR from 'jsqr'
import { buildFrame, parseFrame, bytesToBase64, base64ToBytes, sessionHash, splitBase64 } from './protocol'

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

// canvas → jsQR 디코딩(수신부와 동일 로직)
function decodeCanvas(c: HTMLCanvasElement): string | null {
  const g = c.getContext('2d', { willReadFrequently: true })!
  const img = g.getImageData(0, 0, c.width, c.height)
  const code = jsQR(img.data, c.width, c.height, { inversionAttempts: 'dontInvert' })
  return code?.data ?? null
}

async function run() {
  const t0 = performance.now()
  log('1) 합성 사진 생성 (1000×1000 PNG)')
  const file = await makeSyntheticPhoto()
  log(`   원본 ${(file.size / 1024).toFixed(0)}KB`)

  const ecc: 'M' = 'M'
  const chunkSize = 700

  log('2) 압축 (maxDim=600, q=0.6, jpeg)')
  const compressed = await imageCompression(file, {
    maxWidthOrHeight: 600,
    initialQuality: 0.6,
    fileType: 'image/jpeg',
    useWebWorker: true,
  })
  log(`   압축 ${(compressed.size / 1024).toFixed(0)}KB`)

  const bytes = new Uint8Array(await compressed.arrayBuffer())
  const b64 = bytesToBase64(bytes)
  const sess = sessionHash(b64)
  const parts = splitBase64(b64, chunkSize)
  const frames = parts.map((data, idx) => buildFrame({ idx, total: parts.length, sess, data }))
  log(`3) base64 ${(b64.length / 1024).toFixed(0)}KB → ${frames.length} 청크 (sess=${sess})`)

  log('4) 각 프레임 QR 렌더 → jsQR 디코딩 → 재조립 (전 프레임 라운드트립)')
  const recovered = new Map<number, string>()
  let decodeFail = 0
  let firstModules = 0
  const decodeStart = performance.now()
  for (const fstr of frames) {
    const c = renderFrameToCanvas(fstr, ecc)
    if (!firstModules) firstModules = (c.width / 6) - 8
    const decoded = decodeCanvas(c)
    if (decoded === null) {
      decodeFail++
      continue
    }
    const pf = parseFrame(decoded)
    if (!pf || pf.sess !== sess) {
      decodeFail++
      continue
    }
    recovered.set(pf.idx, pf.data)
  }
  const decodeMs = performance.now() - decodeStart
  log(`   QR 모듈수 ≈ ${firstModules} · 디코딩 실패 ${decodeFail}/${frames.length} · ${(decodeMs / frames.length).toFixed(1)}ms/프레임`)

  log('5) 재조립 후 원본 바이트 일치 검증')
  if (recovered.size !== parts.length) {
    log(`   ❌ 일부 청크 디코딩 실패로 재조립 불가 (${recovered.size}/${parts.length})`)
    finish(false, t0)
    return
  }
  let rb64 = ''
  for (let i = 0; i < parts.length; i++) rb64 += recovered.get(i)
  const rbytes = base64ToBytes(rb64)
  let identical = rbytes.length === bytes.length
  if (identical) for (let i = 0; i < bytes.length; i++) if (rbytes[i] !== bytes[i]) { identical = false; break }
  log(`   복원 ${(rbytes.length / 1024).toFixed(0)}KB · 바이트 동일: ${identical ? 'YES ✅' : 'NO ❌'}`)

  finish(identical, t0)
}

function finish(ok: boolean, t0: number) {
  const ms = (performance.now() - t0).toFixed(0)
  log(`\n결과: ${ok ? 'PASS ✅ — 전체 파이프라인 정상' : 'FAIL ❌'} (${ms}ms)`)
  ;(window as any).__selftest = { ok }
  out.setAttribute('data-done', ok ? 'pass' : 'fail')
}

run().catch((e) => {
  log('예외: ' + (e as Error).message)
  finish(false, performance.now())
})
