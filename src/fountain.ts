// QRDrop v2 — LT Fountain code + raw 바이너리 프레이밍
//
// v1의 단순 인덱스 반복 loop는 tail 비효율이 컸다: 한 사이클에서 막판 몇 청크를
// 못 받으면 전체 시퀀스를 처음부터 다시 시청해야 했다. 두 폰 실측(README 검증 4)에서
// 전송시간의 ~93%가 여기서 낭비됐고, 병목이 QR 기술이 아니라 재전송 전략임이 확정됐다.
//
// v2는 LT(Luby Transform) fountain code로 이를 해결한다. 송신은 끝없이 "심볼"을 찍어내고,
// 수신은 순서·중복과 무관하게 "받은 심볼 수 ≈ 블록 수 + 소량 오버헤드"만 모이면 복원한다.
//
// 프레이밍은 raw 바이너리(QR byte mode)다. v1/초기v2의 base64는 33% 오버헤드가 있었으나,
// qrcode-generator는 byte mode에서 문자열을 charCodeAt(i)&0xff 로 인코딩하고 jsQR은
// binaryData(number[])로 원시 바이트를 돌려주므로, 바이트를 latin1 문자열로 실어 보내면
// base64 없이 임의 바이트(0x00·0xFF·구분자 포함)를 그대로 전송/복원할 수 있다.
//
// 바이너리 프레임 레이아웃 (헤더 18B, big-endian):
//   off 0  : magic 'Q'(0x51) 'D'(0x44) '4'(0x34)   3B
//   off 3  : flags  uint8    — bit0 = 암호화됨(AES-GCM). 나머지 예약
//   off 4  : seed   uint32   — 심볼 식별자. seed<k 면 systematic(블록 seed 단독), 아니면 LT 랜덤
//   off 8  : k      uint16   — 소스 블록 개수
//   off 10 : len    uint32   — 페이로드 바이트 길이(마지막 블록 zero-pad 트리밍용)
//   off 14 : sess   uint32   — 페이로드 djb2 해시(새 이미지/다른 전송 감지)
//   off 18 : payload         — 블록 크기 B 바이트인 심볼(raw)
//
// systematic 접두(seed 0..k-1) 덕분에 손실 없는 깨끗한 1패스에서는 v1처럼 빠르게 모든
// 블록을 받고, 그 뒤 LT 심볼(seed>=k)이 누락분을 재시청 없이 메운다 — 두 방식의 장점 결합.

export const MAGIC = [0x51, 0x44, 0x34] // 'Q','D','4'
export const HEADER_BYTES = 18
export const FLAG_ENCRYPTED = 1 // flags bit0

// 원본 바이트 djb2 해시(uint32). 세션 식별용(비암호화).
function djb2Bytes(bytes: Uint8Array): number {
  let h = 5381
  for (let i = 0; i < bytes.length; i++) h = ((h << 5) + h + bytes[i]) | 0
  return h >>> 0
}

// Uint8Array → latin1 문자열(바이트당 1문자). qrcode-generator byte mode가 charCodeAt&0xff 로
// 그대로 인코딩하므로 base64 없이 raw 바이트를 전송할 수 있다. 큰 입력은 청크로 나눠 스택 보호.
function bytesToLatin1(bytes: Uint8Array): string {
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)))
  }
  return s
}

// 32-bit 시드 PRNG (mulberry32). 인코더/디코더가 같은 seed로 동일 난수열을 생성한다.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Robust Soliton 분포의 누적분포(CDF)를 k로부터 결정적으로 계산한다.
// 인코더/디코더가 같은 k로 동일 CDF를 만들어 "같은 seed → 같은 degree"를 보장한다.
export function degreeCDF(k: number, c = 0.05, delta = 0.5): number[] {
  if (k <= 1) return [0, 1] // degree는 항상 1

  const rho = new Array<number>(k + 1).fill(0)
  rho[1] = 1 / k
  for (let d = 2; d <= k; d++) rho[d] = 1 / (d * (d - 1))

  const R = c * Math.log(k / delta) * Math.sqrt(k)
  const kR = Math.floor(k / R)
  const tau = new Array<number>(k + 1).fill(0)
  for (let d = 1; d <= k; d++) {
    if (d < kR) tau[d] = R / (d * k)
    else if (d === kR) tau[d] = (R * Math.log(R / delta)) / k
    else tau[d] = 0
  }

  let beta = 0
  for (let d = 1; d <= k; d++) beta += rho[d] + tau[d]

  const cdf = new Array<number>(k + 1).fill(0)
  let acc = 0
  for (let d = 1; d <= k; d++) {
    acc += (rho[d] + tau[d]) / beta
    cdf[d] = acc
  }
  cdf[k] = 1 // 부동소수 누적 오차 보정
  return cdf
}

function sampleDegree(rng: () => number, cdf: number[], k: number): number {
  const x = rng()
  for (let d = 1; d <= k; d++) if (x <= cdf[d]) return d
  return k
}

// seed로부터 이 심볼이 XOR 결합하는 소스 블록 인덱스 집합을 만든다.
// seed < k: systematic(블록 seed 단독). seed >= k: LT 랜덤 결합.
export function symbolBlocks(seed: number, k: number, cdf: number[]): number[] {
  if (seed < k) return [seed]
  const rng = mulberry32(seed)
  const d = Math.min(sampleDegree(rng, cdf, k), k)
  const set = new Set<number>()
  while (set.size < d) set.add(Math.floor(rng() * k))
  return [...set]
}

