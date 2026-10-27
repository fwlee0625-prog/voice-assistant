"""Warm Smart Turn v3.2 CPU worker. Only bounded PCM and scores cross stdio.
Feature extraction follows pipecat-ai/smart-turn inference.py (BSD-2-Clause).
"""
import base64
import json
import os
import sys
os.environ["USE_TORCH"] = "0"
os.environ["TOKENIZERS_PARALLELISM"] = "false"
import numpy as np
import onnxruntime as ort
from transformers import WhisperFeatureExtractor
ort.disable_telemetry_events()

options = ort.SessionOptions()
options.intra_op_num_threads = 1
options.inter_op_num_threads = 1
options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
session = ort.InferenceSession(sys.argv[1], sess_options=options, providers=["CPUExecutionProvider"])
extractor = WhisperFeatureExtractor(chunk_length=8)
# Warm up using synthetic silence; no model or processor downloads at runtime.
def predict(pcm):
    audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
    audio = audio[-128000:]
    features = extractor(audio, sampling_rate=16000, return_tensors="np",
                         padding="max_length", max_length=128000,
                         truncation=True, do_normalize=True).input_features.astype(np.float32)
    return float(session.run(None, {"input_features": features})[0].reshape(-1)[0])
predict(bytes(32000))
print(json.dumps({"ready": True}), flush=True)
for line in sys.stdin:
    try:
        if len(line) > 360000:
            raise ValueError("too large")
        request = json.loads(line)
        pcm = base64.b64decode(request["audio"], validate=True)
        if not 8000 <= len(pcm) <= 256000 or len(pcm) % 2:
            raise ValueError("invalid PCM")
        probability = predict(pcm)
        print(json.dumps({"id": request["id"], "probability": probability}), flush=True)
    except Exception:
        print(json.dumps({"id": locals().get("request", {}).get("id"), "error": True}), flush=True)
