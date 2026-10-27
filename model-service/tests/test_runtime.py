import sys
from types import SimpleNamespace

import pytest

from model_service.config import Settings
from model_service.laya_runtime import LayaRuntime


def test_missing_assets_fail_before_import(tmp_path):
    runtime = LayaRuntime(Settings(tmp_path, "cpu", "127.0.0.1", 8030))
    with pytest.raises(FileNotFoundError, match="model-download"):
        runtime.load()


def test_loads_local_assets_and_warms_once(tmp_path, monkeypatch):
    for name in [
        "config.json",
        "rl_agent_config.json",
        "model.safetensors",
        "encoder/config.json",
        "tokenizer/tokenizer.json",
    ]:
        path = tmp_path / name
        path.parent.mkdir(exist_ok=True)
        path.touch()
    calls = []
    agent = SimpleNamespace(
        predict=lambda state, questions: calls.append(state) or {"answers": {}}
    )

    def load(path, device):
        assert path == str(tmp_path)
        assert device == "cpu"
        return agent

    monkeypatch.setitem(sys.modules, "laya", SimpleNamespace(load=load))
    runtime = LayaRuntime(Settings(tmp_path, "cpu", "127.0.0.1", 8030))
    runtime.load()
    assert calls == ["你好"]
    runtime.predict("测试", {})
    assert calls == ["你好", "测试"]
    runtime.close()
    assert runtime.agent is None
