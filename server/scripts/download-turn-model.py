"""Fetch pinned BSD-2-Clause Pipecat Smart Turn weights and verify SHA256."""
from hashlib import sha256
from pathlib import Path
from urllib.request import urlopen
URL = 'https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/f766f81/smart-turn-v3.2-cpu.onnx'
SHA256 = '2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f'
target = Path(__file__).resolve().parents[1] / 'models/smart-turn-v3.2-cpu.onnx'
if target.exists() and sha256(target.read_bytes()).hexdigest() == SHA256:
    print('Smart Turn model already verified')
else:
    with urlopen(URL, timeout=120) as response:
        data = response.read(16 * 1024 * 1024)
    if sha256(data).hexdigest() != SHA256:
        raise RuntimeError('Smart Turn model checksum mismatch')
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix('.download')
    temporary.write_bytes(data)
    temporary.replace(target)
    print('Smart Turn model downloaded and verified')
