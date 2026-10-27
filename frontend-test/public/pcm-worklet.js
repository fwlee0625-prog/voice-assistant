// AudioContext resamples the microphone to 16kHz; send mono PCM16 in 40ms frames.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.frame = new Int16Array(640)
    this.offset = 0
    this.active = true
    this.port.onmessage = ({ data }) => {
      if (data === 'flush') {
        this.active = false
        if (this.offset) this.port.postMessage(this.frame.slice(0, this.offset).buffer)
        this.port.postMessage('flushed')
      }
    }
  }
  process(inputs) {
    const input = inputs[0]?.[0]
    if (input && this.active) {
      for (const sample of input) {
        const value = Math.max(-1, Math.min(1, sample))
        this.frame[this.offset++] = Math.round(value * (value < 0 ? 32768 : 32767))
        if (this.offset === 640) {
          this.port.postMessage(this.frame.buffer, [this.frame.buffer])
          this.frame = new Int16Array(640)
          this.offset = 0
        }
      }
    }
    return true
  }
}
registerProcessor('pcm-capture', PcmCapture)
