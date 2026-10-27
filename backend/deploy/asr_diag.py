# -*- coding: utf-8 -*-
"""ASR 服务端诊断脚本 — 在部署服务器上运行, 定位 "识别结果为空" 的根因.

用法 (服务器上):
  1) 把官方测试音频下到脚本同目录 (已知内容: 中文语音, 应能正常转写):
     curl -O https://qianwen-res.oss-cn-beijing.aliyuncs.com/Qwen3-ASR-Repo/asr_zh.wav
  2) python3 deploy/asr_diag.py [服务地址, 默认 http://127.0.0.1:8005]

判读:
  [2] chat_completions 有正常文本 → 服务端 OK, 问题在前端音频
      (麦克风权限/静音段, 看 /api/voice/asr 上传的 wav 大小: 3s@16k16bit 应 ~96KB)
  [2] content 为空 ('' 或 None) → 服务端音频管线问题
      → 把 [1][2][3] 完整输出 + `docker logs --tail 50 <asr容器>` 发我
"""
import base64
import json
import sys
import urllib.error
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8005").rstrip("/")
WAV = "asr_zh.wav"


def _get_json(url, timeout=30):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode())


def _post_json(url, payload, timeout=300):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def main():
    # [1] 服务与 served-model-name (客户端请求体里的 model 必须与之一致)
    models = _get_json(BASE + "/v1/models")
    model_id = models["data"][0]["id"]
    print("[1] /v1/models ->", json.dumps(models, ensure_ascii=False))

    with open(WAV, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    print("    测试音频:", WAV, f"({len(b64) * 3 // 4 // 1024} KB)")

    # [2] chat completions + base64 audio_url (与 voice/asr_client.py 完全同款请求)
    payload = {
        "model": model_id,
        "messages": [{"role": "user", "content": [
            {"type": "audio_url",
             "audio_url": {"url": "data:audio/wav;base64," + b64}}]}],
        "temperature": 0.0,
        "max_tokens": 512,
    }
    resp = _post_json(BASE + "/v1/chat/completions", payload)
    choice = resp["choices"][0]
    print("[2] chat_completions content =", repr(choice["message"]["content"]))
    print("    finish_reason =", choice.get("finish_reason"),
          "| usage =", resp.get("usage"))

    # [3] OpenAI 兼容 STT 端点 (vLLM 原生 speech_to_text 路径, 不走 chat 模板)
    boundary = "diagbound123"
    parts = [
        ("--%s\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\n%s\r\n"
         % (boundary, model_id)),
        ("--%s\r\nContent-Disposition: form-data; name=\"file\"; "
         "filename=\"a.wav\"\r\nContent-Type: audio/wav\r\n\r\n" % boundary),
    ]
    with open(WAV, "rb") as f:
        wav_bytes = f.read()
    body = parts[0].encode() + parts[1].encode() + wav_bytes + \
        ("\r\n--%s--\r\n" % boundary).encode()
    req = urllib.request.Request(
        BASE + "/v1/audio/transcriptions", data=body,
        headers={"Content-Type": "multipart/form-data; boundary=" + boundary})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            print("[3] transcriptions ->", r.read().decode("utf-8")[:500])
    except urllib.error.HTTPError as e:
        print("[3] transcriptions HTTP %d: %s" % (e.code, e.read().decode("utf-8")[:300]))


if __name__ == "__main__":
    main()
