"""Fake Tencent upstream: verify protocol without a cloud account or audio upload."""
import asyncio
import base64
import hashlib
import hmac
import json
import os
import unittest
import zlib
from types import SimpleNamespace
from unittest.mock import patch

import aiohttp
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from service.app import app
from voice.tencent_realtime import user_sig


class FakeUpstream:
    def __init__(self, code=0):
        self.code = code
        self.frames = []
        self.audio = []
        self.ended = asyncio.Event()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    async def receive_json(self, **kwargs):
        return {'code': self.code, 'message': 'test response'}

    async def send_json(self, frame):
        self.frames.append(frame)
        if frame['type'] == 'end':
            self.ended.set()

    async def send_bytes(self, audio):
        self.audio.append(audio)

    def __aiter__(self):
        return self.results()

    async def results(self):
        await self.ended.wait()
        for result in [
            {'code': 0, 'result': {'index': 0, 'slice_type': 1, 'voice_text_str': '台'}},
            {'code': 0, 'result': {'index': 0, 'slice_type': 2, 'voice_text_str': '台球',
                                  'speaker_segments': [{'speaker_id': 1, 'text': '台', 'stable_flag': 1},
                                                       {'speaker_id': 2, 'text': '球', 'stable_flag': 1}]}},
            {'code': 0, 'final': 1},
        ]:
            yield SimpleNamespace(type=aiohttp.WSMsgType.TEXT, data=json.dumps(result))


class RealtimeTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app, base_url='http://localhost:8015')
        self.env = patch.dict(os.environ, {'TENCENT_TRTC_SDK_APP_ID': '1400000001',
                                          'TENCENT_TRTC_SECRET_KEY': 'test-only-key'})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.origin = {'origin': 'http://localhost:5178'}

    def test_signature_binds_stream_and_expiry(self):
        sig = user_sig(1400000001, 'test-only-key', 'stream-one', now=1700000000)
        payload = json.loads(zlib.decompress(base64.b64decode(sig.translate(str.maketrans({'*': '+', '-': '/', '_': '='})))))
        self.assertEqual(payload['TLS.identifier'], 'stream-one')
        self.assertEqual(payload['TLS.expire'], 86400)
        signed = 'TLS.identifier:stream-one\nTLS.sdkappid:1400000001\nTLS.time:1700000000\nTLS.expire:86400\n'
        expected = base64.b64encode(hmac.new(b'test-only-key', signed.encode(), hashlib.sha256).digest()).decode()
        self.assertEqual(payload['TLS.sig'], expected)

    def test_missing_credentials_is_explicit(self):
        with patch.dict(os.environ, {'TENCENT_TRTC_SECRET_KEY': ''}):
            with self.client.websocket_connect('ws://localhost:8015/api/voice/asr/realtime', headers=self.origin) as ws:
                event = ws.receive_json()
                self.assertEqual(event['type'], 'error')
                self.assertIn('backend/.env', event['error'])

    def test_untrusted_origin_rejected(self):
        with self.assertRaises(WebSocketDisconnect):
            with self.client.websocket_connect('ws://localhost:8015/api/voice/asr/realtime', headers={'origin': 'https://example.com'}):
                pass

    def test_audio_and_final_result_bridge(self):
        upstream = FakeUpstream()
        with patch('voice.tencent_realtime.aiohttp.ClientSession.ws_connect', return_value=upstream):
            with self.client.websocket_connect('ws://localhost:8015/api/voice/asr/realtime', headers=self.origin) as ws:
                self.assertEqual(ws.receive_json(), {'type': 'ready'})
                ws.send_bytes(b'\x00\x01' * 640)
                ws.send_json({'type': 'end'})
                self.assertEqual(ws.receive_json(), {'type': 'result', 'index': 0, 'text': '台', 'final': False, 'speaker_segments': []})
                self.assertEqual(ws.receive_json(), {'type': 'result', 'index': 0, 'text': '台球', 'final': True,
                                                      'speaker_segments': [{'speaker_id': 1, 'text': '台', 'stable_flag': 1},
                                                                           {'speaker_id': 2, 'text': '球', 'stable_flag': 1}]})
                self.assertEqual(ws.receive_json(), {'type': 'done'})
        self.assertEqual(upstream.audio, [b'\x00\x01' * 640])
        self.assertEqual(upstream.frames[0]['params']['voice_format'], 1)
        self.assertEqual(upstream.frames[0]['params']['speaker_diarization'], 1)
        self.assertNotIn('voiceprint_ids', upstream.frames[0]['params'])
        self.assertNotIn('speaker_roles', upstream.frames[0]['params'])
        self.assertNotIn('test-only-key', json.dumps(upstream.frames))

    def test_auth_failure_does_not_report_ready(self):
        upstream = FakeUpstream(code=4002)
        with patch('voice.tencent_realtime.aiohttp.ClientSession.ws_connect', return_value=upstream):
            with self.client.websocket_connect('ws://localhost:8015/api/voice/asr/realtime', headers=self.origin) as ws:
                event = ws.receive_json()
                self.assertEqual(event['type'], 'error')
                self.assertIn('4002', event['error'])

    def test_malformed_pcm_rejected(self):
        upstream = FakeUpstream()
        with patch('voice.tencent_realtime.aiohttp.ClientSession.ws_connect', return_value=upstream):
            with self.client.websocket_connect('ws://localhost:8015/api/voice/asr/realtime', headers=self.origin) as ws:
                ws.receive_json()
                ws.send_bytes(b'\x00')
                self.assertEqual(ws.receive_json()['type'], 'error')
        self.assertFalse(upstream.audio)
