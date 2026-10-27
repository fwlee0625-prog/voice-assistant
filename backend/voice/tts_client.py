# -*- coding: utf-8 -*-
"""TTS (Text-to-Speech) 客户端: 文本 → 音频字节流.

设计原则:
- 后端无关: 上层只调 `BaseTTSClient.synthesize(text) -> bytes`
- 四实现: cosyvoice (CosyVoice2-0.5B 自托管, 首选) + edge-tts (云端) +
          melo (MeloTTS 本机 CPU 开源兜底) + pyttsx3 (Windows SAPI5 离线兜底)
- 失败明示: 抛 TTSError, 由上层 broadcaster 决定降级或静默

扩展: 新增后端只需实现 BaseTTSClient 子类并加入 _BACKENDS 注册表
(dict 保序, 即 "auto" 模式的选择顺序).
"""
from __future__ import annotations

import abc
import os
import threading
import time
from typing import Any

from .config import get_config


class TTSError(Exception):
    """TTS 合成失败 (上层应捕获并降级)."""


class BaseTTSClient(abc.ABC):
    """TTS 后端抽象基类.

    子类必须实现:
        backend_name: 人类可读的后端名 (如 "edge", "pyttsx3")
        is_available():检测后端是否可用 (依赖是否安装, 服务是否可达)
        synthesize(text):文本 → 音频字节流 (mp3 / wav 取决于后端)
    """

    backend_name: str = "base"

    def __init__(self, config=None):
        # 默认接受 config 参数, 子类可覆盖
        self.cfg = config

    @abc.abstractmethod
    def is_available(self) -> bool:
        """后端是否可用 (未安装依赖 / 离线时返回 False)."""

    @abc.abstractmethod
    def synthesize(self, text: str) -> bytes:
        """同步合成音频. 失败抛 TTSError."""

    # 默认元信息 (子类可覆盖)
    def audio_format(self) -> str:
        """返回 'mp3' / 'wav' — 用于 HTTP Content-Type 推断."""
        return "mp3"

    def estimated_duration_ms(self, text: str, audio_bytes: bytes) -> int | None:
        """估算音频时长 (ms), 用于前端播放进度. 返回 None 表示不可估算."""
        return None


# ============ edge-tts: Microsoft Edge 在线 TTS ============

class EdgeTTSClient(BaseTTSClient):
    """edge-tts 后端 — 调用 Microsoft Edge 公共 TTS 接口.

    优点: 中文发音自然 (XiaoxiaoNeural 等), 完全免费, 零 GPU
    缺点: 需联网, 单次合成 ~0.5-2s 延迟
    依赖: pip install edge-tts (>=6.1)
    """

    backend_name = "edge"

    def __init__(self, config=None):
        self.cfg = config or get_config()

    def is_available(self) -> bool:
        try:
            import edge_tts  # noqa: F401
            return True
        except ImportError:
            return False

    def synthesize(self, text: str) -> bytes:
        if not text or not text.strip():
            raise TTSError("空文本无法合成")
        if not self.is_available():
            raise TTSError("edge-tts 未安装 (pip install edge-tts)")

        # edge-tts 是 async 库, 这里用 run_sync 包装同步
        try:
            import asyncio
            import edge_tts
        except ImportError as e:
            raise TTSError(f"edge-tts 依赖缺失: {e}") from e

        async def _run() -> bytes:
            communicate = edge_tts.Communicate(
                text=text,
                voice=self.cfg.tts_voice,
                rate=self.cfg.tts_rate,
                volume=self.cfg.tts_volume,
            )
            buf = bytearray()
            async for chunk in communicate.stream():
                if chunk.get("type") == "audio":
                    data = chunk.get("data")
                    if data:
                        buf.extend(data)
            return bytes(buf)

        try:
            return asyncio.run(_run())
        except Exception as e:
            raise TTSError(f"edge-tts 合成失败: {e}") from e

    def audio_format(self) -> str:
        return "mp3"

    def estimated_duration_ms(self, text: str, audio_bytes: bytes) -> int | None:
        # mp3 bitrate ~ 24-48kbps, 按平均 32kbps 估算 (上限避免超估)
        # 长度 ≈ 字节数 * 8 / bitrate(ms) = bytes * 8 / 32000 * 1000
        if not audio_bytes:
            return None
        return int(len(audio_bytes) * 8 * 1000 / 32000)


