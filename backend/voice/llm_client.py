# -*- coding: utf-8 -*-
"""LLM 客户端: 主 LLM (Function Calling) + 次级 LLM (结构化数据生成).

后端为 OpenAI 兼容接口 (自托管 vLLM 或云端网关, 见 voice/config.py)。
思考型模型默认输出推理内容, 语音场景通过 LLM_ENABLE_THINKING=0 (默认)
关闭: 自托管 Qwen3 经 chat_template_kwargs, 云端 DeepSeek 系经
thinking.type=disabled (LLM_THINKING_STYLE 控制风格); 低层另做
_strip_think 兜底剥离。流式响应统一按 UTF-8 解码 (SSE 头可能无 charset,
requests 默认按 ISO-8859-1 解码会把中文变乱码)。
用 requests 调用, 失败重试, JSON 解析容错.
"""
import json
import re
import time
from typing import Any

import requests

from .config import get_config


class LLMError(Exception):
    pass


# Qwen3 思考块标签 (拼接构造, 避免源码出现字面量标签被误处理)
_T_OPEN, _T_CLOSE = "<" + "think" + ">", "</" + "think" + ">"
_THINK_BLOCK_RE = re.compile(re.escape(_T_OPEN) + r".*?" + re.escape(_T_CLOSE),
                             re.DOTALL)


def _strip_think(text: str) -> str:
    """去掉 Qwen3 思考块 (关闭思考后的兜底; 流中断时可能残留未闭合标签)."""
    if not text:
        return text
    text = _THINK_BLOCK_RE.sub("", text)
    if text.lstrip().startswith(_T_OPEN):
        text = text.lstrip()[len(_T_OPEN):].lstrip()
    return text.strip()


def _apply_thinking_flag(payload: dict[str, Any], enable_thinking: bool,
                         style: str = "both"):
    """思考模式开关: 关闭时按风格下发参数, 服务端不认识则忽略, 无副作用.

    - qwen: chat_template_kwargs.enable_thinking (自托管 vLLM Qwen3 模板开关)
    - deepseek: thinking.type=disabled (云端网关 DeepSeek 系生效)
    """
    if enable_thinking:
        return
    if style in ("qwen", "both"):
        payload["chat_template_kwargs"] = {"enable_thinking": False}
    if style in ("deepseek", "both"):
        payload["thinking"] = {"type": "disabled"}


def _chat(base_url: str, api_key: str, model: str, messages: list[dict],
          tools: list[dict] | None = None, temperature: float = 0.3,
          timeout: float = 30.0, max_retries: int = 2,
          enable_thinking: bool = True, thinking_style: str = "both") -> dict:
    """OpenAI 兼容 /v1/chat/completions 调用, 返回原始响应 JSON."""
    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "stream": False,
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"
    _apply_thinking_flag(payload, enable_thinking, thinking_style)
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    last_err = None
    for attempt in range(max_retries + 1):
        try:
            resp = requests.post(
                f"{base_url}/chat/completions",
                json=payload,
                headers=headers,
                timeout=timeout,
            )
            if resp.status_code != 200:
                raise LLMError(f"LLM 返回 {resp.status_code}: {resp.text[:300]}")
            data = resp.json()
            # 兜底: 统一剥离思考块, 主/次级两个消费方都拿干净文本
            try:
                msg = data["choices"][0]["message"]
                msg["content"] = _strip_think(msg.get("content") or "")
            except (KeyError, IndexError):
                pass
            return data
        except requests.RequestException as e:
            last_err = e
            if attempt < max_retries:
                time.sleep(0.8 * (attempt + 1))
            continue
    raise LLMError(f"LLM 调用失败 (重试 {max_retries} 次): {last_err}")


