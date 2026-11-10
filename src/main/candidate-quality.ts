const LEADING_FILLER_PATTERN =
  /^(?:嗯+|呃+|额+|啊+|哦+|好+|对+|行+|可以|好的|那个|这个|然后|张老师|老师|谢谢)[，,。！？!?、：:\s]*/u;

const TOPIC_SIGNAL_PATTERN =
  /因为|所以|但是|其实|关键|原因|建议|应该|不能|需要|选择|影响|区别|如何|为什么|问题|方法|目标|孩子|家长|学校|学习|升学|专业|就业|管理|经济|人工智能|计算机|分数|考试|大学|政策|计划|工作|职业|哪个|是否|怎么|什么|值得|适合|吗|要不要|能不能/u;

const CHATTER_WORD_PATTERN =
  /20\d{2}\s*年?|\d{1,4}年|大家好|大家|早上好|早上|上午好|中午好|下午好|晚上好|晚上|您好|欢迎大家|欢迎来到|欢迎回到|直播间|各位朋友|各位同学|朋友们|同学们|谢谢大家|感谢大家|再见|拜拜|更新|昨天|今天|明天|我们|来|好|嗯|啊|哦|对|是|不是|可以|行|没问题|好的|欢迎|关注|点赞|灯牌|连麦|已拍|分享|关于/gu;
const CHATTER_HINT_PATTERN =
  /20\d{2}\s*年?|\d{1,4}年|大家好|大家|早上好|早上|上午好|中午好|下午好|晚上好|晚上|您好|欢迎大家|欢迎来到|欢迎回到|直播间|各位朋友|各位同学|朋友们|同学们|谢谢大家|感谢大家|再见|拜拜|更新|昨天|今天|明天|我们|老师|张老师|好|嗯|啊|哦|对|是|不是|可以|行|没问题|好的|欢迎|关注|点赞|灯牌|连麦|已拍|分享|关于/u;

const SENTENCE_SPLIT_PATTERN = /[。！？!?；;，,]+/u;

/**
 * Returns true for transcript crumbs that are useful as context but are not a
 * standalone short-video topic (greetings, dates, acknowledgements, etc.).
 */
export function isLowInformationPhrase(value: string): boolean {
  const cleaned = value.replace(/\s+/gu, " ").trim();
  if (!cleaned) return true;
  const compacted = cleaned.replace(/\s+/gu, "");
  if (
    /^(?:今天|今晚|这次).{0,24}(?:跟大家|和大家|给大家)?(?:分享|介绍|聊聊)/u.test(compacted)
    && !/(政策|专业|分数|选择|建议|区别|为什么|如何|值得|影响|招生)/u.test(compacted)
  ) {
    return true;
  }
  const meaningful = meaningfulLength(cleaned);
  if (meaningful > 20) return false;
  if (!CHATTER_HINT_PATTERN.test(cleaned)) return false;
  const residual = cleaned
    .replace(CHATTER_WORD_PATTERN, "")
    .replace(/[\d年月日时分秒,:：，。.!！？?、;；\-\s]/gu, "");
  if (TOPIC_SIGNAL_PATTERN.test(residual)) return false;
  if (residual.length <= 2) return true;
  // A model title can be padded with a name or a short conversational tail
  // (for example “晚上 Vivian” or “给你更新的也是假的”). If the remaining
  // words contain no topic signal, it is still a greeting/chatter title even
  // when it is longer than two characters.
  if (meaningful <= 20 && !TOPIC_SIGNAL_PATTERN.test(residual)) return true;
  return /(?:大家好|早上好|上午好|中午好|下午好|晚上好|欢迎|直播间)/u.test(cleaned)
    && !TOPIC_SIGNAL_PATTERN.test(residual)
    && meaningful <= 16;
}

function substantiveSentences(value: string): string[] {
  return value
    .split(/[。！？!?；;]+/u)
    .map((item) => item.trim())
    .filter((item) => item && !isLowInformationPhrase(item));
}

