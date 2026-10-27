"""可选台球服务适配器；语音服务不导入台球、视觉或 GPU 引擎。"""
import os
import threading
import requests
from voice import VoicePipeline
from voice.tools import ToolExecutor

_pipeline = None
_lock = threading.Lock()

def _execute(name, arguments):
    base = os.environ.get("BILLIARDS_CORE_URL", "").rstrip("/")
    if not base:
        return {"status": "error", "error": "此工具需要配置 BILLIARDS_CORE_URL 连接台球主服务"}
    try:
        response = requests.post(base + "/api/voice/execute",
            json={"tool_name": name, "arguments": arguments}, timeout=60)
        response.raise_for_status()
        return response.json()
    except (requests.RequestException, ValueError) as exc:
        return {"status": "error", "error": f"台球服务调用失败: {exc}"}

def _voice_planner(balls, ball_type, call_pocket):
    return _execute("get_shot_recommendation", {"balls": balls, "ballType": ball_type, "callPocket": call_pocket})

def _voice_simulator(params):
    return _execute("simulate_shot", params)

def _voice_layout_builder(layout_type):
    result = _execute("set_table_layout", {"layoutType": layout_type})
    if result.get("status") != "ok":
        raise RuntimeError(result.get("error", "台球服务摆球失败"))
    return result["balls"]

def get_voice_pipeline():
    global _pipeline
    with _lock:
        if _pipeline is None:
            _pipeline = VoicePipeline(executor=ToolExecutor(
                planner=_voice_planner, simulator=_voice_simulator,
                layout_builder=_voice_layout_builder))
    return _pipeline
