/**
 * Build the device-side MediaCodec encoder into lib/encoder-jar.js.
 *
 * This replaces the `screenrecord --output-format=h264` pipe: holding MediaCodec
 * directly removes the recorder's 180 s limit and its idle-frame drop, and lets a
 * rotation reset the codec instead of the whole adb tunnel.
 *
 * Toolchain: a JDK (javac), an android.jar for compilation, and d8 (R8) for dexing.
 * None of these have to be installed system-wide — ANDROID_JAR / D8_JAR may point at
 * standalone copies, which is how this machine runs it (no Android SDK is present).
 *
 * Usage:
 *   node tools/encoder/build.mjs
 *   $env:ANDROID_JAR='...android.jar'; $env:D8_JAR='...r8.jar'; node tools/encoder/build.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const source = join(root, 'tools', 'encoder', 'Encoder.java')
const output = join(root, 'lib', 'encoder-jar.js')
const work = join(root, 'tmp-encoder-build')

/** Newest directory matching the pattern, or null. */
const newest = (dir, pattern) => {
  if (!existsSync(dir)) return null
  const names = readdirSync(dir).filter((n) => pattern.test(n)).sort().reverse()
  return names[0] ?? null
}

// --- android.jar -----------------------------------------------------------
let androidJar = process.env.ANDROID_JAR ?? ''
if (androidJar === '' || !existsSync(androidJar)) {
  const sdkRoots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT,
    join(homedir(), 'AppData', 'Local', 'Android', 'Sdk')].filter(Boolean)
  const sdk = sdkRoots.find((dir) => existsSync(join(dir, 'platforms')))
  const platform = sdk === undefined ? null : newest(join(sdk, 'platforms'), /^android-\d/)
  androidJar = platform === null ? '' : join(sdk, 'platforms', platform, 'android.jar')
}
if (androidJar === '' || !existsSync(androidJar)) {
  console.error('android.jar not found. Set ANDROID_JAR to an Android platform jar.')
  process.exit(1)
}

// --- d8 --------------------------------------------------------------------
let d8 = process.env.D8_JAR ?? ''
if (d8 === '' || !existsSync(d8)) {
  const sdkRoots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT,
    join(homedir(), 'AppData', 'Local', 'Android', 'Sdk')].filter(Boolean)
  const sdk = sdkRoots.find((dir) => existsSync(join(dir, 'build-tools')))
  const tools = sdk === undefined ? null : newest(join(sdk, 'build-tools'), /^\d/)
  d8 = tools === null ? '' : join(sdk, 'build-tools', tools, process.platform === 'win32' ? 'd8.bat' : 'd8')
}
if (d8 === '' || !existsSync(d8)) {
  console.error('d8 not found. Set D8_JAR to the R8 jar (com.android.tools.r8.D8 lives inside it).')
  process.exit(1)
}

const usingJar = d8.toLowerCase().endsWith('.jar')
console.log(`android.jar: ${androidJar}`)
console.log(`d8: ${usingJar ? `java -cp ${d8} com.android.tools.r8.D8` : d8}`)

rmSync(work, { recursive: true, force: true })
mkdirSync(join(work, 'classes'), { recursive: true })

console.log('javac: compiling Encoder.java')
execFileSync('javac', ['--release', '8', '-nowarn', '-cp', androidJar, '-d', join(work, 'classes'), source], { stdio: 'inherit' })

console.log('d8: dexing into lib/encoder.jar')
const jar = join(root, 'lib', 'encoder.jar')
if (existsSync(jar)) unlinkSync(jar)
const d8Args = ['--lib', androidJar, '--min-api', '29', '--output', jar, join(work, 'classes', 'dsh', 'Encoder.class')]
if (usingJar) {
  execFileSync('java', ['-cp', d8, 'com.android.tools.r8.D8', ...d8Args], { stdio: 'inherit' })
} else if (process.platform === 'win32') {
  // A .bat cannot be spawned directly on Windows (EINVAL): route through cmd.exe.
  execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/c', d8, ...d8Args], { stdio: 'inherit' })
} else {
  execFileSync(d8, d8Args, { stdio: 'inherit' })
}

const jarBytes = readFileSync(jar)
const base64 = jarBytes.toString('base64')
const banner = [
  '// Auto-generated - do not edit by hand.',
  '// Base64 of lib/encoder.jar (dex of tools/encoder/Encoder.java): the device-side',
  '// MediaCodec H.264 screen encoder. Embedded so the host can deploy it with a single',
  '// shell write, without relying on `adb push` (its sync protocol is fragile on flaky',
  '// USB links) and without a per-start copy step.',
  '// Rebuild with: node tools/encoder/build.mjs',
].join('\n')
writeFileSync(output, `${banner}\nexport const ENCODER_JAR_BASE64 = '${base64}'\n`, 'utf8')

rmSync(work, { recursive: true, force: true })
console.log(`wrote ${output} (${base64.length} base64 chars, ${jarBytes.length} jar bytes)`)
