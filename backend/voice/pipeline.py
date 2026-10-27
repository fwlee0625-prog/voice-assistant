# -*- coding: utf-8 -*-
"""全链路编排: ASR → RAG → 主 LLM(Function Calling) → 次级 LLM(结构化) → 工具执行 → API 响应.

每一步带容错: 任一模型调用失败, 链路降级而非崩溃, 返回友好提示.
"""
import re
import time
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any

from .asr_client import ASRClient, ASRError
from .config import get_config
from .llm_client import MainLLMClient, SecondaryLLMClient, LLMError
from .rag_retriever import RAGRetriever, RAGError
from .tools import TOOL_DEFINITIONS, TOOL_SCHEMAS, ToolExecutor

SYSTEM_PROMPT = """你是「AI 中式八球智能教练」的语音助手, 服务于一个台球教学平台。

你的能力:
1. 推荐击球方案 — 当用户问"这球怎么打""帮我推荐""清台路线"时, 调用 get_shot_recommendation
2. 模拟击球轨迹 — 当用户说"模拟一下""看下轨迹""演示"时, 调用 simulate_shot
3. 摆球局 — 当用户说"标准开局""随机球局""重置"时, 调用 set_table_layout
4. 规则/战术答疑 — 用户问规则、杆法、战术时, 直接基于知识库回答, 不调工具

行为准则:
- 用户没给台面球位置却要推荐/模拟时: 先用自然语言引导用户摆球, 不要硬调工具
- 用户纯闲聊或问规则: 直接回答, 不要调工具
- 回答用中文, 口语化、简洁、专业, 像真实教练在球桌旁说话
- 调工具后, 把工具返回的关键信息用自然语言总结给用户 (比如"建议打3号球进右中袋, 高杆跟杆")
- 参考RAG内容后，不要返回参考了哪些文档名称，用户不关心具体文件
"""


# ============================================================
# 流式句子切分器 — 主 LLM 增量文本 → 完整句子序列 (句子级流式 TTS 用)
# ============================================================

# 句末标点: 出现即成句 (贪婪吞掉连续标点, 如 "！！！" 归入同一句)
_SENT_END_RE = re.compile(r"[。！？!?…；;\n]+")
# 软边界: 超长句回退切分点
_SENT_SOFT_RE = re.compile(r"[，、,]")
# Qwen3 思考块标签 (拼接构造, 与 llm_client 保持一致, 避免循环导入)
_T_OPEN, _T_CLOSE = "<" + "think" + ">", "</" + "think" + ">"


def _tail_tag_prefix_len(s: str, tag: str) -> int:
    """返回 s 尾部匹配 tag 真前缀的最大长度 (0 = 无).

    用于跨增量片段的标签识别: "<th" + "ink>" 两次到达时, 第一次尾部保留待拼全.
    """
    for k in range(min(len(s), len(tag) - 1), 0, -1):
        if s.endswith(tag[:k]):
            return k
    return 0


