// Claude integration. Falls back to a deterministic mock when no credentials are
// configured (or AI_MODE=mock) so the whole flow can be tried and tested offline.
import Anthropic from '@anthropic-ai/sdk';
import { INTERVIEW_SYSTEM, SYNTHESIS_SYSTEM, formatAnswers, formatMemories } from './prompts.js';
import { COMMON_QUESTIONS } from './questions.js';

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
export const MAX_INTERVIEW_TURNS = 6;

export class AIError extends Error {}

const INTERVIEW_SCHEMA = {
  type: 'object',
  properties: {
    message: { type: 'string', description: '参加者に表示する発言' },
    finished: { type: 'boolean', description: 'ヒアリングを終えるなら true' },
  },
  required: ['message', 'finished'],
  additionalProperties: false,
};

const OWNER = { type: 'string', enum: ['A', 'B', 'both'] };
const SYNTHESIS_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string', description: '「2人 vs すれ違い」の構図で今回を一言で表す見出し' },
    perspectives: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          participant: { type: 'string', enum: ['A', 'B'] },
          feelings: { type: 'string', description: 'この人の気持ち（相手が受け止めやすい表現に翻訳）' },
          needs: { type: 'string', description: 'この人が本当に求めていること' },
          appreciation: { type: 'string', description: 'この人が相手に感謝・尊敬していること' },
        },
        required: ['participant', 'feelings', 'needs', 'appreciation'],
        additionalProperties: false,
      },
    },
    common_ground: { type: 'array', items: { type: 'string' } },
    misalignment: { type: 'string', description: 'すれ違いの構造の説明' },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: { owner: OWNER, action: { type: 'string' } },
        required: ['owner', 'action'],
        additionalProperties: false,
      },
    },
    phrasing_tips: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          owner: OWNER,
          instead_of: { type: 'string' },
          try_saying: { type: 'string' },
        },
        required: ['owner', 'instead_of', 'try_saying'],
        additionalProperties: false,
      },
    },
    conversation_starter: { type: 'string', description: '結果を読んだ後、2人で話し始めるための最初の一言の提案' },
    safety_note: { type: 'string' },
    memory_candidates: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'headline', 'perspectives', 'common_ground', 'misalignment', 'actions',
    'phrasing_tips', 'conversation_starter', 'safety_note', 'memory_candidates',
  ],
  additionalProperties: false,
};

// USD per million tokens. Used for the spend guard and usage log, not billing.
const PRICES = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
};

export function estimateCostUsd(model, usage) {
  const p = PRICES[model] || PRICES['claude-opus-5-5'];
  const cost = (usage.input_tokens || 0) * p.input
    + (usage.cache_creation_input_tokens || 0) * p.input * 1.25
    + (usage.cache_read_input_tokens || 0) * p.cacheRead
    + (usage.output_tokens || 0) * p.output;
  return cost / 1e6;
}

// `guard()` runs before every call and throws AIError to refuse it (e.g. spend cap);
// `onUsage()` receives token counts after every call.
export function createAI({ mode, model = 'claude-opus-5-5', guard = () => {}, onUsage = () => {} } = {}) {
  const hasCreds = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  const resolved = mode || process.env.AI_MODE || (hasCreds ? 'claude' : 'mock');
  return resolved === 'mock' ? mockAI({ guard }) : claudeAI(new Anthropic(), { model, guard, onUsage });
}

// ---------------------------------------------------------------------------

function claudeAI(client, { model, guard, onUsage }) {
  async function call({ system, messages, schema, effort, kind, talkId }) {
    guard();
    let res;
    try {
      res = await client.beta.messages.create({
        model,
        max_tokens: 16000,
        betas: [FALLBACK_BETA],
        fallbacks: 'default',
        // Interview turns resend a growing transcript; cache the prefix between turns.
        cache_control: { type: 'ephemeral' },
        system,
        messages,
        output_config: { effort, format: { type: 'json_schema', schema } },
      });
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) throw new AIError('AIが混み合っています。少し時間をおいて再度お試しください。');
      if (err instanceof Anthropic.APIError) throw new AIError(`AIの呼び出しに失敗しました (${err.status ?? 'network'})`);
      throw err;
    }
    const usage = res.usage || {};
    onUsage({
      talkId,
      kind,
      model: res.model || model,
      inputTokens: (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0),
      outputTokens: usage.output_tokens || 0,
      costUsd: estimateCostUsd(res.model || model, usage),
    });
    if (res.stop_reason === 'refusal') {
      throw new AIError('この内容はAIが扱えませんでした。表現を変えて、もう一度お試しください。');
    }
    if (res.stop_reason === 'max_tokens') throw new AIError('AIの応答が長くなりすぎました。もう一度お試しください。');
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    try {
      return { data: JSON.parse(text), content: res.content };
    } catch {
      throw new AIError('AIの応答を読み取れませんでした。もう一度お試しください。');
    }
  }

  return {
    mode: 'claude',

    // `apiMessages` is the verbatim API transcript (assistant turns keep their
    // thinking blocks) and is only ever appended to, so replayed thinking stays valid.
    async interview({ apiMessages, talkId }) {
      const { data, content } = await call({
        system: INTERVIEW_SYSTEM,
        messages: apiMessages,
        schema: INTERVIEW_SCHEMA,
        effort: 'medium',
        kind: 'interview',
        talkId,
      });
      return { message: data.message, finished: Boolean(data.finished), assistantContent: content };
    },

    async synthesize(input) {
      const { data } = await call({
        system: SYNTHESIS_SYSTEM,
        messages: [{ role: 'user', content: synthesisPrompt(input) }],
        schema: SYNTHESIS_SCHEMA,
        effort: 'high',
        kind: 'synthesis',
        talkId: input.talkId,
      });
      return data;
    },
  };
}

