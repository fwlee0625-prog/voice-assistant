/** Short interjections that cover the gap while the model is still thinking. */
export const DEFAULT_FILLERS = ['嗯……', '啊……', '嗯嗯……', '我想想……', '让我捋一捋……'];
export const FILLER_MAX_COUNT = 20;
export const FILLER_MAX_LENGTH = 20;

/** Keep phrase selection and spoken delivery consistent with the same situation. */
const DELIVERY: Record<string, { description: string; style: string }> = {
  '嗯': {
    description: 'A sustained thoughtful hum while considering a question that needs reflection.',
    style: '像正在轻轻思考一样，只发一个连续的“嗯”音，声音轻柔、自然，稍微拖长到约0.8至1秒，尾音平缓收住。不要重复成“嗯嗯”，不要使用疑问或肯定应答的语气。',
  },
  '啊': {
    description: 'A soft realization when new details help the coach understand the situation; not surprise or confusion.',
    style: '像刚领会对方补充的信息，轻声自然地说一个“啊”，起音柔和、略带恍然明白的感觉，尾音轻轻落下。不要惊叫、夸张惊讶或拉成疑问。',
  },
  '嗯嗯': {
    description: 'A gentle acknowledgment of the user sharing an experience or explaining their situation, without claiming their technique is correct.',
    style: '像认真听着对方描述情况，温和自然地应和两声“嗯嗯”，第一声稍轻，第二声柔和收尾，节奏连贯、轻快适中。表达听到了，不要敷衍、急促或作出肯定对错的语气。',
  },
  '我想想': {
    description: 'Considering an answer that needs analysis or choosing between options.',
    style: '像被问到一个需要想一想的问题，轻柔、若有所思地说“我想想”，语速稍慢，后一个“想”略微延长，尾音自然放轻，留一点思考感。不要犹豫不安或故作深沉。',
  },
  '让我捋一捋': {
    description: 'Organizing several details, steps, or a complicated explanation into a clear answer.',
    style: '像正在把几条信息理清楚，平和从容地说“让我捋一捋”，语速稍慢，轻轻强调“捋一捋”，自然连读、尾音平稳收住，带认真梳理思路的感觉。不要困惑、烦躁或说教。',
  },
  '稍等一下': {
    description: 'Politely asking for a brief moment before a response that needs preparation; use sparingly for simple questions.',
    style: '像友善地请对方给自己一点准备时间，温和、轻声说“稍等一下”，语速舒缓，“一下”轻轻带过，尾音柔和下落。不要像命令、催促或机械的客服播报。',
  },
};

function delivery(text: string) {
  return DELIVERY[text.trim().replace(/[\s.…。]+$/u, '')];
}

export function fillerStyle(text: string): string {
  return `${delivery(text)?.style || '按照这句衔接词本身的含义，用贴合当前词意的轻柔、自然的口语表达，语速舒缓，像在与对方当面交流。'}只朗读给定正文，不添加其他词句，不读出省略号或风格指令。`;
}

export function fillerDescription(text: string): string {
  return delivery(text)?.description || 'This is the exact phrase the coach would say; choose it only when its meaning fits the current conversation.';
}