class _StreamSentenceSplitter:
    """流式文本 → 句子序列.

    feed() 逐段喂入 LLM 增量, 吐出已达边界的完整句子 (含标点);
    flush() 在流结束时吐出尾部残句. 特性:
      - 句末标点 (。！？!?…；;\\n) 立即成句
      - 连续 max_chars 字无句末标点 → 回退到最后一个软边界 (，、,;) 切, 无则硬切
      - 剥离 Qwen3 思考块 <think>...</think> (防御; 思考模式默认已关闭)
    """

    def __init__(self, max_chars: int = 40):
        self.max_chars = max(8, int(max_chars))
        self._buf = ""        # 待切分可见文本
        self._raw = ""        # 原始累积 (处理跨片标签)
        self._in_think = False

    def _consume_think(self, delta: str) -> str:
        """增量剥离思考块, 返回本次可进入句切分的可见文本."""
        self._raw += delta
        visible: list[str] = []
        progressed = True
        while progressed:
            progressed = False
            if self._in_think:
                idx = self._raw.find(_T_CLOSE)
                if idx >= 0:
                    self._raw = self._raw[idx + len(_T_CLOSE):]
                    self._in_think = False
                    progressed = True
                else:
                    # 未闭合: 只保留可能拼成闭合标签的尾部前缀
                    keep = _tail_tag_prefix_len(self._raw, _T_CLOSE)
                    self._raw = self._raw[len(self._raw) - keep:] if keep else ""
            else:
                idx = self._raw.find(_T_OPEN)
                if idx >= 0:
                    visible.append(self._raw[:idx])
                    self._raw = self._raw[idx + len(_T_OPEN):]
                    self._in_think = True
                    progressed = True
                else:
                    # 无开始标签: 尾部可能是不完整的开始标签, 保留待下轮
                    keep = _tail_tag_prefix_len(self._raw, _T_OPEN)
                    cut = len(self._raw) - keep
                    if cut > 0:
                        visible.append(self._raw[:cut])
                        self._raw = self._raw[cut:]
        return "".join(visible)

    def feed(self, delta: str) -> list[str]:
        vis = self._consume_think(delta or "")
        if not vis:
            return []
        self._buf += vis
        return self._drain(force=False)

    def flush(self) -> list[str]:
        # 流结束: 残留 raw 里的未完整标签按可见文本处理 (防御性兜底)
        if self._raw and not self._in_think:
            self._buf += self._raw
        self._raw = ""
        sents = self._drain(force=True)
        if self._buf:
            sents.append(self._buf)
            self._buf = ""
        return sents

    def _drain(self, force: bool) -> list[str]:
        sents: list[str] = []
        while True:
            m = _SENT_END_RE.search(self._buf)
            if m:
                sents.append(self._buf[:m.end()])
                self._buf = self._buf[m.end():]
                continue
            if len(self._buf) >= self.max_chars:
                # 超长无句末标点: 最后一个软边界切 (尽量保句长), 无则硬切
                soft_pos = [sm.end() for sm in _SENT_SOFT_RE.finditer(self._buf)]
                cut = soft_pos[-1] if soft_pos else self.max_chars
                if cut <= 0:
                    cut = self.max_chars
                sents.append(self._buf[:cut])
                self._buf = self._buf[cut:]
                continue
            break
        if force and self._buf.strip():
            sents.append(self._buf)
            self._buf = ""
        return [s for s in sents if s.strip()]


@dataclass
class VoiceResult:
    """全链路标准化响应."""
    status: str = "ok"  # ok / partial / error
    asr_text: str = ""
    rag_context: list[dict] = field(default_factory=list)
    tool_call: dict | None = None  # {"name", "arguments"}
    structured_data: dict | None = None  # instruction-input-output
    reply: str = ""  # 主 LLM 最终自然语言回复
    execution_result: dict | None = None  # 工具执行结果
    audio: dict | None = None  # TTS 播报结果: {audio_url, audio_format, backend, duration_ms, cached, error}
    errors: list[str] = field(default_factory=list)
    latency_ms: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "status": self.status,
            "asr_text": self.asr_text,
            "rag_context": self.rag_context,
            "tool_call": self.tool_call,
            "structured_data": self.structured_data,
            "reply": self.reply,
            "execution_result": self.execution_result,
            "audio": self.audio,
            "errors": self.errors,
            "latency_ms": self.latency_ms,
        }


