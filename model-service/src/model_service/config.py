"""Service settings and pinned model assets."""

import os
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
REPOSITORY = "convaiinnovations/laya-multilingual"
REVISION = "1720e3e3357cfe1e281542e223f8273b0890ca34"
MODEL_ID = "laya-multilingual"


@dataclass(frozen=True)
class Settings:
    model_dir: Path
    device: str
    host: str
    port: int

    @classmethod
    def from_env(cls):
        port = int(os.getenv("MODEL_SERVICE_PORT", "8030"))
        if not 1 <= port <= 65535:
            raise ValueError("Invalid MODEL_SERVICE_PORT")
        device = os.getenv("LAYA_DEVICE", "cpu")
        if device not in {"cpu", "mps", "cuda"}:
            raise ValueError("LAYA_DEVICE must be cpu, mps or cuda")
        directory = Path(os.getenv("LAYA_MODEL_DIR", "models/laya-multilingual"))
        return cls(
            model_dir=(ROOT / directory).resolve(),
            device=device,
            host=os.getenv("MODEL_SERVICE_HOST", "127.0.0.1"),
            port=port,
        )