# ============ pyttsx3: Windows SAPI5 / macOS say / espeak 离线兜底 ============

class Pyttsx3Client(BaseTTSClient):
    """pyttsx3 后端 — 系统 TTS 引擎 (Windows SAPI5 / macOS NSSpeechSynthesizer / Linux espeak).

    优点: 完全离线, 零联网
    缺点: 中文声音机械, 音质差 (Windows 中文 TTS 引擎较基础)
    依赖: pip install pyttsx3 (>=2.90)
    """

    backend_name = "pyttsx3"

    # pyttsx3 引擎是进程级单例, 多线程不安全 — 加锁
    _lock = threading.Lock()

    def __init__(self, config=None):
        self.cfg = config or get_config()
        self._engine = None

    def is_available(self) -> bool:
        try:
            import pyttsx3  # noqa: F401
            return True
        except ImportError:
            return False

    def _get_engine(self):
        if self._engine is None:
            import pyttsx3
            self._engine = pyttsx3.init()
            # 尝试设置中文 voice (Windows SAPI5: Microsoft Huihui / Xiaoxiao)
            try:
                voices = self._engine.getProperty("voices")
                for v in voices or []:
                    v_id = (v.id or "").lower()
                    v_name = (v.name or "").lower()
                    if "chinese" in v_id or "zh" in v_id or "huihui" in v_name or "xiaoxiao" in v_name:
                        self._engine.setProperty("voice", v.id)
                        break
            except Exception:
                pass
        return self._engine

    def synthesize(self, text: str) -> bytes:
        if not text or not text.strip():
            raise TTSError("空文本无法合成")
        if not self.is_available():
            raise TTSError("pyttsx3 未安装 (pip install pyttsx3)")

        import tempfile
        import wave

        with self._lock:
            try:
                engine = self._get_engine()
                # 写到临时 wav, 再读回字节流
                with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                    tmp_path = tmp.name
                try:
                    engine.save_to_file(text, tmp_path)
                    engine.runAndWait()
                    with open(tmp_path, "rb") as f:
                        data = f.read()
                    return data
                finally:
                    try:
                        os.unlink(tmp_path)
                    except OSError:
                        pass
            except Exception as e:
                raise TTSError(f"pyttsx3 合成失败: {e}") from e

    def audio_format(self) -> str:
        return "wav"

    def estimated_duration_ms(self, text: str, audio_bytes: bytes) -> int | None:
        # wav: 假设 16kHz 16bit mono = 32000 bytes/sec
        if not audio_bytes:
            return None
        # 跳过 44 字节 wav header
        if audio_bytes[:4] == b"RIFF":
            return int((len(audio_bytes) - 44) * 1000 / 32000)
        return int(len(audio_bytes) * 1000 / 32000)


# ============ 远程 HTTP TTS 基类 (cosyvoice / melo 共用) ============

class RemoteHTTPClient(BaseTTSClient):
    """HTTP 远程 TTS 后端基类 — /health 探测缓存 + 子类各自的 /tts 调用.

    子类需提供: backend_name / _ENDPOINT_CFG_KEY (config 字段名) / synthesize().
    """

    _ENDPOINT_CFG_KEY = "tts_cosyvoice_endpoint"   # 子类按后端覆盖

    # /health 探测结果 TTL 缓存: broadcaster 每次 speak 都会查可用后端,
    # 不能每次都发 HTTP (跨机调用时网络往返有开销); 服务端模型加载中返回 503。
    # 失败结果只短缓存 5s — 服务 (如容器重启) 恢复后尽快重新纳入可选,
    # 避免 60s 内一直被 auto 跳过而落到其他后端
    _probe_lock = threading.Lock()
    _probe_cache: dict[str, tuple[float, bool]] = {}  # endpoint -> (探测时间, 是否可用)
    _PROBE_TTL = 60.0        # 成功探测的缓存 TTL (秒)
    _PROBE_TTL_FAIL = 5.0    # 失败探测的缓存 TTL (秒)

    def __init__(self, config=None):
        self.cfg = config or get_config()
        # _pick_client 传临时覆盖 config (只有 tts_voice 等字段) 时回退全局配置
        endpoint = getattr(self.cfg, self._ENDPOINT_CFG_KEY, None) \
                   or getattr(get_config(), self._ENDPOINT_CFG_KEY, "")
        self.endpoint = endpoint.rstrip("/")

    def is_available(self) -> bool:
        try:
            import requests
        except ImportError:
            return False
        now = time.time()
        with self._probe_lock:
            cached = self._probe_cache.get(self.endpoint)
            if cached:
                ttl = self._PROBE_TTL if cached[1] else self._PROBE_TTL_FAIL
                if now - cached[0] < ttl:
                    return cached[1]
        try:
            resp = requests.get(f"{self.endpoint}/health", timeout=(1, 2))
            ok = resp.status_code == 200
        except Exception:
            ok = False
        with self._probe_lock:
            self._probe_cache[self.endpoint] = (now, ok)
        return ok


