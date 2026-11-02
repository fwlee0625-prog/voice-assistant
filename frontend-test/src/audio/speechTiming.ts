/** Durations use one monotonic clock per side; never subtract server from browser time. */
export interface DiagnosticEvent { ms: number; event: string; fields: Record<string, string | number | boolean | null> }
export function analyzeSpeechTimings(events: DiagnosticEvent[]) {
  const difference = (end?: number, start?: number) => end === undefined || start === undefined || end < start ? null : Math.round((end - start) * 100) / 100
  const number = (event: DiagnosticEvent | undefined, key: string) => {
    const value = event?.fields[key]
    return typeof value === 'number' && value >= 0 ? value : undefined
  }
  return events.filter(e => e.event === 'reply.request').map(request => {
    const player = request.fields.player
    const trace = request.fields.trace
    const response = events.find(e => e.event === 'reply.response' && e.ms >= request.ms && e.fields.player === player)
    const requestId = response?.fields.requestId
    const stream = requestId ? events.filter(e => e.event === 'stream.event' && e.fields.requestId === requestId) : []
    const stage = (name: string, sentenceId?: number) => stream.find(e => e.fields.stage === name && (sentenceId === undefined || e.fields.sentenceId === sentenceId))
    const server = (name: string, sentenceId?: number) => number(stage(name, sentenceId), 'serverElapsedMs')
    const firstText = stream.find(e => e.fields.type === 'text' && Number(e.fields.textChars) > 0)
    const firstAudio = stream.find(e => e.fields.type === 'audio')
    const playback = events.filter(e => e.event === 'playback.chunk' && e.fields.player === player && e.ms >= request.ms)
    const bodyPlayback = playback.find(e => Number(e.fields.sentenceId) >= 0)
    const scheduled = bodyPlayback && number(bodyPlayback, 'scheduledAt')
    const context = bodyPlayback && number(bodyPlayback, 'contextTime')
    const playbackAt = bodyPlayback && scheduled !== undefined && context !== undefined ? bodyPlayback.ms + Math.max(0, scheduled - context) * 1000 : undefined
    const commit = trace ? events.find(e => e.event === 'turn.commit' && e.fields.trace === trace) : undefined
    const end = events.find(e => e.event === 'reply.end' && e.ms >= request.ms && e.fields.player === player)
    const metrics = {
      turnWaitMs: difference(commit?.ms, number(commit, 'silenceAtMs')),
      finalToCommitMs: difference(commit?.ms, number(commit, 'finalAtMs')),
      queueMs: difference(request.ms, commit?.ms),
      modelFirstDeltaMs: difference(server('model.first_delta'), server('model.request')),
      firstPhraseMs: difference(server('tts.request', 0), server('model.first_delta')),
      ttsFirstAudioMs: difference(server('tts.first_audio', 0), server('tts.request', 0)),
      requestToTextMs: difference(firstText?.ms, request.ms),
      requestToAudioMs: difference(firstAudio?.ms, request.ms),
      requestToPlaybackMs: difference(playbackAt, request.ms),
      silenceToPlaybackMs: difference(playbackAt, number(commit, 'silenceAtMs')),
      replyLifetimeMs: difference(end?.ms, request.ms),
    }
    const candidates = [
      { label: '话轮等待', ms: metrics.turnWaitMs }, { label: '模型首字', ms: metrics.modelFirstDeltaMs },
      { label: '首句准备（含语气标记）', ms: metrics.firstPhraseMs }, { label: 'TTS 首包', ms: metrics.ttsFirstAudioMs },
    ].filter((item): item is { label: string; ms: number } => item.ms !== null).sort((a, b) => b.ms - a.ms)
    return { trace, player, turn: request.fields.turn, requestId: requestId || null,
      status: end?.fields.status || '进行中', aborted: end?.fields.aborted === true,
      speechFailed: stream.some(e => e.fields.type === 'speech_error'), metrics, largestObservedStage: candidates[0] ?? null,
      underruns: playback.filter(e => e.fields.underrun === true).length,
      sentences: stream.filter(e => e.fields.stage === 'tts.request').map(e => {
        const id = Number(e.fields.sentenceId)
        return { sentenceId: id, requestMs: number(e, 'serverElapsedMs') ?? null,
          firstAudioMs: difference(server('tts.first_audio', id), number(e, 'serverElapsedMs')),
          synthesisMs: difference(server('tts.end', id), number(e, 'serverElapsedMs')) }
      }),
    }
  })
}
