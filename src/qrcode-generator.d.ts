declare module 'qrcode-generator' {
  type ErrorCorrectionLevel = 'L' | 'M' | 'Q' | 'H'
  type Mode = 'Numeric' | 'Alphanumeric' | 'Byte' | 'Kanji'
  interface QRCode {
    addData(data: string, mode?: Mode): void
    make(): void
    getModuleCount(): number
    isDark(row: number, col: number): boolean
    createDataURL(cellSize?: number, margin?: number): string
  }
  function qrcode(typeNumber: number, errorCorrectionLevel: ErrorCorrectionLevel): QRCode
  export default qrcode
}
