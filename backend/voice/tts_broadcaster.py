# -*- coding: utf-8 -*-
"""TTS 模板广播器 — 任何需要语音播报的地方统一调 speak().

这是语音播报的统一入口. 业务侧不应该直接 import tts_client 或具体后端,
应该只调 TTSBroadcaster 的 speak() / synthesize_only() 方法.

核心能力:
  1. **模板方法** — 业务侧一行代码: `await broadcaster.speak("您好, 我是 AI 教练")`
  2. **口语规范化** — 播报前自动清洗 Markdown/emoji/特殊符号 (normalize_for_speech),
     按"人正常说话"的方式播报, 不读出任何特殊标点符号
  3. **自动后端选择** — 优先 CosyVoice2 (自托管, 音质最好), 降级 edge-tts (云端)
     → melo (MeloTTS 本机开源 CPU) → pyttsx3 (系统离线)
  4. **结果缓存** — 相同文本只合成一次, 文件存到 cache_dir (按 hash 命名)
  5. **失败不阻塞** — 任何后端都失败时, 返回 error 状态而非抛异常, 避免主链路挂
  6. **线程安全** — 单例 + 锁, 多 worker 并发安全

典型用法:
    from voice import TTSBroadcaster
    result = TTSBroadcaster().speak(reply_text)
    if result.status == "ok":
        print(f"播放: {result.audio_url} ({result.duration_ms}ms)")

扩展新场景: 直接调 speak() 即可, 不用关心后端/缓存/降级.
"""
from __future__ import annotations

import hashlib
import os
import re
import threading
import time
from dataclasses import dataclass, field
from typing import Any

from .config import get_config
from .tts_client import (
    BaseTTSClient,
    TTSError,
    get_tts_client,
    list_available_backends,
)

# ============================================================
# 播报文本口语规范化 — 特殊符号不进 TTS, 按"人正常说话"播报
# ============================================================

# 中文小写数字 (圈号 ① → "一、" 转换用)
_ZH_DIGITS = "零一二三四五六七八九"

# Markdown 图片/链接: ![alt](url) → 空, [text](url) → text (URL 口语播报无意义)
_MD_IMAGE_RE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
_MD_LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]*\)")
# 裸 URL 整体删除
_URL_RE = re.compile(r"(?:https?|ftp)://\S+", re.IGNORECASE)

# 数字符号 → 中文读法 (在符号删除前转换; 限定 1-2 位数字且两侧无相邻数字/字母/同类符号,
# 避免误伤长数字/编号, 如 2026-091、P85-12)
_DATE_RE = re.compile(r"(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)")
_PERCENT_RE = re.compile(r"(\d+(?:\.\d+)?)\s*[%％]")
_RANGE_RE = re.compile(r"(?<![0-9A-Za-z-])(\d{1,2})\s*[-~～—–]\s*(\d{1,2})(?![\d-])")
_FRACTION_RE = re.compile(r"(?<![0-9A-Za-z/])(\d{1,2})\s*/\s*(\d{1,2})(?![\d/])")
_PLUS_RE = re.compile(r"(?<![0-9A-Za-z])(\d{1,2})\s*\+\s*(\d{1,2})(?!\d)")
_EQ_RE = re.compile(r"(?<![0-9A-Za-z])(\d{1,3})\s*=\s*(\d{1,3})(?!\d)")
# 未被上面转换的长数字分隔符 (编号/日期残段等): - ~ / + = → 逗号停顿,
# 防止符号删除后数字粘连成错误读法 (如 "2026-091" → "2026091")
_NUM_SEP_LEFTOVER_RE = re.compile(r"(\d)\s*[-–—～~+/=]\s*(\d)")
# 圈号数字 ①-⑩ → "一、" (qwen 中文回复常用; 引擎直读读音不可控)
_CIRCLED_NUM_RE = re.compile(r"[\u2460-\u2469]")

# 行首列表标记 (含缩进): "- " / "* " / "• " / "1. " / "1、" / "1)" → 删除, 只念内容.
# 数字标记要求后随空白或中文, 避免误伤行首小数 ("3.5 米")
_LIST_BULLET_RE = re.compile(r"^[ \t]*[-*+•·]+\s*", re.MULTILINE)
_LIST_ORDERED_RE = re.compile(r"^[ \t]*\d{1,3}[.、)](?=\s|[\u4e00-\u9fff])[ \t]*", re.MULTILINE)