class VoicePipeline:
    """全链路编排器."""

    def __init__(self,
                 asr: ASRClient | None = None,
                 rag: RAGRetriever | None = None,
                 main_llm: MainLLMClient | None = None,
                 secondary_llm: SecondaryLLMClient | None = None,
                 executor: ToolExecutor | None = None,
                 tts_broadcaster=None,
                 config=None):
        self.cfg = config or get_config()
        self.asr = asr or ASRClient(self.cfg)
        self.rag = rag or RAGRetriever(self.cfg)
        self.main_llm = main_llm or MainLLMClient(self.cfg)
        self.secondary_llm = secondary_llm or SecondaryLLMClient(self.cfg)
        self.executor = executor or ToolExecutor()
        # TTS 广播器懒加载 — 调 speak() 时才初始化, 避免启动时无谓加载
        self._tts = tts_broadcaster  # None 时首次播音时自动创建单例

    # ---------- 主入口 ----------

    def run(self, text: str | None = None, audio_bytes: bytes | None = None,
            fmt: str = "wav", enable_tts: bool = True) -> VoiceResult:
        """非流式全链路 (薄壳): 消费 run_stream 事件流, 返回最终 VoiceResult。

        与流式路径共用同一实现, 保证两条链路行为一致;
        stream_tts=False → 不做句子级合成, done 时整段合成 (非流式契约)。
        """
        result = None
        for ev in self.run_stream(text=text, audio_bytes=audio_bytes,
                                  fmt=fmt, enable_tts=enable_tts,
                                  stream_tts=False):
            if ev.get("type") == "done":
                result = ev.get("result")
        if result is None:      # 理论上不会发生 (所有分支必产出 done)
            result = VoiceResult()
            result.status = "error"
            result.errors.append("语音链路未产出结果")
        return result

    def run_stream(self, text: str | None = None,
                   audio_bytes: bytes | None = None,
                   fmt: str = "wav", enable_tts: bool = True,
                   stream_tts: bool = True):
        """流式全链路: 生成器逐个产出事件 dict (路由层序列化为 SSE)。

        事件协议 (type 字段区分):
            {"type": "asr",   "text": "..."}     ASR 识别结果 (音频输入时)
            {"type": "stage", "text": "..."}     阶段提示 (检索/思考/工具/TTS)
            {"type": "delta", "text": "..."}     主 LLM 回复增量 (打字机)
            {"type": "audio", "url": "...", "text": "...", "duration_ms": int,
                            "index": int}        句子级 TTS 音频段 (流式播报,
                                                前端按序播放, 打字机跟进度走)
            {"type": "done",  "result": VoiceResult}  最终结果 (调用方 to_dict)

        stream_tts=True (默认, SSE 路由) 时句子级流式合成: 已产出过 audio 事件
        则 done 不再整段合成 (result.audio 标记 streamed, audio_url 为空);
        stream_tts=False (非流式 run) 保持整段合成契约。

        任一环节失败均以 done(result.status=error/partial) 收尾而非抛出,
        与原 run() 契约一致; 生成器本体崩溃由路由层兜底为 error 事件。
        """
        result = VoiceResult()
        t0 = time.time()

        # 1. ASR (仅音频输入)
        if text is None:
            if audio_bytes is None:
                result.status = "error"
                result.errors.append("未提供文本或音频")
                result.latency_ms["total"] = int((time.time() - t0) * 1000)
                yield {"type": "done", "result": result}
                return
            try:
                t = time.time()
                text = self.asr.transcribe(audio_bytes, fmt)
                result.latency_ms["asr"] = int((time.time() - t) * 1000)
                yield {"type": "asr", "text": text}
            except ASRError as e:
                result.status = "error"
                result.errors.append(f"语音识别失败: {e}")
                result.reply = f"抱歉, 没听清您说的, 识别失败: {e}"
                result.latency_ms["total"] = int((time.time() - t0) * 1000)
                # ASR 错误不算"LLM 正常响应", 不播音
                yield {"type": "done", "result": result}
                return
        result.asr_text = text

        # 2. RAG 检索 (失败降级, 不中断链路)
        yield {"type": "stage", "text": "正在检索知识库 ..."}
        rag_context_str = ""
        try:
            t = time.time()
            snippets = self.rag.retrieve(text)
            result.latency_ms["rag"] = int((time.time() - t) * 1000)
            result.rag_context = snippets
            rag_context_str = self.rag.format_context(snippets)
        except RAGError as e:
            result.errors.append(f"RAG 检索失败 (已降级): {e}")

        # 3. 主 LLM 意图判断 + Function Calling (流式, 打字机增量)
        yield {"type": "stage", "text": "正在思考 ..."}
        main_out: dict = {}
        t = time.time()

        # ---- 句子级流式 TTS: 凑句即提交后台合成, audio 事件随 delta 交错下发 ----
        # 单线程 executor 保证段序 = 句序 (前端按 index 顺序播放);
        # 合成在后台跑, 不阻塞 delta 产出, 每轮循环前 drain 已完成的段。
        use_stream_tts = (stream_tts and enable_tts and self.cfg.tts_enabled
                          and self.cfg.tts_stream_enabled)
        tts_pool = ThreadPoolExecutor(max_workers=1) if use_stream_tts else None
        splitter = (_StreamSentenceSplitter(self.cfg.tts_stream_seg_max_chars)
                    if use_stream_tts else None)
        tts_queue: list[tuple[Future, str]] = []   # (合成 future, 句子原文), 严格按序
        tts_seg_count = 0        # 已产出 audio 事件数
        tts_first_submit = 0.0   # 首句提交时刻 (latency 统计)

        def _submit_sentence(sent: str) -> None:
            nonlocal tts_first_submit
            if tts_first_submit == 0.0:
                tts_first_submit = time.time()
            tts_queue.append((tts_pool.submit(self._get_tts().speak, sent), sent))

        def _drain_sentences(block: bool):
            """把已完成的句子合成转成 audio 事件 (保序: 前一句未好则停)。

            block=True (流收尾) 时等待队列全部完成; 单句合成失败跳过该段
            (前端该句文字无音频, 打字机直出补齐, 不中断链路)。
            """
            nonlocal tts_seg_count
            while tts_queue:
                fut, sent = tts_queue[0]
                if not fut.done():
                    if not block:
                        return
                    try:
                        fut.result()
                    except Exception:
                        tts_queue.pop(0)
                        continue
                tts_queue.pop(0)
                try:
                    sr = fut.result()
                except Exception:
                    continue
                if sr is not None and sr.status == "ok" and sr.audio_url:
                    yield {"type": "audio", "url": sr.audio_url,
                           "text": sent, "duration_ms": sr.duration_ms or 0,
                           "index": tts_seg_count}
                    tts_seg_count += 1

        try:
            for delta in self.main_llm.chat_stream(
                    SYSTEM_PROMPT, text, rag_context_str, TOOL_DEFINITIONS,
                    out=main_out):
                for ev in _drain_sentences(block=False):
                    yield ev
                yield {"type": "delta", "text": delta}
                if use_stream_tts:
                    for sent in splitter.feed(delta):
                        _submit_sentence(sent)
        except LLMError as e:
            result.status = "error"
            result.errors.append(f"主 LLM 调用失败: {e}")
            result.reply = f"AI 教练暂时开小差了: {e}"
            result.latency_ms["main_llm"] = int((time.time() - t) * 1000)
            result.latency_ms["total"] = int((time.time() - t0) * 1000)
            yield {"type": "done",
                   "result": self._finalize_with_tts(result, t0, tts_eligible=False)}
            return
        finally:
            if tts_pool is not None:
                # 客户端断开 (GeneratorExit) / 异常路径也释放线程池;
                # 在跑的合成跑完自然结束, 不阻塞
                tts_pool.shutdown(wait=False)
        result.latency_ms["main_llm"] = int((time.time() - t) * 1000)
        result.reply = main_out["reply"]
        tool_calls = main_out.get("tool_calls") or []

        # 流式 TTS 收尾: 尾句 flush + 等全部合成完成, 产出剩余 audio 事件
        if use_stream_tts:
            for sent in splitter.flush():
                _submit_sentence(sent)
            for ev in _drain_sentences(block=True):
                yield ev
            if tts_first_submit:
                result.latency_ms["tts"] = int(
                    (time.time() - tts_first_submit) * 1000)

        # 4. 无工具调用 → 直接收尾 (自然语言回复已流式打完)
        if not tool_calls:
            if enable_tts and tts_seg_count == 0:
                yield {"type": "stage", "text": "正在合成语音 ..."}
            result.latency_ms["total"] = int((time.time() - t0) * 1000)
            if tts_seg_count > 0:
                # 句子音频已全部随流下发, 不再整段合成 (避免重复播报)
                result.audio = {"status": "ok", "streamed": True,
                                "segment_count": tts_seg_count, "audio_url": ""}
                yield {"type": "done", "result": result}
            else:
                yield {"type": "done",
                       "result": self._finalize_with_tts(result, t0,
                                                         tts_eligible=enable_tts)}
            return

        # 5. 有工具调用 → 次级 LLM 生成结构化数据 + 执行工具
        tc = tool_calls[0]  # 只取第一个工具调用
        result.tool_call = tc
        tool_name = tc["name"]
        # 主 LLM 给的参数直接作为执行参数 (次级 LLM 主要负责结构化数据产物)
        exec_args = tc.get("arguments", {}) or {}

        yield {"type": "stage", "text": "正在生成击球方案 ..."}
        schema = TOOL_SCHEMAS.get(tool_name, {"type": "object"})
        try:
            t = time.time()
            result.structured_data = self.secondary_llm.generate_structured(
                text, rag_context_str, tool_name, schema, main_out["reply"]
            )
            result.latency_ms["secondary_llm"] = int((time.time() - t) * 1000)
            # 次级 LLM 的 output 若含更完整参数, 优先用
            sec_out = result.structured_data.get("output")
            if isinstance(sec_out, dict) and sec_out:
                # 合并: 次级 output 优先, 主 LLM arguments 补充
                merged = dict(exec_args)
                merged.update({k: v for k, v in sec_out.items() if v is not None})
                exec_args = merged
        except LLMError as e:
            result.errors.append(f"次级 LLM 结构化生成失败 (已降级): {e}")

        # 6. 执行工具
        yield {"type": "stage", "text": "正在执行工具 ..."}
        try:
            t = time.time()
            result.execution_result = self.executor.execute(tool_name, exec_args)
            result.latency_ms["execute"] = int((time.time() - t) * 1000)
            if result.execution_result.get("status") == "error":
                result.status = "partial"
                result.errors.append(f"工具执行失败: {result.execution_result.get('error')}")
        except Exception as e:
            result.status = "partial"
            result.errors.append(f"工具执行异常: {e}")
            result.execution_result = {"status": "error", "error": str(e)}

        # 若主 LLM 没给自然语言回复但有工具执行, 补一句
        if not result.reply and result.execution_result:
            result.reply = self._summarize(tool_name, result.execution_result)

        if enable_tts and tts_seg_count == 0:
            yield {"type": "stage", "text": "正在合成语音 ..."}
        result.latency_ms["total"] = int((time.time() - t0) * 1000)
        if tts_seg_count > 0:
            # 句子音频已随流下发 (主 LLM 的口头说明), 不再整段合成
            result.audio = {"status": "ok", "streamed": True,
                            "segment_count": tts_seg_count, "audio_url": ""}
            yield {"type": "done", "result": result}
        else:
            yield {"type": "done",
                   "result": self._finalize_with_tts(result, t0,
                                                     tts_eligible=enable_tts)}

    def _get_tts(self):
        """懒加载 TTS 广播器 (TTSBroadcaster 自身为线程安全单例)."""
        if self._tts is None:
            from .tts_broadcaster import TTSBroadcaster
            self._tts = TTSBroadcaster(self.cfg)
        return self._tts

    def _finalize_with_tts(self, result: VoiceResult, t0: float,
                           tts_eligible: bool) -> VoiceResult:
        """链路收尾: LLM 正常响应时同步调 TTS 播报.

        TTS 失败不影响主 result.status (仅记 errors / audio.error), 保证用户仍能拿到文本.
        """
        if not tts_eligible or not result.reply or not result.reply.strip():
            return result

        if not self.cfg.tts_enabled:
            return result

        try:
            t = time.time()
            speak_result = self._get_tts().speak(result.reply)
            result.latency_ms["tts"] = int((time.time() - t) * 1000)
            result.audio = speak_result.to_dict()
            if speak_result.status == "error":
                # TTS 失败不阻塞主流程, 只记警告
                result.errors.append(f"TTS 播报失败: {speak_result.error}")
        except Exception as e:
            # 防御性兜底: TTS 任何异常都不能让 pipeline 崩
            result.errors.append(f"TTS 异常 (已忽略): {e}")
        return result

    def _summarize(self, tool_name: str, exec_result: dict) -> str:
        """工具执行后, 给一句默认自然语言总结."""
        if tool_name == "get_shot_recommendation":
            shot = exec_result.get("shot") or {}
            coach = exec_result.get("coach") or {}
            if shot:
                return (f"已为您推荐: 打 {shot.get('targetBall')} 号球进 "
                        f"袋口 {shot.get('pocketIdx')}, {coach.get('headline', '')}")
            return exec_result.get("summary", "推荐已生成")
        if tool_name == "simulate_shot":
            return f"仿真完成, 共 {exec_result.get('frameCount', 0)} 帧, 进袋 {len(exec_result.get('potted', []))} 球"
        if tool_name == "set_table_layout":
            return f"已摆好 {exec_result.get('layoutType', '')} 球局"
        return "操作完成"
