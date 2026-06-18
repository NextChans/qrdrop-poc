// QRDrop v1 프레임 프로토콜
//
// 프레임 포맷(ASCII 텍스트, QR byte mode):
//   QD1:<idx>:<total>:<sess>:<base64chunk>
//
// - base64 문자 집합(A-Z a-z 0-9 + / =)에는 콜론(:)이 없으므로 콜론 구분이 안전하다.
// - 모든 프레임이 total/sess 메타를 포함 → 수신자가 시퀀스 중간에 합류 가능.
// - sess: 전체 base64에 대한 djb2 해시(base36). 새 이미지 시작/다른 전송 혼입 감지용.

export const MAGIC = 'QD1'

export interface Frame {
  idx: number
  total: number
  sess: string
  data: string // base64 조각
}

// djb2 — 빠르고 충돌 충분히 낮은 비암호화 해시(세션 식별용, 보안 목적 아님)
export function sessionHash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(36)
}

export function buildFrame(f: Frame): string {
  return `${MAGIC}:${f.idx}:${f.total}:${f.sess}:${f.data}`
}

export function parseFrame(raw: string): Frame | null {
  if (!raw.startsWith(MAGIC + ':')) return null
  // 앞쪽 4개 필드만 분리하고 데이터는 통째로(콜론 없음 보장)
  const parts = raw.split(':')
  if (parts.length !== 5) return null
  const idx = Number(parts[1])
  const total = Number(parts[2])
  const sess = parts[3]
  const data = parts[4]
  if (!Number.isInteger(idx) || !Number.isInteger(total) || total <= 0) return null
  if (idx < 0 || idx >= total) return null
  if (!sess || !data) return null
  return { idx, total, sess, data }
}

// ArrayBuffer → base64 (청크 단위 변환, 큰 입력에서 스택오버플로 방지)
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)))
  }
  return btoa(binary)
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

// base64 문자열을 고정 길이 조각으로 분할
export function splitBase64(b64: string, chunkSize: number): string[] {
  const chunks: string[] = []
  for (let i = 0; i < b64.length; i += chunkSize) {
    chunks.push(b64.slice(i, i + chunkSize))
  }
  return chunks
}
