"""The Laya adapter owns loading, warm-up and prediction."""

import os

from .config import Settings

WARM_QUESTIONS = {
    "ready": {
        "type": "choice",
        "instructions": "Is the user greeting someone?",
        "criteria": {"yes": "A greeting", "no": "Other speech"},
    },
}


class LayaRuntime:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.agent = None

    def load(self):
        # Set before importing transformers; use only pre-downloaded local assets.
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        os.environ["USE_TF"] = "0"
        for asset in [
            "config.json",
            "rl_agent_config.json",
            "model.safetensors",
            "encoder/config.json",
            "tokenizer/tokenizer.json",
        ]:
            if not (self.settings.model_dir / asset).is_file():
                raise FileNotFoundError("Run uv run model-download before starting")
        import laya

        self.agent = laya.load(
            str(self.settings.model_dir), device=self.settings.device
        )
        self.agent.predict("你好", WARM_QUESTIONS)

    def predict(self, state, questions):
        return self.agent.predict(state, questions)

    def close(self):
        self.agent = None