# emoji / 装饰符号 / 杂项图形 (箭头、几何图形、dingbat、emoji 主区、变体选择符)
_EMOJI_RE = re.compile(
    "["
    "\U00002190-\U000021FF"  # 箭头 ← → ↔
    "\U00002300-\U000023FF"  # 技术符号 ⌚ ⏱
    "\U000025A0-\U000027BF"  # 几何图形 + 杂项符号 + dingbat ■ ● ✅ ❌
    "\U00002B00-\U00002BFF"  # 星形/箭头变体 ⭐ ⬆
    "\U0000FE00-\U0000FE0F"  # 变体选择符 (emoji 修饰)
    "\U0001F000-\U0001FAFF"  # emoji 主区 🎱 👍
    "\u200d\u20e3"  # 零宽连接符 / 组合键帽
    "]+"
)

# 直接删除的符号: Markdown 语法符 + 数学/技术符号 + 制表框线 + 全角变体
# (保留正常中英文标点 ，。！？；：、""''() 等 — 引擎按停顿处理, 不会读出)
_STRIP_RE = re.compile(
    r"[*#`~_|<>{}\[\]\\@$^=&+\-/"
    "\u00b0\u00b1\u00b6\u00b7\u00d7\u00f7"  # ° ± ¶ · × ÷
    "\u2020\u2021\u2022\u2023\u25aa\u25ab\u25e6"  # † ‡ • ▪ ▫ ◦
    "\u246a-\u24ff"  # ⑪-⑳ 及带圈/括号数字
    "\u2500-\u257f"  # 制表框线 ─ │ ┌
    "＊＃｀～＿｜＄＾＝＆＋＼／＜＞［］｛｝"
    "]+"
)


def _circled_num_to_zh(match: "re.Match") -> str:
    """圈号数字 ①-⑩ → 中文数字 + 顿号 (① → "一、")."""
    n = ord(match.group()) - 0x2460 + 1  # ①=1 ... ⑩=10
    return ("十" if n == 10 else _ZH_DIGITS[n]) + "、"


def normalize_for_speech(text: str) -> str:
    """播报文本 → 口语文本: 清洗一切会被 TTS 读出或读音生硬的特殊符号.

    TTS 引擎对符号的处理不可控 (pyttsx3 会读出部分符号, edge-tts 对 "·"/"%"
    等有自己的规范化), 统一在 speak() 入口清洗, 保证播报像人正常说话:

      - Markdown: **加粗** / # 标题 / - 列表 / `代码` / [链接](url) / 图片 → 只留内容
      - emoji / 装饰符号 / 制表框线 / 技术符号 (* # @ & | ~ 等) → 删除
      - 数字符号转读法: 50% → 百分之50, 5-3 → 5到3, 3/4 → 3分之4,
        1+1=2 → 1加1等于2, 2026-09-23 → 2026年09月23日, ① → 一、
      - 换行 → 逗号 (列表项之间的自然停顿), 连续/冲突标点去重

    返回: 规范化后的文本; 清洗后为空 (纯符号/emoji 输入) 返回 "".
    """
    if not text or not text.strip():
        return ""
    t = text
    # 1) Markdown 链接/图片 → 只留可读文字
    t = _MD_IMAGE_RE.sub("", t)
    t = _MD_LINK_RE.sub(r"\1", t)
    # 2) 裸 URL 删除
    t = _URL_RE.sub("", t)
    # 3) 数字符号 → 中文读法 (必须在符号删除前转换)
    t = _DATE_RE.sub(r"\1年\2月\3日", t)
    t = _PERCENT_RE.sub(r"百分之\1", t)
    t = _RANGE_RE.sub(r"\1到\2", t)
    t = _FRACTION_RE.sub(r"\1分之\2", t)
    t = _PLUS_RE.sub(r"\1加\2", t)
    t = _EQ_RE.sub(r"\1等于\2", t)
    t = _NUM_SEP_LEFTOVER_RE.sub(r"\1，\2", t)
    t = _CIRCLED_NUM_RE.sub(_circled_num_to_zh, t)
    # 4) 行首列表标记 → 删除 (只念内容)
    t = _LIST_BULLET_RE.sub("", t)
    t = _LIST_ORDERED_RE.sub("", t)
    # 5) emoji / 装饰符号 / 特殊符号 → 删除
    t = _EMOJI_RE.sub("", t)
    t = _STRIP_RE.sub("", t)
    # 6) 换行 → 逗号 (自然停顿), 空白折叠
    t = re.sub(r"[ \t]*\n+[ \t]*", "，", t)
    t = re.sub(r"[ \t\u3000\u00a0]+", " ", t)
    # 7) 标点整理: 标点前空格删除 / 连续弱标点去重 / 弱强标点冲突只留强标点
    t = re.sub(r"\s+([，。！？；：、])", r"\1", t)
    t = re.sub(r"([，、；：])[，、；：]+", r"\1", t)
    t = re.sub(r"([。！？；：])[，、；：]+", r"\1", t)
    t = re.sub(r"[，、；：]+([。！？])", r"\1", t)
    return t.strip(" ，、；")


