"""Explicit asset preparation; inference never downloads models."""

from .config import REPOSITORY, REVISION, Settings


def main():
    from huggingface_hub import snapshot_download

    directory = Settings.from_env().model_dir
    snapshot_download(
        repo_id=REPOSITORY,
        revision=REVISION,
        local_dir=directory,
        allow_patterns=[
            "*.json",
            "encoder/*.json",
            "tokenizer/*.json",
            "*.safetensors",
            "README.md",
        ],
    )
    print(f"Model ready: {directory} (revision {REVISION})")