def _rate_percent_to_speed(rate: str | None) -> float:
    """edge 风格语速 "+20%" / "-10%" → melo 线性倍速 1.2 / 0.9 (夹在 0.5-2.0)."""
    try:
        s = (rate or "").replace(" ", "").rstrip("%")
        return max(0.5, min(2.0, 1.0 + float(s) / 100.0))
    except (TypeError, ValueError):
        return 1.0


def _wav_duration_ms(audio_bytes: bytes) -> int | None:
    """解析 RIFF 头估算 wav 时长 (ms); 非 wav / 头异常返回 None."""
    if not audio_bytes or len(audio_bytes) < 44 or audio_bytes[:4] != b"RIFF":
        return None
    try:
        import struct
        byte_rate = struct.unpack_from("<I", audio_bytes, 28)[0]  # 已含声道数, 最准
        if byte_rate > 0:
            return int((len(audio_bytes) - 44) * 1000 / byte_rate)
        sample_rate = struct.unpack_from("<I", audio_bytes, 24)[0]
        bits = struct.unpack_from("<H", audio_bytes, 34)[0]
        if sample_rate > 0 and bits > 0:
            return int((len(audio_bytes) - 44) * 1000 / (sample_rate * bits / 8))
    except (struct.error, ZeroDivisionError):
        pass
    return None


# ============ cosyvoice: CosyVoice2-0.5B 自托管 (首选) ============

class CosyVoiceClient(RemoteHTTPClient):
    """CosyVoice2-0.5B 后端 — 调用 deploy/cosyvoice_server.py 暴露的 HTTP 接口.

    优点: 自托管 GPU 推理, zero-shot 音色克隆, 中文音质接近真人, 完全离线
    缺点: 需要 GPU 服务在跑 (~1.5GB 显存), 首句合成有预热延迟
    依赖: deploy/docker-compose.yml 的 cosyvoice 服务 (8006 端口) + requests
    """

    backend_name = "cosyvoice"
    _ENDPOINT_CFG_KEY = "tts_cosyvoice_endpoint"

    def synthesize(self, text: str) -> bytes:
        if not text or not text.strip():
            raise TTSError("空文本无法合成")
        try:
            import requests
        except ImportError as e:
            raise TTSError(f"requests 依赖缺失: {e}") from e

        # GPU 合成一句话 1-3s, 首句预热/长文本更慢 — 至少给 30s
        timeout = max(float(getattr(self.cfg, "tts_timeout", 15.0) or 15.0), 30.0)
        try:
            resp = requests.post(
                f"{self.endpoint}/tts",
                json={"text": text},
                timeout=timeout,
            )
        except requests.RequestException as e:
            raise TTSError(f"CosyVoice2 服务不可达 ({self.endpoint}): {e}") from e
        if resp.status_code != 200:
            raise TTSError(f"CosyVoice2 合成失败 HTTP {resp.status_code}: {resp.text[:200]}")
        if not resp.content:
            raise TTSError("CosyVoice2 返回空音频")
        return resp.content

    def audio_format(self) -> str:
        return "wav"

    def estimated_duration_ms(self, text: str, audio_bytes: bytes) -> int | None:
        # wav 24kHz 16bit mono = 48000 bytes/sec, 跳过 44 字节 RIFF header
        if not audio_bytes:
            return None
        if audio_bytes[:4] == b"RIFF":
            return int((len(audio_bytes) - 44) * 1000 / 48000)
        return int(len(audio_bytes) * 1000 / 48000)


# ============ melo: MeloTTS 本机 CPU 开源兜底 ============

