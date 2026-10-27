# -*- coding: utf-8 -*-
"""离线人声增强: 用 DPDFNet ONNX 模型把录音里的背景噪声压掉, 尽量保留人声.

模型来自 sherpa-onnx 的 speech-enhancement-models 发布 (默认 48kHz 版本,
约 10MB), 纯 CPU 推理, 不需要 CUDA. 录音(webm/opus 等)先由 ffmpeg 解码成
48kHz 单声道 PCM, 再交给模型处理, 最后封装成 wav 返回.

可通过环境变量调整:
  SPEECH_ENHANCE_MODEL           模型路径 (默认 models/speech-enhancement/dpdfnet2_48khz_hr.onnx)
  SPEECH_ENHANCE_ATTENUATION_DB  0 表示完全抑制; 越大保留越多原始噪声(减少过度抑制痕迹)
  SPEECH_ENHANCE_THREADS         推理线程数, 默认 2
  FFMPEG_BIN                     ffmpeg 路径, 默认从 PATH 查找
"""
import io
import os
import shutil
import subprocess
import threading
import wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MODEL = ROOT / "models" / "speech-enhancement" / "dpdfnet2_48khz_hr.onnx"
SAMPLE_RATE = 48000


class SpeechEnhanceError(Exception):
    pass


_load_lock = threading.Lock()
_run_lock = threading.Lock()
_denoiser = None


def _model_path() -> Path:
    configured = os.environ.get("SPEECH_ENHANCE_MODEL", "").strip()
    return Path(configured).expanduser() if configured else DEFAULT_MODEL


def _attenuation_limit_db() -> float:
    raw = os.environ.get("SPEECH_ENHANCE_ATTENUATION_DB", "0").strip()
    try:
        value = float(raw)
    except ValueError:
        return 0.0
    return min(100.0, max(0.0, value))


def _get_denoiser():
    """懒加载模型; 加载一次后复用 (模型加载约 0.1s, 但仍避免重复初始化)。"""
    global _denoiser
    with _load_lock:
        if _denoiser is not None:
            return _denoiser
        model = _model_path()
        if not model.is_file():
            raise SpeechEnhanceError(
                f"未找到语音增强模型: {model}。可从 sherpa-onnx 的 "
                "speech-enhancement-models 发布下载 dpdfnet2_48khz_hr.onnx"
            )
        try:
            import sherpa_onnx
        except ImportError as exc:
            raise SpeechEnhanceError("缺少 sherpa-onnx 依赖，请先安装 requirements.txt") from exc

        config = sherpa_onnx.OfflineSpeechDenoiserConfig(
            model=sherpa_onnx.OfflineSpeechDenoiserModelConfig(
                dpdfnet=sherpa_onnx.OfflineSpeechDenoiserDpdfNetModelConfig(
                    model=str(model),
                    attenuation_limit_db=_attenuation_limit_db(),
                ),
                num_threads=_threads(),
            )
        )
        if not config.validate():
            raise SpeechEnhanceError("语音增强模型配置无效")
        _denoiser = sherpa_onnx.OfflineSpeechDenoiser(config)
        return _denoiser


def _threads() -> int:
    try:
        return max(1, int(os.environ.get("SPEECH_ENHANCE_THREADS", "2")))
    except ValueError:
        return 2


def _decode_audio(audio_bytes: bytes) -> np.ndarray:
    """任意常见音频 (webm/opus, m4a, wav...) → 48kHz 单声道 float32。"""
    ffmpeg = os.environ.get("FFMPEG_BIN", "").strip() or shutil.which("ffmpeg")
    if not ffmpeg:
        raise SpeechEnhanceError("未找到 ffmpeg，无法解码录音文件")
    command = [
        ffmpeg, "-nostdin", "-v", "error",
        "-i", "pipe:0",
        "-ac", "1", "-ar", str(SAMPLE_RATE),
        "-f", "s16le", "pipe:1",
    ]
    try:
        proc = subprocess.run(
            command,
            input=audio_bytes,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=180,
        )
    except subprocess.TimeoutExpired as exc:
        raise SpeechEnhanceError("音频解码超时") from exc

    if proc.returncode != 0 or not proc.stdout:
        detail = proc.stderr.decode("utf-8", errors="ignore").strip().splitlines()
        reason = detail[-1] if detail else "无法识别的音频格式"
        raise SpeechEnhanceError(f"音频解码失败: {reason}")

    samples = np.frombuffer(proc.stdout, dtype=np.int16).astype(np.float32) / 32768.0
    if samples.size == 0:
        raise SpeechEnhanceError("音频内容为空")
    return samples


def _encode_wav(samples: np.ndarray, sample_rate: int) -> bytes:
    pcm = np.clip(samples, -1.0, 1.0)
    pcm = (pcm * 32767.0).astype(np.int16)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(pcm.tobytes())
    return buffer.getvalue()


def enhance_audio(audio_bytes: bytes) -> tuple[bytes, int]:
    """录音字节流 → (增强后的 wav 字节流, 采样率)。

    同步阻塞函数，路由层需放到线程池执行。
    """
    denoiser = _get_denoiser()
    samples = _decode_audio(audio_bytes)
    try:
        with _run_lock:
            result = denoiser.run(samples, SAMPLE_RATE)
    except Exception as exc:
        raise SpeechEnhanceError(f"语音增强失败: {exc}") from exc
    return _encode_wav(result.samples, result.sample_rate), result.sample_rate
