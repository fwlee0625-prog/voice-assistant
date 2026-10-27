"""Binary stdin → DPDFNet WAV stdout. Isolated inference, no HTTP or legacy imports."""
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import wave

SAMPLE_RATE = 48000
MAX_SECONDS = 600


def decode_audio(audio):
    """Decode supported browser containers into bounded 48kHz mono PCM."""
    try:
        result = subprocess.run(
            [os.environ.get('FFMPEG_BIN', 'ffmpeg'), '-nostdin', '-v', 'error',
             '-i', 'pipe:0', '-t', str(MAX_SECONDS + 1), '-ac', '1', '-ar', str(SAMPLE_RATE),
             '-f', 's16le', 'pipe:1'], input=audio, capture_output=True, timeout=180,
        )
    except FileNotFoundError:
        raise ValueError('未找到 ffmpeg，请检查 FFMPEG_BIN') from None
    except subprocess.TimeoutExpired:
        raise ValueError('音频解码超时') from None
    if result.returncode or not result.stdout:
        raise ValueError('音频解码失败，请确认上传文件包含有效音频')
    if len(result.stdout) > MAX_SECONDS * SAMPLE_RATE * 2:
        raise ValueError('单条增强音频不能超过 10 分钟')
    import numpy as np
    return np.frombuffer(result.stdout, dtype=np.int16).astype(np.float32) / 32768.0


def enhance(samples):
    """Run exactly one DPDFNet inference; model settings come from the parent process."""
    model = os.environ.get('SPEECH_ENHANCE_MODEL', '')
    if not Path(model).is_file():
        raise ValueError('未找到人声增强模型，请配置 SPEECH_ENHANCE_MODEL')
    import sherpa_onnx
    config = sherpa_onnx.OfflineSpeechDenoiserConfig(
        model=sherpa_onnx.OfflineSpeechDenoiserModelConfig(
            dpdfnet=sherpa_onnx.OfflineSpeechDenoiserDpdfNetModelConfig(
                model=model, attenuation_limit_db=float(os.environ.get('SPEECH_ENHANCE_ATTENUATION_DB', '0')),
            ), num_threads=int(os.environ.get('SPEECH_ENHANCE_THREADS', '2')),
        ),
    )
    if not config.validate():
        raise ValueError('人声增强模型配置无效')
    return sherpa_onnx.OfflineSpeechDenoiser(config).run(samples, SAMPLE_RATE)


def encode_wav(result):
    """Serialize the mono inference output into a standard PCM16 WAV."""
    import numpy as np
    if result.sample_rate != SAMPLE_RATE:
        raise ValueError('增强模型输出采样率必须为 48kHz')
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(result.sample_rate)
        wav.writeframes((np.clip(result.samples, -1, 1) * 32767).astype(np.int16).tobytes())
    return buffer.getvalue()


def main():
    try:
        audio = sys.stdin.buffer.read(32 * 1024 * 1024 + 1)
        if not audio or len(audio) > 32 * 1024 * 1024:
            raise ValueError('音频为空或超过 32MB')
        sys.stdout.buffer.write(encode_wav(enhance(decode_audio(audio))))
    except (ValueError, ImportError) as error:
        message = str(error) if isinstance(error, ValueError) else '人声增强 worker 缺少依赖，请安装 workers/requirements.txt'
        sys.stderr.write(json.dumps({'error': message}, ensure_ascii=False))
        sys.exit(2)
    except Exception:
        sys.stderr.write(json.dumps({'error': '人声增强推理失败，请检查模型配置'}, ensure_ascii=False))
        sys.exit(2)


if __name__ == '__main__':
    main()