function xorInto(dst: Uint8Array, src: Uint8Array): void {
  for (let i = 0; i < dst.length; i++) dst[i] ^= src[i]
}

export class FountainEncoder {
  readonly k: number
  readonly blockSize: number
  readonly len: number
  readonly sessInt: number
  readonly sess: string // 표시용(base36)
  readonly flags: number
  private blocks: Uint8Array[] = []
  private cdf: number[]

  constructor(bytes: Uint8Array, blockSize: number, flags = 0) {
    this.len = bytes.length
    this.blockSize = blockSize
    this.flags = flags & 0xff
    this.k = Math.max(1, Math.ceil(bytes.length / blockSize))
    this.sessInt = djb2Bytes(bytes)
    this.sess = this.sessInt.toString(36)
    this.cdf = degreeCDF(this.k)
    for (let i = 0; i < this.k; i++) {
      const b = new Uint8Array(blockSize) // 마지막 블록은 0으로 패딩됨
      b.set(bytes.subarray(i * blockSize, Math.min((i + 1) * blockSize, bytes.length)))
      this.blocks.push(b)
    }
  }

  symbol(seed: number): Uint8Array {
    const out = new Uint8Array(this.blockSize)
    for (const i of symbolBlocks(seed, this.k, this.cdf)) xorInto(out, this.blocks[i])
    return out
  }

  // 바이너리 프레임(헤더 18B + 심볼)을 latin1 문자열로 반환 → qrcode-generator 'Byte' 모드에 그대로.
  frame(seed: number): string {
    const buf = new Uint8Array(HEADER_BYTES + this.blockSize)
    const dv = new DataView(buf.buffer)
    buf[0] = MAGIC[0]
    buf[1] = MAGIC[1]
    buf[2] = MAGIC[2]
    buf[3] = this.flags
    dv.setUint32(4, seed >>> 0)
    dv.setUint16(8, this.k)
    dv.setUint32(10, this.len)
    dv.setUint32(14, this.sessInt)
    buf.set(this.symbol(seed), HEADER_BYTES)
    return bytesToLatin1(buf)
  }
}

export interface ParsedSymbol {
  seed: number
  k: number
  len: number
  sess: string
  flags: number
  data: Uint8Array
}

// jsQR의 binaryData(number[]) 또는 Uint8Array를 바이너리 프레임으로 파싱.
export function parseFrame(bin: number[] | Uint8Array): ParsedSymbol | null {
  const b = bin instanceof Uint8Array ? bin : Uint8Array.from(bin)
  if (b.length <= HEADER_BYTES) return null
  if (b[0] !== MAGIC[0] || b[1] !== MAGIC[1] || b[2] !== MAGIC[2]) return null
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const flags = b[3]
  const seed = dv.getUint32(4)
  const k = dv.getUint16(8)
  const len = dv.getUint32(10)
  const sessInt = dv.getUint32(14)
  if (k <= 0 || len <= 0) return null
  const data = b.slice(HEADER_BYTES)
  return { seed, k, len, sess: sessInt.toString(36), flags, data }
}

// LT peeling(belief-propagation) 디코더.
export class FountainDecoder {
  readonly k: number
  readonly len: number
  readonly sess: string
  readonly blockSize: number
  private cdf: number[]
  private recovered: (Uint8Array | null)[]
  recoveredCount = 0
  symbolsSeen = 0
  private pending: { blocks: Set<number>; data: Uint8Array }[] = []

  constructor(k: number, len: number, sess: string, blockSize: number) {
    this.k = k
    this.len = len
    this.sess = sess
    this.blockSize = blockSize
    this.cdf = degreeCDF(k)
    this.recovered = new Array(k).fill(null)
  }

  get done(): boolean {
    return this.recoveredCount === this.k
  }

  isRecovered(idx: number): boolean {
    return this.recovered[idx] !== null
  }

  // 심볼 1개를 추가하고 peeling을 시도한다. 새 블록을 복원했으면 true.
  addSymbol(seed: number, data: Uint8Array): boolean {
    this.symbolsSeen++
    if (this.done) return false
    const d = data.slice() // 원본 보존을 위해 복사
    const blocks = new Set<number>()
    for (const i of symbolBlocks(seed, this.k, this.cdf)) {
      if (this.recovered[i]) xorInto(d, this.recovered[i]!)
      else blocks.add(i)
    }
    if (blocks.size === 0) return false // 이미 모두 아는 정보(중복)
    this.pending.push({ blocks, data: d })
    const before = this.recoveredCount
    this.peel()
    return this.recoveredCount > before
  }

  private peel(): void {
    let progress = true
    while (progress) {
      progress = false
      for (let s = 0; s < this.pending.length; s++) {
        const sym = this.pending[s]
        if (sym.blocks.size !== 1) continue
        const idx = sym.blocks.values().next().value as number
        this.pending.splice(s, 1)
        if (this.recovered[idx]) {
          progress = true // 이미 복원된 블록 → 버리고 계속
          break
        }
        this.recovered[idx] = sym.data
        this.recoveredCount++
        // 이 블록을 참조하는 다른 심볼에서 소거(degree 감소)
        for (const other of this.pending) {
          if (other.blocks.has(idx)) {
            other.blocks.delete(idx)
            xorInto(other.data, sym.data)
          }
        }
        progress = true
        break
      }
    }
  }

  result(): Uint8Array | null {
    if (!this.done) return null
    const out = new Uint8Array(this.k * this.blockSize)
    for (let i = 0; i < this.k; i++) out.set(this.recovered[i]!, i * this.blockSize)
    return out.subarray(0, this.len)
  }
}