def _chat_stream(base_url: str, api_key: str, model: str, messages: list[dict],
                 tools: list[dict] | None = None, temperature: float = 0.3,
                 timeout: float = 30.0, max_retries: int = 2,
                 out: dict | None = None, enable_thinking: bool = True,
                 thinking_style: str = "both"):
    """OpenAI 兼容流式 /v1/chat/completions (SSE)。

    生成器: 每次产出 content 增量文本 (str); 流结束后把聚合结果写入 ``out``:
        out["reply"]         完整自然语言回复 (str, 已 strip)
        out["tool_calls_raw"] [{"name", "arguments": str}, ...] 按 index 排序

    重试语义: 尚未收到任何数据前连接失败 → 整流重试 (同 _chat 退避);
              已产出数据后流中断 → 直接抛 LLMError (避免重复输出)。
    """
    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "stream": True,
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"
    _apply_thinking_flag(payload, enable_thinking, thinking_style)
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
    }
    last_err = None
    for attempt in range(max_retries + 1):
        content_parts: list[str] = []
        tool_acc: dict[int, dict] = {}  # index -> {"name", "arguments"(累积 str)}
        got_data = False
        try:
            resp = requests.post(
                f"{base_url}/chat/completions",
                json=payload,
                headers=headers,
                timeout=timeout,
                stream=True,
            )
            if resp.status_code != 200:
                raise LLMError(f"LLM 返回 {resp.status_code}: {resp.text[:300]}")
            # SSE 响应头常不带 charset, requests 对 text/* 按旧规范默认 ISO-8859-1
            # 解码, 中文 UTF-8 会变 mojibake; OpenAI 兼容流式协议固定 UTF-8
            resp.encoding = "utf-8"
            try:
                for line in resp.iter_lines(decode_unicode=True):
                    if not line or not line.startswith("data:"):
                        continue
                    data = line[len("data:"):].strip()
                    if data == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    got_data = True
                    choice = (chunk.get("choices") or [{}])[0]
                    delta = choice.get("delta") or {}
                    piece = delta.get("content")
                    if piece:
                        content_parts.append(piece)
                        yield piece
                    # 流式工具调用协议: 每个增量片段带 index, name 首见生效,
                    # arguments 分片累积拼接
                    for tc in delta.get("tool_calls") or []:
                        idx = int(tc.get("index") or 0)
                        acc = tool_acc.setdefault(idx, {"name": "", "arguments": ""})
                        fn = tc.get("function") or {}
                        if fn.get("name") and not acc["name"]:
                            acc["name"] = fn["name"]
                        if fn.get("arguments"):
                            acc["arguments"] += fn["arguments"]
            except requests.RequestException as e:
                if got_data:
                    raise LLMError(f"LLM 流中断: {e}") from e
                raise  # 尚无数据 → 外层整体重试
            if out is not None:
                # reply 会被 TTS 播报, 统一剥离思考块
                out["reply"] = _strip_think("".join(content_parts))
                out["tool_calls_raw"] = [tool_acc[i] for i in sorted(tool_acc)]
            return
        except LLMError:
            raise
        except requests.RequestException as e:
            last_err = e
            if attempt < max_retries:
                time.sleep(0.8 * (attempt + 1))
            continue
    raise LLMError(f"LLM 调用失败 (重试 {max_retries} 次): {last_err}")


class MainLLMClient:
    """主 LLM: 意图判断 + Function Calling."""

    def __init__(self, config=None):
        self.cfg = config or get_config()

    def chat(self, system_prompt: str, user_text: str, rag_context: str,
             tools: list[dict]) -> dict:
        """返回 {"reply": str, "tool_calls": list[dict] | None}.

        reply: 主 LLM 自然语言回复 (无工具调用时直接给用户)
        tool_calls: 需要调用工具时, [{"name", "arguments": {...}}]
        """
        messages = self._build_messages(system_prompt, user_text, rag_context)
        raw = _chat(
            self.cfg.main_llm_base_url,
            self.cfg.main_llm_api_key,
            self.cfg.main_llm_model,
            messages,
            tools=tools,
            temperature=self.cfg.main_llm_temperature,
            timeout=self.cfg.main_llm_timeout,
            max_retries=self.cfg.max_retries,
            enable_thinking=self.cfg.llm_enable_thinking,
            thinking_style=self.cfg.llm_thinking_style,
        )
        choice = raw["choices"][0]["message"]
        reply = (choice.get("content") or "").strip()
        tool_calls_raw = choice.get("tool_calls")
        tool_calls: list[dict] = []
        if tool_calls_raw:
            for tc in tool_calls_raw:
                fn = tc.get("function", {})
                name = fn.get("name", "")
                arg_str = fn.get("arguments", "{}")
                args = self._parse_tool_args(arg_str)
                if name:
                    tool_calls.append({"name": name, "arguments": args})
        return {"reply": reply, "tool_calls": tool_calls}

    def chat_stream(self, system_prompt: str, user_text: str, rag_context: str,
                    tools: list[dict], out: dict):
        """流式版 chat: 生成器逐段产出 reply 增量文本。

        流结束后把与 chat() 同构的结果写入 ``out``:
            out["reply"]         完整回复
            out["tool_calls"]    [{"name", "arguments": {...}}]
        (工具调用参数按流式协议分片累积, 打字机只打自然语言文本。)
        """
        messages = self._build_messages(system_prompt, user_text, rag_context)
        raw_out: dict = {}
        for delta in _chat_stream(
                self.cfg.main_llm_base_url,
                self.cfg.main_llm_api_key,
                self.cfg.main_llm_model,
                messages,
                tools=tools,
                temperature=self.cfg.main_llm_temperature,
                timeout=self.cfg.main_llm_timeout,
                max_retries=self.cfg.max_retries,
                out=raw_out,
                enable_thinking=self.cfg.llm_enable_thinking,
                thinking_style=self.cfg.llm_thinking_style,
        ):
            yield delta
        tool_calls: list[dict] = []
        for tc in raw_out.get("tool_calls_raw") or []:
            name = tc.get("name", "")
            arg_str = tc.get("arguments", "{}")
            if not name:
                continue
            tool_calls.append({"name": name,
                               "arguments": self._parse_tool_args(arg_str)})
        out["reply"] = raw_out.get("reply", "")
        out["tool_calls"] = tool_calls

    @staticmethod
    def _build_messages(system_prompt: str, user_text: str,
                        rag_context: str) -> list[dict]:
        messages = [
            {"role": "system", "content": system_prompt},
        ]
        if rag_context:
            messages.append({"role": "system", "content": rag_context})
        messages.append({"role": "user", "content": user_text})
        return messages

    @staticmethod
    def _parse_tool_args(arg_str: str) -> dict:
        try:
            return json.loads(arg_str) if arg_str else {}
        except json.JSONDecodeError:
            # LLM 偶尔输出非标准 JSON, 宽容解析
            return _lenient_json(arg_str)