// First user turn of an interview. Memories are frozen in here (not in `system`)
// so the conversation prefix never changes after it starts.
export function interviewOpening({ theme, name, answers, memories }) {
  return `テーマ: ${theme}
参加者の名前: ${name}${formatMemories(memories)}

# 定型質問への回答
${formatAnswers(COMMON_QUESTIONS, answers)}

上の回答をふまえて、ヒアリングを始めてください。`;
}

function synthesisPrompt({ theme, participants, memories }) {
  const blocks = participants.map((p) => {
    const chat = p.chat.map((m) => `${m.role === 'assistant' ? 'AI' : p.name}: ${m.content}`).join('\n');
    return `## 参加者${p.label}: ${p.name}さん

### 定型質問への回答
${formatAnswers(COMMON_QUESTIONS, p.answers)}

### AIとの個別ヒアリング
${chat || '（なし）'}`;
  });
  return `テーマ: ${theme}${formatMemories(memories)}

${blocks.join('\n\n')}

2人の内容を統合して、2人で一緒に読む結果を作ってください。`;
}

// ---------------------------------------------------------------------------

function mockAI({ guard }) {
  const PROBES = [
    (a) => `話してくれてありがとうございます。「${clip(a.wish || a.hurt)}」とありましたが、具体的にどんな場面でそう感じましたか？`,
    () => 'そのとき、本当はどんな言葉や行動があれば「一緒にやっている」と感じられそうですか？',
    () => '相手の側には、どんな事情や考えがあったと思いますか？想像で大丈夫です。',
  ];
  return {
    mode: 'mock',
    async interview({ apiMessages, answers }) {
      guard();
      const turn = apiMessages.filter((m) => m.role === 'assistant').length;
      if (turn < PROBES.length) return { message: PROBES[turn](answers), finished: false, assistantContent: null };
      return {
        message: 'ありがとうございました。話してくれた内容は、相手の回答とあわせてAIが整理します。',
        finished: true,
        assistantContent: null,
      };
    },
    async synthesize({ participants }) {
      guard();
      const [a, b] = participants;
      const view = (p) => ({
        participant: p.label,
        feelings: `${p.name}さんは「${clip(p.answers.feeling)}」という気持ちを抱えているようです。`,
        needs: `本当は「${clip(p.answers.wish)}」を求めているようです。`,
        appreciation: clip(p.answers.gratitude),
      });
      return {
        headline: '2人とも関係を良くしたいと思っている。すれ違っているのは「伝え方」かもしれません。',
        perspectives: [view(a), view(b)],
        common_ground: [`2人とも「${clip(a.answers.goal)}」「${clip(b.answers.goal)}」のような、前向きな状態を望んでいます。`],
        misalignment: `${a.name}さんと${b.name}さんは、同じ出来事を違う前提で受け止めていた可能性があります。（モックモードの簡易分析です）`,
        actions: [
          { owner: 'A', action: `${a.name}さんは、してほしいことを「いつまでに・何を」の形で具体的に伝えてみる。` },
          { owner: 'B', action: `${b.name}さんは、任せる前に「一緒に決めたい？任せたい？」と一言確認する。` },
          { owner: 'both', action: '週に1回10分、このテーマについて進捗を共有する時間をつくる。' },
        ],
        phrasing_tips: [{ owner: 'both', instead_of: 'なんでやってくれないの？', try_saying: '〇〇を金曜日までに一緒に決めたいんだけど、どうかな？' }],
        conversation_starter: 'お互いの回答を読んで、一番「そうだったんだ」と思ったところはどこ？',
        safety_note: '',
        memory_candidates: ['2人とも、相談されずに進むと「一人で抱えている」と感じやすい。'],
      };
    },
  };
}

function clip(s, n = 40) {
  const t = String(s || '').replace(/\s+/g, ' ').trim() || '（未回答）';
  return t.length > n ? `${t.slice(0, n)}…` : t;
}
