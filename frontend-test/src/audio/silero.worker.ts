/// <reference lib="webworker" />
/** Silero v5 ONNX streaming contract: 512 samples + 64 context, recurrent state. */
import * as ort from 'onnxruntime-web/wasm'
let session: ort.InferenceSession
let state: ort.Tensor = new ort.Tensor('float32', new Float32Array(256), [2, 1, 128])
let context = new Float32Array(64)
const sr = new ort.Tensor('int64', BigInt64Array.of(16000n), [])
let chain = Promise.resolve()
self.onmessage = ({ data }) => {
  chain = chain.then(async () => {
    if (data.type === 'init') {
      ort.env.wasm.numThreads = 1
      ort.env.wasm.proxy = false
      ort.env.wasm.wasmPaths = data.assets
      session = await ort.InferenceSession.create(data.assets + 'silero_vad_v5.onnx', { executionProviders: ['wasm'] })
      self.postMessage({ type: 'ready' })
    } else if (data.type === 'frame') {
      const frame = new Float32Array(data.audio)
      if (frame.length !== 512) throw new Error('Invalid frame')
      const input = new Float32Array(576); input.set(context); input.set(frame, 64)
      const tensor = new ort.Tensor('float32', input, [1, 576])
      const result = await session.run({ input: tensor, state, sr })
      tensor.dispose(); state.dispose(); state = result.stateN!
      context = frame.slice(-64)
      const probability = Number(result.output!.data[0]); result.output!.dispose()
      if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error('Invalid speech probability')
      self.postMessage({ type: 'probability', probability })
    }
  }).catch(() => { self.postMessage({ type: 'error' }) })
}
