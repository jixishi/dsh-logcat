/**
 * Refresh lib/scrcpy-server.js from the official scrcpy release.
 *
 * The server is vendored (embedded as base64) rather than downloaded at runtime, so the
 * plugin works offline and cannot break when GitHub is unreachable. Re-run this only when
 * bumping SCRCPY_VERSION — the client parses that release's protocol, and scrcpy makes no
 * compatibility promise between versions.
 *
 * Usage: node tools/scrcpy-server/fetch-server.mjs [version]
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const version = process.argv[2] ?? '3.3.1'
const url = `https://github.com/Genymobile/scrcpy/releases/download/v${version}/scrcpy-server-v${version}`

console.log(`fetching ${url}`)
const response = await fetch(url, { redirect: 'follow' })
if (!response.ok) {
  console.error(`download failed: HTTP ${response.status}`)
  process.exit(1)
}
const bytes = Buffer.from(await response.arrayBuffer())
// Sanity-check the ZIP magic: a proxy error page would otherwise be embedded silently.
if (bytes.length < 10_000 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
  console.error(`not a jar (${bytes.length} bytes, magic ${bytes.subarray(0, 2).toString('hex')})`)
  process.exit(1)
}

const banner = [
  '// Auto-generated - do not edit by hand.',
  `// Official scrcpy-server v${version} (Genymobile/scrcpy, Apache-2.0), embedded so the`,
  '// plugin ships a working device encoder without requiring scrcpy on the host.',
  '// The server holds MediaCodec itself: no screenrecord 180s limit, no idle-frame drop,',
  '// and rotation resets the codec instead of the adb tunnel.',
  `// Source: https://github.com/Genymobile/scrcpy/releases/tag/v${version}`,
  '// Re-fetch with: node tools/encoder/fetch-server.mjs',
].join('\n')

const out = `${banner}\nexport const SCRCPY_SERVER_BASE64 = ${JSON.stringify(bytes.toString('base64'))}\nexport const SCRCPY_SERVER_VERSION = ${JSON.stringify(version)}\n`
writeFileSync(new URL('../../lib/scrcpy-server.js', import.meta.url), out, 'utf8')
console.log(`wrote lib/scrcpy-server.js (${bytes.length} jar bytes)`)