function substantiveClauses(value: string): string[] {
  return value
    .split(SENTENCE_SPLIT_PATTERN)
    .map((item) => item.trim())
    .filter((item) => item && !isLowInformationPhrase(item));
}

export function stripLeadingFillers(value: string): string {
  let result = value.trim();
  for (let index = 0; index < 5; index += 1) {
    const next = result.replace(LEADING_FILLER_PATTERN, "").trim();
    if (next === result) break;
    result = next;
  }
  return result;
}

export function meaningfulLength(value: string): number {
  return (value.match(/[\p{L}\p{N}\u3400-\u9fff]/gu) ?? []).length;
}

/**
 * Tongyi/ASR exports sometimes put a space between every Chinese character or
 * word. Keep spaces inside Latin phrases, but remove artificial spaces around
 * Chinese text, numbers and punctuation before it reaches titles/subtitles.
 */
export function normalizeSpokenText(value: string): string {
  return value
    .replace(/[\u00a0\t\r\n]+/gu, " ")
    .replace(/([\u3400-\u9fff\d])\s+(?=[\u3400-\u9fff\d])/gu, "$1")
    .replace(/([\u3400-\u9fff])\s+(?=[，。！？!?；;、,:：])/gu, "$1")
    .replace(/([，。！？!?；;、,:：])\s+/gu, "$1")
    // Common education-domain ASR insertion: “教育部令去备案” is the
    // transcript's false filler, not a meaningful phrase in the title.
    .replace(/教育部(?:令去|人去|的去)备案/gu, "教育部备案")
    .replace(/ {2,}/gu, " ")
    .trim();
}

export function hasTopicSignal(value: string): boolean {
  return TOPIC_SIGNAL_PATTERN.test(value);
}

function isFillerOnly(value: string): boolean {
  const cleaned = value
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .replace(
      /嗯+|呃+|额+|啊+|哦+|好+|对+|行+|可以|好的|那个|这个|然后|张老师|老师|谢谢/gu,
      "",
    );
  return cleaned.length === 0;
}

export function deriveCandidateTitle(
  title: string,
  transcript: string,
): string {
  const cleanedTitle = normalizeSpokenText(stripLeadingFillers(title))
    .replace(/^(?:标题|话题)[：:]\s*/u, "")
    .trim();
  if (
    meaningfulLength(cleanedTitle) >= 8
    && !isFillerOnly(cleanedTitle)
    && !isLowInformationPhrase(cleanedTitle)
  ) {
    return cleanedTitle.slice(0, 32);
  }
  const cleanedTranscript = normalizeSpokenText(stripLeadingFillers(transcript));
  const firstThought = substantiveClauses(cleanedTranscript).find(
    (item) => meaningfulLength(item) >= 8,
  )
    ?? substantiveSentences(cleanedTranscript).find(
      (item) => meaningfulLength(item) >= 8,
    )
    ?? cleanedTranscript.split(/[。！？!?，,；;]/u)[0]?.trim();
  return normalizeSpokenText(firstThought || cleanedTranscript).slice(0, 32);
}

export function isMatureTopic(title: string, transcript: string): boolean {
  const cleanedTranscript = stripLeadingFillers(transcript);
  const cleanedTitle = stripLeadingFillers(title);
  if (isFillerOnly(cleanedTranscript) || isFillerOnly(cleanedTitle))
    return false;
  if (isLowInformationPhrase(cleanedTitle)) return false;
  if (meaningfulLength(cleanedTranscript) < 36) return false;
  if (meaningfulLength(cleanedTitle) < 8) return false;
  const substantive = substantiveSentences(cleanedTranscript);
  if (!substantive.some((item) => meaningfulLength(item) >= 8)) return false;
  return TOPIC_SIGNAL_PATTERN.test(`${cleanedTitle}${substantive.join("")}`);
}
