/**
 * QR rendering for the wireless-pairing sheet.
 *
 * The encoding itself is delegated to `qrcode-generator` (Kazuhiko Arase's well-known
 * implementation, zero dependencies). It is battle-tested against real scanners, which a
 * hand-rolled encoder is not — the first attempt at rolling our own produced a matrix whose
 * structure looked right but whose codeword stream did not survive a decode round-trip.
 *
 * This module only owns the two things the panel needs:
 *   - the ADB pairing payload format, and
 *   - turning the library's module matrix into an inline SVG (no canvas, no PNG step, so
 *     the browser half stays build-free).
 */
import qrcode from 'qrcode-generator'

/**
 * Build the ADB wireless-pairing payload that Android's QR scanner understands.
 *
 * Android reuses the Wi-Fi QR envelope with ADB-specific meanings (see AOSP
 * `AdbQrCode.java`): `T:ADB` marks a pairing payload, `S:` is the mDNS service instance
 * name the phone should publish, and `P:` is the temporary pairing secret. After scanning,
 * the phone advertises `_adb-tls-pairing._tcp` under exactly that `S:` name, which is what
 * lets the host correlate the announcement with the code it just drew.
 *
 * `studio-` is the convention Android Studio uses; the parser keys off `T:ADB`, not the
 * prefix, but keeping the same shape avoids surprises on OEM builds.
 *
 * @param {{ serviceName: string, password: string }} creds
 */
export function buildPairingPayload(creds) {
  const service = String(creds.serviceName ?? '')
  const password = String(creds.password ?? '')
  if (service === '' || password === '') throw new Error('serviceName and password are required')
  // Escape the characters the Wi-Fi envelope treats specially; the values we generate are
  // alphanumeric, but a caller-supplied name must not be able to break the structure.
  const esc = (v) => v.replace(/([\\;,":])/g, '\\$1')
  return `WIFI:T:ADB;S:${esc(service)};P:${esc(password)};;`
}

/** Random alphanumeric string from a cryptographic source. */
function randomToken(length, alphabet) {
  const out = []
  const bytes = new Uint8Array(length)
  // globalThis.crypto exists in both the browser half and modern Node.
  globalThis.crypto.getRandomValues(bytes)
  for (let i = 0; i < length; i++) out.push(alphabet[bytes[i] % alphabet.length])
  return out.join('')
}

/** Fresh single-use pairing credentials (service name + secret), as Android Studio does. */
export function makePairingCredentials() {
  const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  return {
    serviceName: 'studio-' + randomToken(10, ALNUM),
    password: randomToken(12, ALNUM),
  }
}

/**
 * Encode `text` into a module matrix.
 * @returns {{ size: number, isDark: (r: number, c: number) => boolean }}
 */
export function encodeQr(text) {
  // Type 0 = let the library pick the smallest version; 'M' matches Android Studio's
  // pairing code (good recovery without inflating the module count).
  const qr = qrcode(0, 'M')
  qr.addData(text, 'Byte')
  qr.make()
  const size = qr.getModuleCount()
  return {
    size,
    isDark: (r, c) => qr.isDark(r, c),
    modules: Array.from({ length: size }, (_, r) =>
      Array.from({ length: size }, (_, c) => (qr.isDark(r, c) ? 1 : 0))),
  }
}

/**
 * Render `text` as a standalone SVG string with a 4-module quiet zone.
 *
 * One rect per dark module keeps the markup trivially correct; the payloads here are ~50
 * bytes (a version 4 symbol, 33x33), so the element count is irrelevant.
 */
export function qrToSvg(text, { scale = 6, margin = 4, dark = '#000', light = '#fff' } = {}) {
  const { size, isDark } = encodeQr(text)
  const dim = (size + margin * 2) * scale
  const rects = []
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (isDark(r, c)) {
        rects.push(`<rect x="${(c + margin) * scale}" y="${(r + margin) * scale}" width="${scale}" height="${scale}"/>`)
      }
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" `
    + `viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" role="img" aria-label="配对二维码">`
    + `<rect width="${dim}" height="${dim}" fill="${light}"/>`
    + `<g fill="${dark}">${rects.join('')}</g></svg>`
  return { svg, size, dim }
}