class SecondaryLLMClient:
    """次级 LLM: 按 JSON Schema 生成结构化数据 (instruction-input-output)."""

    def __init__(self, config=None):
        self.cfg = config or get_config()

    def generate_structured(self, user_text: str, rag_context: str,
                            tool_name: str, schema: dict,
                            main_reply: str) -> dict:
        """返回 {"instruction", "input", "output"} 符合 schema 的结构化数据.

        output 字段含可执行的工具参数. 输出纯 JSON, 解析失败抛 LLMError.
        """
        sys_prompt = (
            "你是中式八球 AI 教练的数据生成助手。根据用户指令、知识库参考和主 LLM 的判断, "
            "生成符合 JSON Schema 的结构化数据, 格式为 instruction-input-output。\n"
            "要求:\n"
            "1. instruction: 用户意图的标准化描述\n"
            "2. input: 用户原始指令文本\n"
            "3. output: 可执行的工具参数 JSON, 必须严格符合下方 Schema\n"
            "4. 只输出纯 JSON, 不要 markdown 代码块, 不要多余解释\n"
            f"\n当前工具: {tool_name}\n"
            f"输出 Schema:\n{json.dumps(schema, ensure_ascii=False, indent=2)}\n"
        )
        user_msg = (
            f"用户指令: {user_text}\n"
            f"主 LLM 回复: {main_reply}\n"
            f"{rag_context}\n"
            f"\n请生成结构化 JSON (instruction/input/output)。"
        )
        raw = _chat(
            self.cfg.secondary_llm_base_url,
            self.cfg.secondary_llm_api_key,
            self.cfg.secondary_llm_model,
            [
                {"role": "system", "content": sys_prompt},
                {"role": "user", "content": user_msg},
            ],
            tools=None,
            temperature=self.cfg.secondary_llm_temperature,
            timeout=self.cfg.secondary_llm_timeout,
            max_retries=self.cfg.max_retries,
            enable_thinking=self.cfg.llm_enable_thinking,
            thinking_style=self.cfg.llm_thinking_style,
        )
        content = (raw["choices"][0]["message"].get("content") or "").strip()
        data = _extract_json(content)
        if data is None:
            raise LLMError(f"次级 LLM 输出 JSON 解析失败: {content[:200]}")
        # 校验必备字段
        for k in ("instruction", "input", "output"):
            if k not in data:
                raise LLMError(f"次级 LLM 输出缺少字段 {k}")
        return data


def _extract_json(text: str) -> dict | None:
    """从 LLM 输出中提取 JSON (容忍 ```json 代码块包裹)."""
    if not text:
        return None
    # 去掉 markdown 代码块
    m = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
    if m:
        text = m.group(1).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # 容忍尾随逗号
    cleaned = re.sub(r",\s*([}\]])", r"\1", text)
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        return _lenient_json(text)


def _lenient_json(text: str) -> dict | None:
    """宽松 JSON 解析: 提取第一个 {...} 块."""
    if not text:
        return {}
    start = text.find("{")
    if start < 0:
        return {}
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                chunk = text[start:i + 1]
                try:
                    return json.loads(re.sub(r",\s*([}\]])", r"\1", chunk))
                except json.JSONDecodeError:
                    return {}
    return {}