@dataclass
class SpeakResult:
    """speak() 统一返回结构. 业务侧只需关心 status 和 audio_url."""
    status: str = "ok"  # ok / error / skipped
    audio_url: str = ""  # 前端可访问的 URL, e.g. /api/voice/audio/abc123.mp3
    audio_path: str = ""  # 服务端绝对路径
    backend: str = ""  # 实际用的后端: cosyvoice / edge / pyttsx3 / cache
    audio_format: str = "mp3"  # mp3 / wav
    duration_ms: int | None = None  # 估算时长
    cached: bool = False  # 是否命中缓存
    latency_ms: int = 0  # 合成耗时
    error: str = ""  # 错误信息 (status=error 时填)
    text_hash: str = ""  # 文本 hash (用于排查/重放)

    def to_dict(self) -> dict:
        return {
            "status": self.status,
            "audio_url": self.audio_url,
            "audio_path": self.audio_path,
            "backend": self.backend,
            "audio_format": self.audio_format,
            "duration_ms": self.duration_ms,
            "cached": self.cached,
            "latency_ms": self.latency_ms,
            "error": self.error,
            "text_hash": self.text_hash,
        }


class TTSBroadcaster:
    """TTS 模板广播器 — 单例.

    任何要播音的地方都调: TTSBroadcaster().speak(text)
    """

    _instance: "TTSBroadcaster | None" = None
    _instance_lock = threading.Lock()

    def __new__(cls, *args, **kwargs):
        # 双重检查锁实现线程安全单例
        if cls._instance is None:
            with cls._instance_lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._initialized = False
        return cls._instance

    def __init__(self, config=None):
        # 单例只初始化一次
        if getattr(self, "_initialized", False):
            return
        self.cfg = config or get_config()
        self._cache_lock = threading.Lock()
        self._last_purge_at = 0.0   # 上次过期清理时刻 (节流用)
        self._ensure_cache_dir()
        self._initialized = True

    # ---------- 核心入口 ----------

    def speak(self, text: str, **opts) -> SpeakResult:
        """模板方法 — 文本 → 音频文件 + URL.

        任何需要语音播报的地方调这个就行. 内部自动处理:
        - 空文本 / 禁用: 返回 status="skipped"
        - 口语规范化: Markdown/emoji/特殊符号自动清洗, 不播报符号本身
        - 缓存命中: 跳过合成
        - 后端选择: cosyvoice 优先, 失败降级 edge → melo → pyttsx3
        - 失败不阻塞: 返回 status="error", 不抛异常

        参数:
            text: 要合成的文本 (中文/英文均可, 特殊符号自动清洗)
            opts: 可选覆盖 —
                backend: 强制指定后端 ("edge" / "pyttsx3" / "auto")
                voice: 强制指定发音人 (覆盖 config.tts_voice)
                rate: 强制语速 (覆盖 config.tts_rate)
                volume: 强制音量 (覆盖 config.tts_volume)
                skip_cache: 跳过缓存 (强制重新合成, 默认 False)

        返回: SpeakResult — 业务侧用 .status / .audio_url
        """
        # 口语规范化: 特殊符号不进 TTS (在缓存 hash 前, 相同口语内容共享缓存)
        text = normalize_for_speech(text or "")
        if not text:
            return SpeakResult(status="skipped", error="空文本")

        if not self.cfg.tts_enabled:
            return SpeakResult(status="skipped", error="TTS 已被配置禁用 (TTS_ENABLED=0)")

        text_hash = self._hash_text(text)

        # 1. 缓存命中 (除非显式 skip) — mp3/wav 双格式兼容探测:
        #    hash 不含后端 → edge 时代的 .mp3 与 cosyvoice 的 .wav 可能并存,
        #    按首选后端格式优先 (音色统一), 另一格式兜底命中
        if not opts.get("skip_cache"):
            primary_fmt = self._peek_format()
            for fmt in dict.fromkeys((primary_fmt, "wav", "mp3")):
                cache_path = self._cache_path(text_hash, fmt)
                if os.path.isfile(cache_path):
                    size = os.path.getsize(cache_path)
                    return SpeakResult(
                        status="ok",
                        audio_url=self._audio_url(text_hash, fmt),
                        audio_path=cache_path,
                        backend="cache",
                        audio_format=fmt,
                        duration_ms=self._estimate_duration(text, size, fmt, cache_path),
                        cached=True,
                        latency_ms=0,
                        text_hash=text_hash,
                    )

        # 2. 选后端
        backend = (opts.get("backend") or self.cfg.tts_backend or "auto").lower()
        t0 = time.time()
        try:
            client = self._pick_client(backend, opts)
        except TTSError as e:
            return SpeakResult(
                status="error",
                error=str(e),
                text_hash=text_hash,
                latency_ms=int((time.time() - t0) * 1000),
            )

        # 3. 合成 + 缓存 (失败时按降级链重试)
        try:
            audio_bytes = client.synthesize(text)
            audio_fmt = client.audio_format()
            self._write_cache(text_hash, audio_bytes, audio_fmt)
            cache_path = self._cache_path(text_hash, audio_fmt)
            return SpeakResult(
                status="ok",
                audio_url=self._audio_url(text_hash, audio_fmt),
                audio_path=cache_path,
                backend=client.backend_name,
                audio_format=audio_fmt,
                duration_ms=client.estimated_duration_ms(text, audio_bytes),
                cached=False,
                latency_ms=int((time.time() - t0) * 1000),
                text_hash=text_hash,
            )
        except TTSError as primary_err:
            # 4. 降级: 试下一个可用后端
            fallback = self._try_fallback(text, primary_err, exclude=client.backend_name)
            if fallback is not None:
                return fallback
            return SpeakResult(
                status="error",
                error=f"主后端 {client.backend_name} 失败且无降级: {primary_err}",
                text_hash=text_hash,
                latency_ms=int((time.time() - t0) * 1000),
            )

    def synthesize_only(self, text: str, **opts) -> bytes:
        """纯合成 — 文本 → 音频字节流, 不写缓存不返回 URL.

        适合: 流式 / 一次性场景 (不要重复播放)
        抛 TTSError: 合成失败
        """
        text = (text or "").strip()
        if not text:
            raise TTSError("空文本无法合成")
        backend = (opts.get("backend") or self.cfg.tts_backend or "auto").lower()
        client = self._pick_client(backend, opts)
        return client.synthesize(text)

    # ---------- 缓存管理 ----------

    def clear_cache(self) -> int:
        """清空所有缓存文件. 返回清理的文件数."""
        cleared = 0
        cache_dir = self.cfg.tts_cache_dir
        if not os.path.isdir(cache_dir):
            return 0
        for name in os.listdir(cache_dir):
            path = os.path.join(cache_dir, name)
            try:
                if os.path.isfile(path):
                    os.unlink(path)
                    cleared += 1
            except OSError:
                continue
        return cleared

    def cache_size_bytes(self) -> int:
        """缓存目录总大小 (字节)."""
        cache_dir = self.cfg.tts_cache_dir
        if not os.path.isdir(cache_dir):
            return 0
        total = 0
        for name in os.listdir(cache_dir):
            path = os.path.join(cache_dir, name)
            try:
                if os.path.isfile(path):
                    total += os.path.getsize(path)
            except OSError:
                continue
        return total

    def cache_dir(self) -> str:
        return self.cfg.tts_cache_dir

    def status(self) -> dict:
        """返回播报器状态 — 供 /api/voice/status 健康检查."""
        return {
            "enabled": self.cfg.tts_enabled,
            "backend": self.cfg.tts_backend,
            "voice": self.cfg.tts_voice,
            "cache_dir": self.cfg.tts_cache_dir,
            "cache_files": self._count_cache_files(),
            "cache_bytes": self.cache_size_bytes(),
            "available_backends": list_available_backends(self.cfg),
        }

    # ---------- 内部 ----------

    def _pick_client(self, backend: str, opts: dict) -> BaseTTSClient:
        """根据 backend 名称选客户端, 支持临时覆盖 voice/rate/volume."""
        client = get_tts_client(backend, self.cfg)
        # 临时覆盖: 通过 SimpleNamespace 模拟 config 的字段访问
        # 注意用 or 兜底 — 调用方传入显式 None (如 req.get("voice")) 时不应覆盖为 None
        if any(k in opts for k in ("voice", "rate", "volume")):
            class _Opts:
                pass

            new_cfg = _Opts()
            new_cfg.tts_voice = opts.get("voice") or self.cfg.tts_voice
            new_cfg.tts_rate = opts.get("rate") or self.cfg.tts_rate
            new_cfg.tts_volume = opts.get("volume") or self.cfg.tts_volume
            # 用 _BACKENDS 直接重新实例化 (避免污染全局)
            from .tts_client import _BACKENDS
            cls_obj = _BACKENDS[client.backend_name]
            client = cls_obj(new_cfg)  # type: ignore[abstract]
        return client

    def _try_fallback(self, text: str, primary_err: TTSError, exclude: str) -> SpeakResult | None:
        """主后端失败时, 试下一个可用后端 (排除已失败的)."""
        available = [b for b in list_available_backends(self.cfg) if b != exclude]
        if not available:
            return None
        from .tts_client import _BACKENDS
        for backend_name in available:
            cls_obj = _BACKENDS.get(backend_name)
            if not cls_obj:
                continue
            try:
                t0 = time.time()
                client = cls_obj(self.cfg)
                if not client.is_available():
                    continue
                audio_bytes = client.synthesize(text)
                audio_fmt = client.audio_format()
                text_hash = self._hash_text(text)
                self._write_cache(text_hash, audio_bytes, audio_fmt)
                cache_path = self._cache_path(text_hash, audio_fmt)
                return SpeakResult(
                    status="ok",
                    audio_url=self._audio_url(text_hash, audio_fmt),
                    audio_path=cache_path,
                    backend=client.backend_name,
                    audio_format=audio_fmt,
                    duration_ms=client.estimated_duration_ms(text, audio_bytes),
                    cached=False,
                    latency_ms=int((time.time() - t0) * 1000),
                    text_hash=text_hash,
                    error=f"主后端降级 (primary: {primary_err})",
                )
            except TTSError:
                continue
        return None

    def _hash_text(self, text: str) -> str:
        # hash 内容: text + voice + rate + volume (不同发音参数合成结果不同, 不能共享缓存)
        payload = f"{text}|{self.cfg.tts_voice}|{self.cfg.tts_rate}|{self.cfg.tts_volume}"
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]

    def _cache_path(self, text_hash: str, audio_fmt: str) -> str:
        ext = "mp3" if audio_fmt == "mp3" else "wav"
        return os.path.join(self.cfg.tts_cache_dir, f"{text_hash}.{ext}")

    def _audio_url(self, text_hash: str, audio_fmt: str) -> str:
        ext = "mp3" if audio_fmt == "mp3" else "wav"
        return f"/api/voice/audio/{text_hash}.{ext}"

    def _write_cache(self, text_hash: str, audio_bytes: bytes, audio_fmt: str) -> None:
        path = self._cache_path(text_hash, audio_fmt)
        # 写盘失败不应阻塞主流程 (TTS 已成功, 只是缓存没写, 下次重新合成)
        try:
            self._ensure_cache_dir()
            with self._cache_lock:
                # 临时文件 + 原子 rename, 避免读到半截
                tmp_path = path + ".tmp"
                with open(tmp_path, "wb") as f:
                    f.write(audio_bytes)
                if os.path.isfile(path):
                    os.unlink(path)
                os.rename(tmp_path, path)
        except OSError:
            pass
        # 写入成功后同步清理过期缓存 (失败静默, 不影响主流程)
        self._purge_expired_cache()

    def _purge_expired_cache(self) -> int:
        """删除早于 TTL 的缓存音频文件 (mtime = 写入时刻), 返回删除数.

        - 每次写缓存时调用, 60s 节流 (句子级流式一轮写多个文件, 避免重复扫目录);
        - 只删 cache_dir 内的 .mp3/.wav/.tmp, 其他文件不动;
        - 单文件删除失败跳过; TTS_CACHE_TTL_SECONDS=0 时关闭清理。
        """
        ttl = float(getattr(self.cfg, "tts_cache_ttl_seconds", 600.0) or 0.0)
        if ttl <= 0:
            return 0
        now = time.time()
        # 节流: 距上次清理不足 60s 跳过 (同一轮流式合成的多句不必每次都扫)
        if now - self._last_purge_at < 60.0:
            return 0
        self._last_purge_at = now
        cache_dir = self.cfg.tts_cache_dir
        deleted = 0
        try:
            names = os.listdir(cache_dir)
        except OSError:
            return 0
        for name in names:
            if not name.endswith((".mp3", ".wav", ".tmp")):
                continue
            fpath = os.path.join(cache_dir, name)
            try:
                # 刚写入的文件 mtime≈now, 天然不会被误删 (含正在播放的当前会话段,
                # 一轮对话远短于 TTL)
                if os.path.isfile(fpath) and now - os.path.getmtime(fpath) > ttl:
                    os.unlink(fpath)
                    deleted += 1
            except OSError:
                continue
        return deleted

    def _ensure_cache_dir(self) -> None:
        os.makedirs(self.cfg.tts_cache_dir, exist_ok=True)

    def _peek_format(self) -> str:
        """预先猜音频格式: 默认后端对应的格式. 用于缓存命中检查."""
        backend = (self.cfg.tts_backend or "auto").lower()
        if backend in ("pyttsx3", "cosyvoice", "melo"):
            return "wav"
        if backend == "auto":
            # auto: 按注册顺序首个可用后端 (cosyvoice > edge > melo > pyttsx3)
            # 猜错格式会导致缓存永不命中 (找 .mp3 实际写的是 .wav)
            try:
                available = list_available_backends(self.cfg)
                if available and available[0] in ("cosyvoice", "melo", "pyttsx3"):
                    return "wav"
            except Exception:
                pass
        # edge 默认 mp3
        return "mp3"

    def _count_cache_files(self) -> int:
        cache_dir = self.cfg.tts_cache_dir
        if not os.path.isdir(cache_dir):
            return 0
        return sum(1 for n in os.listdir(cache_dir) if os.path.isfile(os.path.join(cache_dir, n)))

    def _estimate_duration(self, text: str, size: int, audio_fmt: str,
                           path: str | None = None) -> int | None:
        """估算音频时长 (ms) — 缓存命中路径用 (新合成走 client 的精确估算).

        wav: 解析文件头实际采样率/位深 (cosyvoice 24kHz / pyttsx3 22050Hz /
             其他 16kHz 均准确); 头解析失败回退 16kHz 假设。
        mp3: 按 ~32kbps 估算 (前端播放时会用 audio.duration 实测校正)。
        """
        if audio_fmt == "wav":
            if path and os.path.isfile(path):
                try:
                    import struct
                    with open(path, "rb") as f:
                        head = f.read(44)
                    if head[:4] == b"RIFF" and head[8:12] == b"WAVE" and len(head) >= 36:
                        sample_rate = struct.unpack("<I", head[24:28])[0]
                        bits = struct.unpack("<H", head[34:36])[0]
                        if sample_rate > 0 and bits > 0:
                            return int(max(0, size - 44) * 1000 / (sample_rate * bits / 8))
                except (OSError, struct.error):
                    pass
            return int((size - 44) * 1000 / 32000) if size > 44 else None
        # mp3 @ ~32kbps
        return int(size * 8 * 1000 / 32000)


# ============ 便捷函数 — 业务侧一行调用 ============

_default_broadcaster: TTSBroadcaster | None = None
_default_lock = threading.Lock()


def speak(text: str, **opts) -> SpeakResult:
    """全局便捷函数 — 不需要 TTSBroadcaster() 实例化, 直接调 speak("...").

    等价于: TTSBroadcaster().speak(text, **opts)
    """
    global _default_broadcaster
    if _default_broadcaster is None:
        with _default_lock:
            if _default_broadcaster is None:
                _default_broadcaster = TTSBroadcaster()
    return _default_broadcaster.speak(text, **opts)
