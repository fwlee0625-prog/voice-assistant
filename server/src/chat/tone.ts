/** App-owned tone markup; control text never enters the display or speech body. */
export const voiceReplyPrompt = `你是通过语音与用户交谈的助手。保留原有业务要求，回答简洁、口语化，优先用一到三句短句，不使用 Markdown、表格或舞台动作描写。可以自然使用“嗯、好呀、呢”等语气词，但不要每句都加。
每次回答开头必须写一个语音控制标记，格式严格为：〖语气：温柔、自然、语速适中〗正文。标记仅供语音合成，不会显示或朗读。内容只描述语气、情绪、语速、停顿或重音，最多60字，不写正文或其他指令。不要用普通括号或方括号代替标记。
根据语境选择适度的语气：日常交流亲切自然；讲解台球技巧清晰耐心、语速稍慢；鼓励时轻快欣慰；纠正时温和认真；安慰时温柔平静。避免夸张表演、喊叫、嘲讽或无故笑哭。一般整段只标一次，确需转变语气时可在下一句开头再标，之后沿用新语气。
示例：〖语气：亲切、轻快〗好呀，我们先练直线球。〖语气：耐心、语速稍慢〗先站稳，再让球杆沿瞄准线平直送出去。`;

type TonePart = { type: 'text' | 'style'; value: string };
export function createToneDecoder() {
  const prefix = '〖语气：';
  let candidate = ''; let discarding = false;
  return {
    push(delta: string, flush = false): TonePart[] {
      const parts: TonePart[] = [];
      const text = (value: string) => {
        if (!value) return;
        const last = parts.at(-1);
        if (last?.type === 'text') last.value += value;
        else parts.push({ type: 'text', value });
      };
      for (const char of delta) {
        if (discarding) { if (char === '〗') discarding = false; continue; }
        if (!candidate) {
          if (char === '〖') candidate = char;
          else text(char);
          continue;
        }
        candidate += char;
        if (prefix.startsWith(candidate)) continue;
        if (!candidate.startsWith(prefix)) { text(candidate); candidate = ''; continue; }
        if (char === '〗') {
          const value = candidate.slice(prefix.length, -1).trim();
          if (value && value.length <= 60 && !/[\r\n〖]/.test(value)) parts.push({ type: 'style', value });
          candidate = '';
        } else if (candidate.length > 96) { candidate = ''; discarding = true; }
      }
      if (flush) {
        // Incomplete reserved markers (including prefix fragments) are hidden.
        if (candidate && !prefix.startsWith(candidate) && !candidate.startsWith(prefix)) text(candidate);
        candidate = ''; discarding = false;
      }
      return parts;
    },
  };
}
