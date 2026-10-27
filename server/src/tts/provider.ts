/** Business-facing contract. Provider wire formats must stay inside adapters. */
export const TTS_VOICES = ['冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean'];
export interface AudioChunk { data: string; sampleRate: number; format: 'pcm16'; channels: 1 }
export interface SpeechRequest { text: string; voice: string; style?: string; signal: AbortSignal }
export interface TtsProvider { synthesize(request: SpeechRequest): AsyncIterable<AudioChunk> }
