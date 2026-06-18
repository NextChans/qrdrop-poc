// QRDrop v2 — LT Fountain code
//
// v1의 단순 인덱스 반복 loop는 tail 비효율이 컸다: 한 사이클에서 막판 몇 청크를
// 못 받으면 전체 시퀀스를 처음부터 다시 시청해야 했다. 두 폰 실측(README 검증 4)에서
// 전송시간의 ~93%가 여기서 낭비됐고, 병목이 QR 기술이 아니라 재전송 전략임이 확정됐다.
//
// v2는 LT(Luby Transform) fountain code로 이를 해결한다. 송신은 끝없이 "심볼"을 찍어내고,
// 수신은 순서·중복과 무관하게 "받은 심볼 수 ≈ 블록 수 + 소량 오버헤드"만 모이면 복원한다.
// 누락 회복에 사이클 재시청이 필요 없다.
//
// 프레임 포맷(ASCII, QR byte mode):
//   QD2:<seed>:<k>:<len>:<sess>:<base64symbol>
//     seed : 심볼 식별자(base36). 인코더/디코더가 이 시드로 결합 블록 집합을 동일하게 재생성.
//            seed < k 면 systematic(블록 seed 단독, degree 1), seed >= k 면 LT 랜덤 결합.
//     k    : 소스 블록 개수
//     len  : 원본 바이트 길이(마지막 블록 zero-pad 트리밍용)
//     sess : 전체 데이터 djb2 해시(base36) — 새 이미지/다른 전송 혼입 감지
//     base64symbol : 블록 크기 B 바이트인 한 심볼을 base64 인코딩
//
// systematic 접두(seed 0..k-1) 덕분에 손실 없는 깨끗한 1패스에서는 v1처럼 빠르게 모든
// 블록을 받고, 그 뒤 LT 심볼(seed>=k)이 누락분을 재시청 없이 메운다 — 두 방식의 장점 결합.

import { base64ToBytes, bytesToBase64, sessionHash } from './protocol'

export const MAGIC2 = 'QD2'

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
  readonly sess: string
  private blocks: Uint8Array[] = []
  private cdf: number[]

  constructor(bytes: Uint8Array, blockSize: number) {
    this.len = bytes.length
    this.blockSize = blockSize
    this.k = Math.max(1, Math.ceil(bytes.length / blockSize))
    this.sess = sessionHash(bytesToBase64(bytes))
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

  frame(seed: number): string {
    const data = bytesToBase64(this.symbol(seed))
    return `${MAGIC2}:${seed.toString(36)}:${this.k}:${this.len}:${this.sess}:${data}`
  }
}

export interface ParsedSymbol {
  seed: number
  k: number
  len: number
  sess: string
  data: Uint8Array
}

export function parseSymbolFrame(raw: string): ParsedSymbol | null {
  if (!raw.startsWith(MAGIC2 + ':')) return null
  const p = raw.split(':')
  if (p.length !== 6) return null
  const seed = parseInt(p[1], 36)
  const k = Number(p[2])
  const len = Number(p[3])
  const sess = p[4]
  if (!Number.isInteger(seed) || seed < 0) return null
  if (!Number.isInteger(k) || k <= 0) return null
  if (!Number.isInteger(len) || len <= 0) return null
  if (!sess || !p[5]) return null
  let data: Uint8Array
  try {
    data = base64ToBytes(p[5])
  } catch {
    return null
  }
  return { seed, k, len, sess, data }
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
