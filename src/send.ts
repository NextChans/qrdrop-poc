import imageCompression from 'browser-image-compression'
import qrcode from 'qrcode-generator'
import { FountainEncoder, FLAG_ENCRYPTED } from './fountain'
import { encryptBytes } from './crypto'

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

let encoder: FountainEncoder | null = null
let seed = 0
let timer: number | null = null
let wakeLock: WakeLockSentinel | null = null

fileEl.addEventListener('change', () => {
  startBtn.disabled = !fileEl.files?.length
  stop()
  estimateEl.textContent = ''
})

startBtn.addEventListener('click', start)
stopBtn.addEventListener('click', stop)

// 암호화 토글 ↔ 비밀번호 입력칸 표시
const encToggle = $<HTMLInputElement>('encToggle')
const sendPw = $<HTMLInputElement>('sendPw')
encToggle.addEventListener('change', () => {
  $('pwRow').style.display = encToggle.checked ? 'block' : 'none'
})

// 송신 중 화면 자동 꺼짐 방지(Wake Lock). 미지원 브라우저는 무시.
async function requestWakeLock() {
  try {
    wakeLock = (await navigator.wakeLock?.request('screen')) ?? null
  } catch {
    wakeLock = null
  }
}
function releaseWakeLock() {
  wakeLock?.release().catch(() => {})
  wakeLock = null
}
// 탭이 다시 보이면 wake lock 재획득(브라우저가 숨김 시 해제하므로)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && timer !== null && !wakeLock) requestWakeLock()
})

async function start() {
  const file = fileEl.files?.[0]
  if (!file) return
  startBtn.disabled = true
  sendStatEl.textContent = '사진 압축 중...'

  const maxDim = Number($<HTMLInputElement>('dim').value)
  const quality = Number($<HTMLInputElement>('q').value)
  // 청크 슬라이더 = 프레임당 raw 바이트(=fountain 블록 크기). base64를 안 쓰므로 바이트가 곧 페이로드다.
  const blockSize = Math.max(16, Number($<HTMLInputElement>('chunk').value))

  const originalBytes = file.size
  const compressed = await imageCompression(file, {
    maxWidthOrHeight: maxDim,
    initialQuality: quality,
    fileType: 'image/jpeg',
    useWebWorker: true,
  })
  const compressedBytes = compressed.size

  let payload: Uint8Array = new Uint8Array(await compressed.arrayBuffer())
  let flags = 0
  if (encToggle.checked) {
    const pw = sendPw.value
    if (!pw) {
      sendStatEl.textContent = '🔒 비밀번호를 입력하세요.'
      startBtn.disabled = false
      return
    }
    sendStatEl.textContent = '암호화 중...'
    try {
      payload = await encryptBytes(pw, payload)
      flags = FLAG_ENCRYPTED
    } catch (e) {
      sendStatEl.textContent = '암호화 실패: ' + (e as Error).message + ' (HTTPS 환경인지 확인하세요)'
      startBtn.disabled = false
      return
    }
  }

  encoder = new FountainEncoder(payload, blockSize, flags)
  seed = 0

  const fps = Number($<HTMLInputElement>('fps').value)
  const passSec = (encoder.k / fps).toFixed(1)
  const lock = flags ? '🔒 ' : ''
  estimateEl.innerHTML =
    `${lock}원본 ${(originalBytes / 1024).toFixed(0)}KB → 압축 ${(compressedBytes / 1024).toFixed(0)}KB` +
    `${flags ? ` → 암호화 ${(payload.length / 1024).toFixed(0)}KB` : ''} · 블록 ${blockSize}B<br />` +
    `<b>${encoder.k} 블록</b> · 1패스(=systematic 전체) 약 <b>${passSec}초</b> @ ${fps}fps · ` +
    `sess=${encoder.sess}<br />` +
    `<span class="muted">fountain: 누락은 이후 여분 심볼로 재시청 없이 복구됩니다.</span>`

  stopBtn.disabled = false
  requestWakeLock()
  loop()
}

function stop() {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  releaseWakeLock()
  stopBtn.disabled = true
  startBtn.disabled = !fileEl.files?.length
}

function loop() {
  if (!encoder) return
  const frame = encoder.frame(seed)
  if (!renderQR(frame)) return // QR 생성 실패 시 중단(청크 줄이라 안내됨)

  const pass = Math.floor(seed / encoder.k) + 1
  const posInPass = (seed % encoder.k) + 1
  sendStatEl.textContent =
    seed < encoder.k
      ? `systematic 블록 ${posInPass}/${encoder.k} · seed ${seed}`
      : `여분 심볼 송출 중 · 패스 ${pass} · seed ${seed}`

  seed++
  const fps = Number($<HTMLInputElement>('fps').value)
  timer = window.setTimeout(loop, 1000 / fps)
}

function renderQR(payload: string): boolean {
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
    return false
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
  return true
}
