/* Local sherpa-onnx KWS. Upstream JS/WASM/model assets retain their licenses. */
let moduleInstance, spotter, stream;
let paused = true;
let initializing;
self.onmessage = ({ data }) => {
  if (data.type === 'init') {
    initializing = (async () => {
      const assets = new URL(data.assets, self.location.href).href;
      importScripts(assets + 'sherpa-onnx-wasm-web.js', assets + 'sherpa-onnx-kws.js');
      moduleInstance = await SherpaOnnx({ locateFile: name => assets + name, print() {}, printErr() {} });
      for (const name of ['encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt']) {
        const response = await fetch(assets + name);
        if (!response.ok) throw new Error('Missing KWS asset');
        moduleInstance.FS.writeFile('/' + name, new Uint8Array(await response.arrayBuffer()));
      }
      const keywordList = Array.isArray(data.keywords) ? data.keywords : [];
      if (!keywordList.length || keywordList.length > 10 || keywordList.some(item => !item || typeof item.text !== 'string' || typeof item.phonemes !== 'string' || !/^[\u4e00-\u9fff]{1,20}$/.test(item.text) || !/^[\p{L}\p{M} ]+$/u.test(item.phonemes))) throw new Error('Invalid keyword list');
      const keywordText = keywordList.map(item => `${item.phonemes} @${item.text}`).join('\n') + '\n';
      moduleInstance.FS.writeFile('/keywords.txt', keywordText);
      spotter = createKws(moduleInstance, {
        featConfig: { samplingRate: 16000, featureDim: 80 },
        modelConfig: { transducer: { encoder: '/encoder.onnx', decoder: '/decoder.onnx', joiner: '/joiner.onnx' },
          tokens: '/tokens.txt', provider: 'cpu', modelType: '', numThreads: 1, debug: 0, modelingUnit: 'cjkchar', bpeVocab: '' },
        maxActivePaths: 4, numTrailingBlanks: 1, keywordsScore: 1.2, keywordsThreshold: 0.35,
        keywords: '/keywords.txt', keywordsBuf: '', keywordsBufSize: 0,
      });
      if (!spotter.handle) throw new Error('Invalid KWS model');
      stream = spotter.createStream(); paused = false;
      self.postMessage({ type: 'ready', keywords: keywordList.map(item => item.text) });
    })().catch(() => self.postMessage({ type: 'error' }));
    return;
  }
  if (data.type === 'reset') {
    stream?.free(); stream = spotter?.createStream(); paused = false;
    return;
  }
  if (data.type === 'pause') { paused = true; stream?.free(); stream = undefined; return; }
  if (data.type !== 'audio') return;
  try {
    if (!paused && stream) {
      const pcm = new Int16Array(data.audio);
      if (!pcm.length || pcm.length > 640) throw new Error('Invalid KWS audio');
      const samples = Float32Array.from(pcm, value => value / 32768);
      stream.acceptWaveform(16000, samples);
      while (spotter.isReady(stream)) {
        spotter.decode(stream);
        const result = spotter.getResult(stream);
        if (result.keyword) {
          paused = true; stream.free(); stream = undefined;
          self.postMessage({ type: 'wake', keyword: result.keyword });
          break;
        }
      }
    }
    self.postMessage({ type: 'processed' });
  } catch { paused = true; self.postMessage({ type: 'error' }); }
};
