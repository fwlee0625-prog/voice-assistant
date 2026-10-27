import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const root = new URL('../public/kws/', import.meta.url)
try {
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'))
  for (const name of ['sherpa-onnx-wasm-web.js', 'sherpa-onnx-wasm-web.wasm', 'sherpa-onnx-kws.js', 'encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt']) {
    const data = readFileSync(new URL(name, root))
    const file = manifest.files[name]
    if (!file || data.length !== file.bytes || createHash('sha256').update(data).digest('hex') !== file.sha256) throw Error('Asset checksum mismatch')
  }
  console.log('Local KWS assets verified')
} catch {
  console.error('KWS 资源缺失或损坏，请在 frontend-test 执行 pnpm setup-kws 后重试。')
  process.exitCode = 1
}
