"""Install pinned official sherpa-onnx browser runtime + Chinese KWS weights.
Downloads occur only during setup. Runtime inference loads same-origin files.
"""
import argparse
import hashlib
import json
from pathlib import Path
import tarfile
from urllib.request import urlopen

parser = argparse.ArgumentParser()
parser.add_argument('--cache-dir', type=Path, default=Path(__file__).resolve().parents[1] / '.model-cache')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
target = root / 'public/kws'
target.mkdir(parents=True, exist_ok=True)
args.cache_dir.mkdir(parents=True, exist_ok=True)
archives = [
    ('sherpa_onnx_web-2.0.1.tar.gz', 'https://pub.dev/api/archives/sherpa_onnx_web-2.0.1.tar.gz',
     '38dce9890b22227c4a18c35cd09205435efcad6bd3ef788f9065673385a967dc', {
       'assets/sherpa-onnx-wasm-web.js': 'sherpa-onnx-wasm-web.js',
       'assets/sherpa-onnx-wasm-web.wasm': 'sherpa-onnx-wasm-web.wasm',
       'assets/sherpa-onnx-kws.js': 'sherpa-onnx-kws.js', 'LICENSE': 'LICENSE-runtime.txt'}),
    ('sherpa-kws-zh.tar.bz2', 'https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01.tar.bz2',
     'b2f7c89690dc8ce4c6ed6afeab7cd800c36ad1421fb6b6302b4a4b194cf7f35f', {
       'sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01/encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx': 'encoder.onnx',
       'sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01/decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx': 'decoder.onnx',
       'sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01/joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx': 'joiner.onnx',
       'sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01/tokens.txt': 'tokens.txt',
       'sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01/README.md': 'MODEL-README.md'}),
]
files = {}
for name, url, digest, members in archives:
    cache = args.cache_dir / name
    if not cache.exists() or hashlib.sha256(cache.read_bytes()).hexdigest() != digest:
        with urlopen(url, timeout=180) as response:
            data = response.read(64 * 1024 * 1024)
        if hashlib.sha256(data).hexdigest() != digest:
            raise RuntimeError('KWS archive checksum mismatch: ' + name)
        cache.write_bytes(data)
    with tarfile.open(cache) as archive:
        for source, filename in members.items():
            item = archive.getmember(source)
            if not item.isfile() or item.size > 64 * 1024 * 1024:
                raise RuntimeError('Invalid model archive member')
            data = archive.extractfile(item).read()
            temporary = target / (filename + '.tmp')
            temporary.write_bytes(data)
            temporary.replace(target / filename)
            files[filename] = {'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
(target / 'manifest.json').write_text(json.dumps({'runtime': 'sherpa_onnx_web-2.0.1', 'model': 'wenetspeech-kws-3.3M-2024-01-01-int8', 'sources': [{'url': url, 'sha256': digest} for _, url, digest, _ in archives], 'files': files}, indent=2) + '\n')
print('Installed verified local Chinese KWS assets')
