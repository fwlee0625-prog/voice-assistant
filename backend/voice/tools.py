# -*- coding: utf-8 -*-
"""Function Calling 工具定义 + 执行器.

工具:
  1. get_shot_recommendation — 调用几何规划器给击球方案
  2. simulate_shot          — 调 PyBullet 物理仿真轨迹
  3. set_table_layout       — 摆球局 (标准开局/随机/自定义)

执行器通过依赖注入接收 planner / simulator 回调, 避免与 web.server 循环导入.
"""
from typing import Any, Callable

# ============ OpenAI Function Calling 工具描述 ============
TOOL_DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": "get_shot_recommendation",
            "description": "获取中式八球击球方案推荐。当用户想了解怎么打、推荐击球、AI 教练建议、清台路线时调用。",
            "parameters": {
                "type": "object",
                "properties": {
                    "balls": {
                        "type": "array",
                        "description": "当前台面所有球的位置, 每个元素 {id, x, y, alive}. id=0 是母球, 1-15 是目标球",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {"type": "integer"},
                                "x": {"type": "number"},
                                "y": {"type": "number"},
                                "alive": {"type": "boolean"},
                            },
                        },
                    },
                    "ballType": {
                        "type": "string",
                        "enum": ["auto", "solids", "stripes", "eight"],
                        "description": "本方球色: auto=自动识别, solids=小号1-7, stripes=大号9-15, eight=只剩黑八",
                    },
                    "callPocket": {
                        "type": "integer",
                        "description": "叫袋编号 -1=关闭, 0=左上,1=上中,2=右上,3=左下,4=下中,5=右下",
                    },
                },
                "required": ["balls"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "simulate_shot",
            "description": "对一杆击球做 PyBullet 真实物理仿真, 返回逐帧轨迹。当用户想看击球过程、模拟、轨迹、演示时调用。",
            "parameters": {
                "type": "object",
                "properties": {
                    "balls": {
                        "type": "array",
                        "description": "当前台面所有球位置",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {"type": "integer"},
                                "x": {"type": "number"},
                                "y": {"type": "number"},
                                "alive": {"type": "boolean"},
                            },
                        },
                    },
                    "targetBallId": {"type": "integer", "description": "目标球编号 1-15"},
                    "pocketIdx": {"type": "integer", "description": "目标袋口 0-5"},
                    "forceNewtons": {"type": "number", "description": "击球力度 (N), 25-100"},
                    "strikeDx": {"type": "number", "description": "水平击球偏移 (-0.1~0.1)"},
                    "strikeDy": {"type": "number", "description": "垂直击球偏移 (-0.1~0.1)"},
                },
                "required": ["balls", "targetBallId", "pocketIdx", "forceNewtons", "strikeDx", "strikeDy"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_table_layout",
            "description": "摆球局。当用户说开局、重置、随机球局、标准三角阵时调用。",
            "parameters": {
                "type": "object",
                "properties": {
                    "layoutType": {
                        "type": "string",
                        "enum": ["default", "rack", "random"],
                        "description": "default=标准三角阵开局, rack=同 default, random=母球D区+1-15号随机散落",
                    },
                },
                "required": ["layoutType"],
            },
        },
    },
]

# ============ 次级 LLM 结构化数据 Schema (instruction-input-output 中 output 的格式) ============
TOOL_SCHEMAS = {
    "get_shot_recommendation": {
        "type": "object",
        "properties": {
            "balls": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "integer"},
                        "x": {"type": "number"},
                        "y": {"type": "number"},
                        "alive": {"type": "boolean"},
                    },
                },
            },
            "ballType": {"type": "string", "enum": ["auto", "solids", "stripes", "eight"]},
            "callPocket": {"type": "integer"},
        },
        "required": ["balls"],
    },
    "simulate_shot": {
        "type": "object",
        "properties": {
            "balls": {"type": "array"},
            "targetBallId": {"type": "integer"},
            "pocketIdx": {"type": "integer"},
            "forceNewtons": {"type": "number"},
            "strikeDx": {"type": "number"},
            "strikeDy": {"type": "number"},
        },
        "required": ["balls", "targetBallId", "pocketIdx", "forceNewtons", "strikeDx", "strikeDy"],
    },
    "set_table_layout": {
        "type": "object",
        "properties": {
            "layoutType": {"type": "string", "enum": ["default", "rack", "random"]},
        },
        "required": ["layoutType"],
    },
}


class ToolExecutor:
    """工具执行器: 接收 planner/simulator 回调 (依赖注入), 执行工具调用.

    planner: Callable[[list[dict], str, int], dict]
        (balls, ball_type, call_pocket) -> recommendation result dict
    simulator: Callable[[dict], dict]
        (params dict) -> trajectory result dict
    layout_builder: Callable[[str], list[dict]]
        (layout_type) -> balls list
    """

    def __init__(self,
                 planner: Callable[..., dict] | None = None,
                 simulator: Callable[[dict], dict] | None = None,
                 layout_builder: Callable[[str], list[dict]] | None = None):
        self.planner = planner
        self.simulator = simulator
        self.layout_builder = layout_builder

    def execute(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        if name == "get_shot_recommendation":
            return self._exec_recommend(arguments)
        if name == "simulate_shot":
            return self._exec_simulate(arguments)
        if name == "set_table_layout":
            return self._exec_layout(arguments)
        return {"status": "error", "error": f"未知工具: {name}"}

    def _exec_recommend(self, args: dict) -> dict:
        if self.planner is None:
            return {"status": "error", "error": "规划器未注入"}
        balls = args.get("balls") or []
        ball_type = str(args.get("ballType", "auto"))
        call_pocket = int(args.get("callPocket", -1))
        return self.planner(balls, ball_type, call_pocket)

    def _exec_simulate(self, args: dict) -> dict:
        if self.simulator is None:
            return {"status": "error", "error": "仿真器未注入"}
        return self.simulator(args)

    def _exec_layout(self, args: dict) -> dict:
        if self.layout_builder is None:
            return {"status": "error", "error": "布局构建器未注入"}
        layout_type = str(args.get("layoutType", "default"))
        balls = self.layout_builder(layout_type)
        return {"status": "ok", "layoutType": layout_type, "balls": balls}
