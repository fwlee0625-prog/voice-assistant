# Synthetic audio fixture

silero-speech.wav is generated TTS saying “你好，语音测试成功。”, converted to mono PCM16 at 16 kHz from the earlier API smoke test. It is not a microphone recording or a voice identity sample.

It is used only for local Silero/Smart Turn smoke tests. Default tests do not upload it or call cloud services. It does not represent a billiards-room accuracy benchmark.

kws-wake.wav is synthetic Xiaomi TTS saying “你好助手，给三号台开台。”, converted to mono PCM16 at 16 kHz. It is used for browser-local keyword spotting and wake lifecycle tests, without microphone access or ASR upload. It is not a field accuracy benchmark.