class MeloTTSClient(RemoteHTTPClient):
    """MeloTTS 后端 — 调用 deploy/melo_server.py 暴露的本机 HTTP 接口.

    优点: MIT 开源完全免费, 纯 CPU 实时推理 (不占 GPU), 断网可用,
          中文音质明显好于 pyttsx3 — edge 被微软 403 时的本机兜底
    缺点: 音质不及 cosyvoice/edge; 需要 models/melo/venv 服务在跑
    依赖: deploy/melo_server.py (models/melo/venv 独立环境, 默认 127.0.0.1:8007)
    """

    backend_name = "melo"
    _ENDPOINT_CFG_KEY = "tts_melo_endpoint"

    def synthesize(self, text: str) -> bytes:
        if not text or not text.strip():
            raise TTSError("空文本无法合成")
        try:
            import requests
        except ImportError as e:
            raise TTSError(f"requests 依赖缺失: {e}") from e

        # CPU 合成一句话 1-3s, 长文本/首句更慢 — 与 cosyvoice 一致至少给 30s
        timeout = max(float(getattr(self.cfg, "tts_timeout", 15.0) or 15.0), 30.0)
        try:
            resp = requests.post(
                f"{self.endpoint}/tts",
                json={"text": text, "speed": _rate_percent_to_speed(self.cfg.tts_rate)},
                timeout=timeout,
            )
        except requests.RequestException as e:
            raise TTSError(f"MeloTTS 服务不可达 ({self.endpoint}): {e}") from e
        if resp.status_code != 200:
            raise TTSError(f"MeloTTS 合成失败 HTTP {resp.status_code}: {resp.text[:200]}")
        if not resp.content:
            raise TTSError("MeloTTS 返回空音频")
        return resp.content

    def audio_format(self) -> str:
        return "wav"

    def estimated_duration_ms(self, text: str, audio_bytes: bytes) -> int | None:
        # 采样率由服务端模型决定 (中文模型 44.1kHz), 解析 wav 头最稳
        return _wav_duration_ms(audio_bytes)


# ============ 后端注册表 + 工厂 ============

# dict 保序 = "auto" 模式的选择顺序 (也是主后端失败后的降级顺序):
# cosyvoice (自托管 GPU, 音质最好) > edge (微软云端) > melo (本机开源 CPU) >
# pyttsx3 (系统 TTS, 机械音最后兜底)
_BACKENDS: dict[str, type[BaseTTSClient]] = {
    "cosyvoice": CosyVoiceClient,
    "edge": EdgeTTSClient,
    "melo": MeloTTSClient,
    "pyttsx3": Pyttsx3Client,
}


def list_available_backends(config=None) -> list[str]:
    """返回所有已安装且可用的后端名 (按注册顺序: cosyvoice > edge > melo > pyttsx3)."""
    cfg = config or get_config()
    return [
        name for name, cls in _BACKENDS.items()
        if cls(cfg).is_available()
    ]


def get_tts_client(backend: str | None = None, config=None) -> BaseTTSClient:
    """根据 backend 名称获取 TTS 客户端实例.

    参数:
        backend: "cosyvoice" / "edge" / "melo" / "pyttsx3" / "auto" (None 等同 auto)
                "auto" 时按 list_available_backends() 顺序选第一个可用后端
                (注册顺序 cosyvoice > edge > melo > pyttsx3)
        config: VoiceConfig 实例 (默认用全局单例)

    返回: 已实例化的 TTS 客户端
    抛 TTSError: 后端名未知 / 所有后端不可用
    """
    cfg = config or get_config()
    backend = (backend or cfg.tts_backend or "auto").lower()

    if backend == "auto":
        available = list_available_backends(cfg)
        if not available:
            raise TTSError(
                "没有可用的 TTS 后端 (请 pip install edge-tts 或 pyttsx3, "
                "或检查网络/系统 TTS 引擎)"
            )
        return _BACKENDS[available[0]](cfg)

    if backend not in _BACKENDS:
        raise TTSError(f"未知 TTS 后端: {backend}, 可选: {list(_BACKENDS.keys())}")

    client = _BACKENDS[backend](cfg)
    if not client.is_available():
        raise TTSError(f"TTS 后端 {backend} 不可用 (依赖未安装或环境不支持)")
    return client
