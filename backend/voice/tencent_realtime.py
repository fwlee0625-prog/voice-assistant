"""TRTC v3 realtime ASR bridge. Credentials and UserSig remain on the server."""
import asyncio
import base64
import hashlib
import hmac
import json
import os
import time
import uuid
import zlib
from contextlib import suppress
from urllib.parse import urlsplit

import aiohttp
from fastapi import WebSocket, WebSocketDisconnect


def credentials():
    app_id = os.getenv('TENCENT_TRTC_SDK_APP_ID', '').strip()
    key = os.getenv('TENCENT_TRTC_SECRET_KEY', '').strip()
    if not app_id or not key:
        raise ValueError('请在 backend/.env 配置 TENCENT_TRTC_SDK_APP_ID 和 TENCENT_TRTC_SECRET_KEY')
    if not app_id.isdigit() or int(app_id) <= 0:
        raise ValueError('TENCENT_TRTC_SDK_APP_ID 必须为有效的数字应用 ID')
    return int(app_id), key


def user_sig(app_id: int, key: str, identifier: str, now=None):
    """TLS v2 HMAC-SHA256, per Tencent's tls-sig-api-v2-python specification."""
    stamp = int(time.time()) if now is None else now
    fields = {'TLS.identifier': identifier, 'TLS.sdkappid': app_id,
              'TLS.time': stamp, 'TLS.expire': 86400}
    content = ''.join(f'{name}:{value}\n' for name, value in fields.items())
    signature = base64.b64encode(hmac.new(key.encode(), content.encode(), hashlib.sha256).digest()).decode()
    payload = {'TLS.ver': '2.0', **fields, 'TLS.sig': signature}
    encoded = base64.b64encode(zlib.compress(json.dumps(payload).encode())).decode()
    return encoded.translate(str.maketrans({'+': '*', '/': '-', '=': '_'}))


def allowed_origin(ws):
    origin = ws.headers.get('origin')
    if not origin:
        return False
    parsed = urlsplit(origin)
    if parsed.scheme not in ('http', 'https'):
        return False
    if parsed.netloc == ws.headers.get('host'):
        return True
    # Vite's localhost proxy uses 127.0.0.1:8015 as the upstream Host.
    return (parsed.hostname in ('localhost', '127.0.0.1', '::1')
            and parsed.port == 5178
            and ws.url.hostname in ('localhost', '127.0.0.1', '::1'))


async def realtime_asr(ws: WebSocket):
    if not allowed_origin(ws):
        await ws.close(code=1008)
        return
    await ws.accept()
    tasks = []
    try:
        app_id, key = credentials()
        voice_id = uuid.uuid4().hex
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=None, sock_connect=10)) as session:
            async with session.ws_connect(
                f'wss://asr.cloud-rtc.com/asr/v3?voice_id={voice_id}',
                max_msg_size=1024 * 1024,
            ) as upstream:
                await upstream.send_json({
                    'type': 'start',
                    'auth': {'sdkappid': str(app_id), 'usersig': user_sig(app_id, key, voice_id)},
                    'params': {'voice_id': voice_id, 'engine_model_type': 'bigmodel',
                               'language': 'zh', 'voice_format': 1, 'needvad': 1,
                               'speaker_diarization': 1},
                })
                ack = await upstream.receive_json(timeout=10)
                if ack.get('code') != 0:
                    await ws.send_json({'type': 'error', 'error': f"腾讯云 ASR 鉴权失败（{ack.get('code')}）：{ack.get('message', '')}"})
                    return
                await ws.send_json({'type': 'ready'})

                async def upload():
                    while True:
                        message = await asyncio.wait_for(ws.receive(), timeout=20)
                        if message['type'] == 'websocket.disconnect':
                            return
                        audio = message.get('bytes')
                        if audio is not None:
                            if not audio or len(audio) > 1280 or len(audio) % 2:
                                raise ValueError('音频包必须为不超过 40ms 的 16kHz 单声道 PCM16')
                            await upstream.send_bytes(audio)
                        elif message.get('text'):
                            if json.loads(message['text']) != {'type': 'end'}:
                                raise ValueError('未知识别控制消息')
                            await upstream.send_json({'type': 'end'})
                            # Keep upload alive until upstream final arrives; cap final wait.
                            await asyncio.sleep(15)
                            raise TimeoutError('等待最终识别结果超时')

                async def download():
                    async for message in upstream:
                        if message.type != aiohttp.WSMsgType.TEXT:
                            raise ConnectionError('腾讯云 ASR 连接中断')
                        event = json.loads(message.data)
                        if event.get('code') != 0:
                            await ws.send_json({'type': 'error', 'error': f"腾讯云 ASR 错误（{event.get('code')}）：{event.get('message', '')}"})
                            return
                        result = event.get('result')
                        if result:
                            await ws.send_json({'type': 'result', 'index': result['index'],
                                                'text': result.get('voice_text_str', ''),
                                                'final': result.get('slice_type') == 2,
                                                'speaker_segments': [
                                                    {'speaker_id': part.get('speaker_id', -1),
                                                     'text': part.get('text', ''),
                                                     'stable_flag': part.get('stable_flag', 0)}
                                                    for part in (result.get('speaker_segments') or [])
                                                ]})
                        if event.get('final') == 1:
                            await ws.send_json({'type': 'done'})
                            return
                    raise ConnectionError('腾讯云 ASR 未返回最终结果即断开')

                tasks = [asyncio.create_task(upload()), asyncio.create_task(download())]
                done, _ = await asyncio.wait(tasks, timeout=7200, return_when=asyncio.FIRST_COMPLETED)
                if not done:
                    raise TimeoutError('实时识别已达到两小时时限')
                for task in done:
                    task.result()
    except WebSocketDisconnect:
        pass
    except ValueError as exc:
        with suppress(RuntimeError, WebSocketDisconnect):
            await ws.send_json({'type': 'error', 'error': str(exc)})
    except Exception:
        # Do not expose exceptions containing auth frames, URLs or credentials.
        with suppress(RuntimeError, WebSocketDisconnect):
            await ws.send_json({'type': 'error', 'error': '实时识别连接失败或超时，请检查网络与腾讯云服务配置；原录音仍会保存'})
    finally:
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        with suppress(RuntimeError, WebSocketDisconnect):
            await ws.close()
