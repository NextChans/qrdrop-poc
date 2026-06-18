import jsQR from 'jsqr'
import { FountainDecoder, parseSymbolFrame } from './fountain'

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
let decoder: FountainDecoder | null = null
let sess: string | null = null
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
  resetSession()
  requestAnimationFrame(scan)
}

function stopCam() {
  running = false
  stream?.getTracks().forEach((t) => t.stop())
  stream = null
  startBtn.disabled = false
  stopBtn.disabled = true
}

function resetSession() {
  decoder = null
  sess = null
  startTime = 0
  recvTotal.textContent = '?'
  recvCount.textContent = '0'
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
  const frame = parseSymbolFrame(raw)
  if (!frame) return

  // 새 세션(다른 사진)이거나 첫 프레임이면 디코더 생성
  if (!decoder || frame.sess !== sess) {
    sess = frame.sess
    decoder = new FountainDecoder(frame.k, frame.len, frame.sess, frame.data.length)
    recvTotal.textContent = String(frame.k)
    buildGrid(frame.k)
    startTime = performance.now()
  }

  const gotNew = decoder.addSymbol(frame.seed, frame.data)
  if (gotNew) refreshGrid()
  updateProgress()

  if (decoder.done) reconstruct()
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

// fountain은 블록을 순서와 무관하게 복원하므로, 갱신 시 전체 복원 상태를 다시 칠한다.
function refreshGrid() {
  if (!decoder) return
  for (let i = 0; i < decoder.k; i++) {
    const cell = grid.children[i] as HTMLElement | undefined
    if (cell) cell.classList.toggle('have', decoder.isRecovered(i))
  }
}

function updateProgress() {
  if (!decoder) {
    recvCount.textContent = '0'
    recvPct.textContent = '0%'
    bar.style.width = '0%'
    missingEl.textContent = ''
    return
  }
  const got = decoder.recoveredCount
  const total = decoder.k
  recvCount.textContent = String(got)
  const pct = total ? Math.round((got / total) * 100) : 0
  recvPct.textContent = pct + '%'
  bar.style.width = pct + '%'

  if (got < total) {
    const overhead = got ? (decoder.symbolsSeen / total).toFixed(2) : '—'
    missingEl.textContent = `복원 ${got}/${total} 블록 · 수신 심볼 ${decoder.symbolsSeen}개 (오버헤드 ${overhead}×)`
  } else {
    missingEl.textContent = ''
  }
}

function reconstruct() {
  if (!decoder) return
  const bytes = decoder.result()
  if (!bytes) return
  let blob: Blob
  try {
    blob = new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }) // subarray → 타이트 복사
  } catch (e) {
    missingEl.textContent = '복원 실패: ' + (e as Error).message
    return
  }

  const url = URL.createObjectURL(blob)
  resultImg.src = url
  download.href = url
  resultBox.style.display = 'block'

  const elapsed = startTime ? (performance.now() - startTime) / 1000 : 0
  const overhead = (decoder.symbolsSeen / decoder.k).toFixed(2)
  recvSummary.textContent =
    `${decoder.k}블록 · ${(blob.size / 1024).toFixed(0)}KB · 첫 심볼~완료 ${elapsed.toFixed(1)}초 · ` +
    `수신 심볼 ${decoder.symbolsSeen}개 (오버헤드 ${overhead}×)`

  running = false // 완료 시 스캔 정지(원하면 다시 시작)
  stopCam()
}
