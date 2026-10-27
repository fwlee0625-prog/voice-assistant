import json
import os
import unittest
from unittest.mock import patch, Mock
from fastapi.testclient import TestClient
from service.app import app
from service.integration import _execute
from voice.pipeline import VoiceResult

class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_standalone_page_and_health(self):
        self.assertEqual(self.client.get('/api/health').json()['service'], 'billiards_voice')
        self.assertIn('voice.js', self.client.get('/').text)
        self.assertEqual(self.client.get('/voice.js').status_code, 200)

    def test_input_validation(self):
        self.assertEqual(self.client.post('/api/voice/text', json={}).status_code, 400)
        self.assertEqual(self.client.post('/api/voice/chat', json={}).status_code, 400)
        self.assertEqual(self.client.post('/api/voice/tts', json={}).status_code, 400)

    def test_sse_contract(self):
        pipeline = Mock()
        pipeline.run_stream.return_value = iter([
            {'type': 'delta', 'text': '你好'},
            {'type': 'done', 'result': VoiceResult(reply='你好')},
        ])
        with patch('service.routes.get_voice_pipeline', return_value=pipeline):
            response = self.client.post('/api/voice/text', json={'text': '你好'})
        self.assertIn('text/event-stream', response.headers['content-type'])
        frames = [json.loads(x[6:]) for x in response.text.strip().split('\n\n')]
        self.assertEqual(frames[-1]['result']['reply'], '你好')

    def test_binary_upload_unchanged(self):
        data = b'RIFF\x00\x01\r\n'
        with patch('voice.asr_client.ASRClient.transcribe', return_value='测试') as transcribe:
            response = self.client.post('/api/voice/asr', files={'audio': ('test.wav', data, 'audio/wav')})
        self.assertEqual(response.json()['text'], '测试')
        self.assertEqual(transcribe.call_args.args[0], data)

    def test_audio_path_validation(self):
        self.assertEqual(self.client.get('/api/voice/audio/not-a-hash.wav').status_code, 400)
        self.assertEqual(self.client.get('/api/voice/audio/0000000000000000.wav').status_code, 404)

    def test_optional_core(self):
        with patch.dict(os.environ, {'BILLIARDS_CORE_URL': ''}):
            self.assertEqual(_execute('simulate_shot', {})['status'], 'error')
            self.assertEqual(self.client.get('/table').status_code, 503)

    def test_core_bridge_contract(self):
        with patch.dict(os.environ, {'BILLIARDS_CORE_URL': 'http://localhost:8999'}):
            with patch('service.integration.requests.post') as post:
                post.return_value.json.return_value = {'status': 'ok', 'balls': []}
                response = self.client.post('/api/voice/execute', json={
                    'tool_name': 'set_table_layout', 'arguments': {'layoutType': 'random'}})
        self.assertEqual(response.json()['status'], 'ok')
        self.assertEqual(post.call_args.args[0], 'http://localhost:8999/api/voice/execute')
        self.assertEqual(post.call_args.kwargs['json']['arguments'], {'layoutType': 'random'})

if __name__ == '__main__':
    unittest.main()
