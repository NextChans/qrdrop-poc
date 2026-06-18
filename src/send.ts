import imageCompression from 'browser-image-compression'
import qrcode from 'qrcode-generator'
import { buildFrame, bytesToBase64, sessionHash, splitBase64 } from './protocol'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const fileEl = $<HTMLInputElement>('file')
const startBtn = $<HTMLButtonElement>('start')
const stopBtn = $<HTMLButtonElement>('stop')
const canvas = $<HTMLCanvasElement>('qrCanvas')
const ctx = canvas.getContext('2d')!
const estimateEl = $('estimate')
const sendStatEl = $('sendStat')

// 슬라이더 ↔ 라벨 바인딩
const sliders: Array<[string, string, (v: string) => string]> = [
  ['dim', 'dimVal', (v) => v],
  ['q', 'qVal', (v) => v],
  ['chunk', 'chunkVal', (v) => v],
  ['fps', 'fpsVal', (v) => v],
]
for (const [id, valId, fmt] of sliders) {
  const el = $<HTMLInputElement>(id)
  const label = $(valId)
  const sync = () => (label.textContent = fmt(el.value))
  el.addEventListener('input', sync)
  sync()
}

let frames: string[] = []
let frameIdx = 0
let cycle = 0
let timer: number | null = null
let originalBytes = 0
let compressedBytes = 0

fileEl.addEventListener('change', () => {
  startBtn.disabled = !fileEl.files?.length
  stop()
  estimateEl.textContent = ''
})

startBtn.addEventListener('click', start)
stopBtn.addEventListener('click', stop)

async function start() {
  const file = fileEl.files?.[0]
  if (!file) return
  startBtn.disabled = true
  sendStatEl.textContent = '사진 압축 중...'

  const maxDim = Number($<HTMLInputElement>('dim').value)
  const quality = Number($<HTMLInputElement>('q').value)
  const chunkSize = Number($<HTMLInputElement>('chunk').value)

  originalBytes = file.size
  const compressed = await imageCompression(file, {
    maxWidthOrHeight: maxDim,
    initialQuality: quality,
    fileType: 'image/jpeg',
    useWebWorker: true,
  })
  compressedBytes = compressed.size

  const buf = new Uint8Array(await compressed.arrayBuffer())
  const b64 = bytesToBase64(buf)
  const sess = sessionHash(b64)
  const parts = splitBase64(b64, chunkSize)
  frames = parts.map((data, idx) => buildFrame({ idx, total: parts.length, sess, data }))

  frameIdx = 0
  cycle = 0

  const fps = Number($<HTMLInputElement>('fps').value)
  const cycleSec = (frames.length / fps).toFixed(1)
  estimateEl.innerHTML =
    `원본 ${(originalBytes / 1024).toFixed(0)}KB → 압축 ${(compressedBytes / 1024).toFixed(0)}KB · ` +
    `base64 ${(b64.length / 1024).toFixed(0)}KB<br />` +
    `<b>${frames.length} 청크</b> · 1 사이클 약 <b>${cycleSec}초</b> @ ${fps}fps · sess=${sess}`

  stopBtn.disabled = false
  loop()
}

function stop() {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  stopBtn.disabled = true
  startBtn.disabled = !fileEl.files?.length
}

function loop() {
  if (!frames.length) return
  renderQR(frames[frameIdx])
  sendStatEl.textContent = `프레임 ${frameIdx + 1}/${frames.length} · 사이클 ${cycle + 1}`

  frameIdx++
  if (frameIdx >= frames.length) {
    frameIdx = 0
    cycle++
  }
  const fps = Number($<HTMLInputElement>('fps').value)
  timer = window.setTimeout(loop, 1000 / fps)
}

function renderQR(payload: string) {
  const ecc = $<HTMLSelectElement>('ecc').value as 'L' | 'M' | 'Q' | 'H'
  let qr
  try {
    qr = qrcode(0, ecc) // typeNumber 0 = 자동 버전 선택
    qr.addData(payload, 'Byte')
    qr.make()
  } catch (e) {
    // 청크가 너무 커서 version 40도 초과 → 사용자에게 청크 줄이라고 안내
    sendStatEl.textContent = `⚠️ 청크가 너무 큽니다. 청크 크기를 줄이세요. (${(e as Error).message})`
    stop()
    return
  }

  const count = qr.getModuleCount()
  const margin = 4 // QR 규격 quiet zone(4모듈) — 카메라 인식 필수
  const total = count + margin * 2

  // 디바이스 픽셀 비율 반영해 선명하게, 한 변 ~520px 목표
  const dpr = window.devicePixelRatio || 1
  const cssSize = Math.min(520, window.innerWidth - 64)
  const cell = Math.max(1, Math.floor((cssSize * dpr) / total))
  const px = cell * total

  canvas.width = px
  canvas.height = px
  canvas.style.width = cssSize + 'px'
  canvas.style.height = cssSize + 'px'

  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, px, px)
  ctx.fillStyle = '#000'
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) {
        ctx.fillRect((c + margin) * cell, (r + margin) * cell, cell, cell)
      }
    }
  }
}
