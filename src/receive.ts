import jsQR from 'jsqr'
import { base64ToBytes, parseFrame } from './protocol'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const video = $<HTMLVideoElement>('video')
const canvas = $<HTMLCanvasElement>('decodeCanvas')
const ctx = canvas.getContext('2d', { willReadFrequently: true })!
const startBtn = $<HTMLButtonElement>('startCam')
const stopBtn = $<HTMLButtonElement>('stopCam')
const camErr = $('camErr')

const recvCount = $('recvCount')
const recvTotal = $('recvTotal')
const recvPct = $('recvPct')
const recvFps = $('recvFps')
const bar = $('bar')
const missingEl = $('missing')
const grid = $('grid')
const resultBox = $('result')
const resultImg = $<HTMLImageElement>('resultImg')
const download = $<HTMLAnchorElement>('download')
const recvSummary = $('recvSummary')

let stream: MediaStream | null = null
let running = false

// 현재 수신 세션 상태
let sess: string | null = null
let total = 0
let chunks = new Map<number, string>()
let startTime = 0
let decodeCountWindow = 0
let lastFpsTick = 0

startBtn.addEventListener('click', startCam)
stopBtn.addEventListener('click', stopCam)

async function startCam() {
  camErr.textContent = ''
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    })
  } catch (e) {
    camErr.textContent =
      '카메라 접근 실패: ' + (e as Error).message +
      ' — HTTPS(또는 localhost)에서 접근했는지, 권한을 허용했는지 확인하세요.'
    return
  }
  video.srcObject = stream
  await video.play()
  running = true
  startBtn.disabled = true
  stopBtn.disabled = false
  resetSession(null)
  startTime = 0
  requestAnimationFrame(scan)
}

function stopCam() {
  running = false
  stream?.getTracks().forEach((t) => t.stop())
  stream = null
  startBtn.disabled = false
  stopBtn.disabled = true
}

function resetSession(newSess: string | null) {
  sess = newSess
  total = 0
  chunks = new Map()
  startTime = 0
  recvTotal.textContent = '?'
  buildGrid(0)
  updateProgress()
  resultBox.style.display = 'none'
}

function scan(ts: number) {
  if (!running) return
  if (video.readyState === video.HAVE_ENOUGH_DATA) {
    // 디코드 성능을 위해 가로 ~640px 기준으로 다운스케일
    const vw = video.videoWidth
    const vh = video.videoHeight
    if (vw && vh) {
      const targetW = Math.min(640, vw)
      const scale = targetW / vw
      const w = Math.round(vw * scale)
      const h = Math.round(vh * scale)
      if (canvas.width !== w) {
        canvas.width = w
        canvas.height = h
      }
      ctx.drawImage(video, 0, 0, w, h)
      const img = ctx.getImageData(0, 0, w, h)
      const code = jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' })
      if (code && code.data) {
        handlePayload(code.data)
      }
    }
  }

  // 디코드/초 측정
  decodeCountWindow++
  if (ts - lastFpsTick >= 1000) {
    recvFps.textContent = String(decodeCountWindow)
    decodeCountWindow = 0
    lastFpsTick = ts
  }

  requestAnimationFrame(scan)
}

function handlePayload(raw: string) {
  const frame = parseFrame(raw)
  if (!frame) return

  // 새 세션(다른 사진) 감지 시 리셋
  if (sess === null) {
    sess = frame.sess
    total = frame.total
    recvTotal.textContent = String(total)
    buildGrid(total)
    startTime = performance.now()
  } else if (frame.sess !== sess) {
    resetSession(frame.sess)
    total = frame.total
    recvTotal.textContent = String(total)
    buildGrid(total)
    startTime = performance.now()
  }

  if (chunks.has(frame.idx)) return // dedup
  chunks.set(frame.idx, frame.data)
  markCell(frame.idx)
  updateProgress()

  if (chunks.size === total) {
    reconstruct()
  }
}

function buildGrid(n: number) {
  grid.innerHTML = ''
  if (!n) return
  const cols = Math.ceil(Math.sqrt(n) * 1.6)
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`
  for (let i = 0; i < n; i++) {
    const cell = document.createElement('i')
    cell.dataset.idx = String(i)
    grid.appendChild(cell)
  }
}

function markCell(idx: number) {
  const cell = grid.children[idx] as HTMLElement | undefined
  cell?.classList.add('have')
}

function updateProgress() {
  const got = chunks.size
  recvCount.textContent = String(got)
  const pct = total ? Math.round((got / total) * 100) : 0
  recvPct.textContent = pct + '%'
  bar.style.width = pct + '%'

  if (total && got < total) {
    const missing: number[] = []
    for (let i = 0; i < total; i++) if (!chunks.has(i)) missing.push(i)
    const preview = missing.slice(0, 30).join(', ')
    missingEl.textContent =
      `누락 ${missing.length}개` + (missing.length ? `: ${preview}${missing.length > 30 ? ' …' : ''}` : '')
  } else {
    missingEl.textContent = ''
  }
}

function reconstruct() {
  // idx 순서대로 base64 이어붙이기
  let b64 = ''
  for (let i = 0; i < total; i++) {
    const part = chunks.get(i)
    if (part === undefined) return // 안전장치(이론상 도달 안 함)
    b64 += part
  }
  let blob: Blob
  try {
    const bytes = base64ToBytes(b64)
    blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'image/jpeg' })
  } catch (e) {
    missingEl.textContent = '복원 실패(base64 손상): ' + (e as Error).message
    return
  }

  const url = URL.createObjectURL(blob)
  resultImg.src = url
  download.href = url
  resultBox.style.display = 'block'

  const elapsed = startTime ? (performance.now() - startTime) / 1000 : 0
  recvSummary.textContent =
    `${total}청크 · ${(blob.size / 1024).toFixed(0)}KB · 첫 청크~완료 ${elapsed.toFixed(1)}초`

  running = false // 완료 시 스캔 정지(원하면 다시 시작)
  stopCam()
}
