import express from 'express';
import helmet from 'helmet';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { COMMON_QUESTIONS, MAX_ANSWER_LENGTH } from './questions.js';
import { AIError, MAX_INTERVIEW_TURNS, interviewOpening } from './ai.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const COOKIE = 'cs_session';
const SESSION_TTL = 1000 * 60 * 60 * 24 * 90;
const LOGIN_TTL = 1000 * 60 * 15;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_SYNTHESIS_ATTEMPTS = 3;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
const fail = (status, message, extra) => {
  throw new HttpError(status, message, extra);
};

// First instant of the current month in Japan, as an ISO timestamp.
export function monthStartJst(date = new Date()) {
  const jst = new Date(date.getTime() + 9 * 3600 * 1000);
  return new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), 1) - 9 * 3600 * 1000).toISOString();
}

export function createApp({ repo, ai, config, mailer, billing, exposeLoginLink = false }) {
  const app = express();
  if (config.production) app.set('trust proxy', 1);

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: config.production ? [] : null,
      },
    },
    strictTransportSecurity: config.production,
  }));

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // Stripe needs the raw body to verify signatures, so this sits before express.json().
  app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    if (!billing.enabled) return res.status(404).end();
    try {
      await billing.handleWebhook(req.body, req.get('stripe-signature'));
      res.json({ received: true });
    } catch (err) {
      console.error('stripe webhook:', err.message);
      res.status(400).json({ error: 'invalid webhook' });
    }
  });

  app.use(express.json({ limit: '100kb' }));

  // CSRF: cross-site forms cannot set custom headers, so every state change requires one.
  app.use('/api', (req, res, next) => {
    if (req.method !== 'GET' && req.get('x-comsapo') !== '1') {
      return res.status(403).json({ error: '不正なリクエストです' });
    }
    next();
  });

  const limiter = (windowMin, limit, keyGenerator) => rateLimit({
    windowMs: windowMin * 60 * 1000,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: keyGenerator || ((req) => ipKeyGenerator(req.ip)),
    handler: (req, res) => res.status(429).json({ error: '短時間に操作が集中しています。少し時間をおいてお試しください。' }),
  });
  const bySession = (req) => parseCookies(req.headers.cookie)[COOKIE] || ipKeyGenerator(req.ip);
  app.use('/api', limiter(1, 120));
  const { rateLimits } = config;
  const loginLimiter = limiter(15, rateLimits.loginPerIp15Min);
  // Stops anyone from flooding a single inbox with login mails.
  const mailLimiter = limiter(60, rateLimits.loginMailsPerEmailHour, (req) => `mail:${String(req.body?.email || '').trim().toLowerCase()}`);
  const aiLimiter = limiter(10, rateLimits.aiMessagesPer10Min, bySession);

  app.use(express.static(path.join(here, '..', 'public'), { extensions: ['html'] }));

  // --- helpers --------------------------------------------------------------

  const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const sessionToken = (req) => parseCookies(req.headers.cookie)[COOKIE];

  function currentUser(req) {
    const token = sessionToken(req);
    return token ? repo.userBySession(token) : null;
  }
  function requireUser(req, { named = true } = {}) {
    const user = currentUser(req) || fail(401, 'ログインが必要です');
    if (named && !user.name) fail(403, 'はじめに呼び名を登録してください');
    return user;
  }
  function requireRelationship(user, id) {
    const rel = repo.relationship(id);
    if (!rel || !rel.memberIds.includes(user.id)) fail(404, '見つかりません');
    return rel;
  }
  function requireTalk(user, id) {
    const talk = repo.talk(id);
    if (!talk) fail(404, '見つかりません');
    return { talk, rel: requireRelationship(user, talk.relationshipId) };
  }
  const partnerOf = (rel, user) => {
    const id = rel.memberIds.find((m) => m !== user.id);
    return id ? repo.userById(id) : null;
  };
  const text = (v, max, label) => {
    const s = typeof v === 'string' ? v.trim() : '';
    if (s.length > max) fail(400, `${label}が長すぎます（${max}文字まで）`);
    return s;
  };
  const inviteUrl = (code) => `${config.appUrl}/#/join/${code}`;

  // A pair gets Plus limits if either partner subscribes.
  function quotaOf(rel) {
    const plan = rel.memberIds.some((id) => repo.userById(id)?.plan === 'plus') ? 'plus' : 'free';
    const limit = config.plans[plan].talksPerMonth;
    const used = repo.countTalksSince(rel.id, monthStartJst());
    return { plan, limit, used, remaining: Math.max(0, limit - used) };
  }

  function relationshipView(rel, user) {
    const partner = partnerOf(rel, user);
    return {
      id: rel.id,
      partner: partner && { id: partner.id, name: partner.name },
      inviteUrl: partner ? null : inviteUrl(rel.inviteCode),
      createdAt: rel.createdAt,
    };
  }

  function talkSummary(talk, rel, user) {
    const mine = repo.findParticipant(talk.id, user.id);
    return {
      id: talk.id,
      theme: talk.theme,
      status: talk.status,
      createdAt: talk.createdAt,
      myPhase: mine?.phase || 'questions',
      partnerDone: rel.memberIds.filter((m) => m !== user.id).every((m) => repo.findParticipant(talk.id, m)?.phase === 'done'),
    };
  }

  async function runSynthesis(talkId) {
    const talk = repo.talk(talkId);
    const rel = repo.relationship(talk.relationshipId);
    repo.updateTalk(talk.id, { status: 'synthesizing', error: null, synthesisAttempts: talk.synthesisAttempts + 1 });
    try {
      const result = await ai.synthesize({
        talkId: talk.id,
        theme: talk.theme,
        memories: repo.memoriesOf(rel.id),
        participants: rel.memberIds.map((id, i) => {
          const p = repo.findParticipant(talk.id, id);
          return { label: i === 0 ? 'A' : 'B', name: repo.userById(id).name, answers: p.answers, chat: p.chat };
        }),
      });
      if (!repo.talk(talk.id)) return; // deleted meanwhile
      repo.setProposals(talk.id, (result.memory_candidates || []).slice(0, 4));
      repo.updateTalk(talk.id, { result, status: 'done', completedAt: new Date().toISOString() });
    } catch (err) {
      if (!(err instanceof AIError)) console.error(err);
      if (!repo.talk(talk.id)) return;
      repo.updateTalk(talk.id, { status: 'error', error: err instanceof AIError ? err.message : 'AIによる整理に失敗しました' });
    }
  }

  // Exposed so tests can await background synthesis.
  app.locals.pending = new Set();
  function startSynthesis(talkId) {
    const p = runSynthesis(talkId).finally(() => app.locals.pending.delete(p));
    app.locals.pending.add(p);
  }

  // --- auth (passwordless email link) ----------------------------------------

  app.post('/api/auth/request', loginLimiter, mailLimiter, route(async (req, res) => {
    const email = text(req.body?.email, 254, 'メールアドレス').toLowerCase();
    if (!EMAIL_RE.test(email)) fail(400, 'メールアドレスを確認してください');
    if (req.body?.agree !== true) fail(400, '利用規約とプライバシーポリシーへの同意が必要です');
    const next = typeof req.body?.next === 'string' && /^#\/[\w/-]*$/.test(req.body.next) ? req.body.next : '';
    const token = crypto.randomBytes(32).toString('base64url');
    repo.createLoginToken(email, token, LOGIN_TTL);
    // The token lives in the URL fragment so link scanners that prefetch the URL can't burn it.
    const url = `${config.appUrl}/#/login/${token}${next ? `?next=${encodeURIComponent(next)}` : ''}`;
    await mailer.sendLoginLink(email, url);
    res.json({ ok: true, ...(exposeLoginLink ? { url } : {}) });
  }));

  app.post('/api/auth/verify', loginLimiter, route((req, res) => {
    const email = repo.consumeLoginToken(String(req.body?.token || ''));
    if (!email) fail(400, 'ログインリンクが無効か、期限切れです。もう一度お試しください。');
    const user = repo.userByEmail(email) || repo.createUser(email);
    const token = crypto.randomBytes(32).toString('base64url');
    repo.createSession(user.id, token, SESSION_TTL);
    res.cookie(COOKIE, token, {
      httpOnly: true, sameSite: 'lax', secure: config.production, maxAge: SESSION_TTL,
    });
    res.json({ needsName: !user.name });
  }));

  app.post('/api/logout', (req, res) => {
    const token = sessionToken(req);
    if (token) repo.deleteSession(token);
    res.clearCookie(COOKIE);
    res.json({ ok: true });
  });

  // --- account --------------------------------------------------------------

  app.get('/api/me', route((req, res) => {
    const user = currentUser(req);
    const base = { aiMode: ai.mode, billingEnabled: billing.enabled, priceLabel: config.stripe.priceLabel, plans: config.plans };
    if (!user) return res.json({ user: null, ...base });
    const relationships = repo.relationshipsOf(user.id).map((r) => ({ ...relationshipView(r, user), quota: quotaOf(r) }));
    res.json({
      user: { id: user.id, name: user.name, email: user.email, plan: user.plan, hasBilling: Boolean(user.stripeCustomerId) },
      relationships,
      ...base,
    });
  }));

  app.patch('/api/me', route((req, res) => {
    const user = requireUser(req, { named: false });
    const name = text(req.body?.name, 30, '名前');
    if (!name) fail(400, '名前を入力してください');
    repo.setUserName(user.id, name);
    res.json({ name });
  }));

  // Everything this user wrote or received, for 個人情報の開示請求 / portability.
  app.get('/api/me/export', route((req, res) => {
    const user = requireUser(req, { named: false });
    const relationships = repo.relationshipsOf(user.id).map((rel) => ({
      partner: partnerOf(rel, user)?.name || null,
      memories: repo.memoriesOf(rel.id).map((m) => ({ text: m.text, createdAt: m.createdAt })),
      talks: repo.talksOf(rel.id).map((t) => {
        const mine = repo.findParticipant(t.id, user.id);
        return {
          theme: t.theme,
          createdAt: t.createdAt,
          myAnswers: mine?.answers || {},
          myInterview: mine?.chat || [],
          result: t.status === 'done' ? t.result : null,
        };
      }),
    }));
    res.set('Content-Disposition', 'attachment; filename="comsapo-export.json"');
    res.json({ exportedAt: new Date().toISOString(), user: { name: user.name, email: user.email, plan: user.plan, createdAt: user.createdAt }, relationships });
  }));

  app.delete('/api/me', route(async (req, res) => {
    const user = requireUser(req, { named: false });
    if (billing.enabled) await billing.cancelAll(user);
    repo.deleteUser(user.id);
    res.clearCookie(COOKIE);
    res.json({ ok: true });
  }));

  // --- billing --------------------------------------------------------------

  app.post('/api/billing/checkout', route(async (req, res) => {
    const user = requireUser(req);
    if (!billing.enabled) fail(404, '現在、有料プランは準備中です');
    if (user.plan === 'plus') fail(409, 'すでに Plus プランです');
    res.json({ url: await billing.checkoutUrl(user) });
  }));

  app.post('/api/billing/portal', route(async (req, res) => {
    const user = requireUser(req);
    if (!billing.enabled) fail(404, '見つかりません');
    const url = await billing.portalUrl(user);
    if (!url) fail(404, 'お支払い情報がありません');
    res.json({ url });
  }));

  // --- pairing --------------------------------------------------------------

  app.post('/api/relationships', route((req, res) => {
    const user = requireUser(req);
    const pending = repo.relationshipsOf(user.id).filter((r) => r.memberIds.length < 2);
    if (pending.length >= 3) fail(409, '未参加の招待が多すぎます。既存の招待を使ってください。');
    res.status(201).json(relationshipView(repo.createRelationship(user.id), user));
  }));

  app.get('/api/invites/:code', route((req, res) => {
    const rel = repo.relationshipByInvite(req.params.code);
    if (!rel) fail(404, '招待リンクが見つかりません');
    res.json({ inviterName: repo.userById(rel.memberIds[0]).name, full: rel.memberIds.length >= 2 });
  }));

  app.post('/api/invites/:code/accept', route((req, res) => {
    const user = requireUser(req);
    const rel = repo.relationshipByInvite(req.params.code);
    if (!rel) fail(404, '招待リンクが見つかりません');
    if (!rel.memberIds.includes(user.id) && !repo.addMember(rel.id, user.id)) fail(409, 'この招待はすでに使われています');
    res.json(relationshipView(repo.relationship(rel.id), user));
  }));

  app.get('/api/qr', route(async (req, res) => {
    const data = String(req.query.data || '');
    if (!data.startsWith(`${config.appUrl}/#/join/`) || data.length > 200) fail(400, 'invalid');
    res.type('image/svg+xml').send(await QRCode.toString(data, { type: 'svg', margin: 1 }));
  }));

  app.get('/api/relationships/:id', route((req, res) => {
    const user = requireUser(req);
    const rel = requireRelationship(user, req.params.id);
    res.json({
      ...relationshipView(rel, user),
      quota: quotaOf(rel),
      talks: repo.talksOf(rel.id).map((t) => talkSummary(t, rel, user)),
      memories: repo.memoriesOf(rel.id),
    });
  }));

  // Either partner can dissolve the pair; shared history goes with it.
  app.delete('/api/relationships/:id', route((req, res) => {
    const user = requireUser(req);
    const rel = requireRelationship(user, req.params.id);
    repo.deleteRelationship(rel.id);
    res.json({ ok: true });
  }));

  app.delete('/api/memories/:id', route((req, res) => {
    const user = requireUser(req);
    const mem = repo.memory(req.params.id);
    if (!mem) fail(404, '見つかりません');
    requireRelationship(user, mem.relationshipId);
    repo.deleteMemory(mem.id);
    res.json({ ok: true });
  }));

  // --- talks ----------------------------------------------------------------

  app.post('/api/relationships/:id/talks', route((req, res) => {
    const user = requireUser(req);
    const rel = requireRelationship(user, req.params.id);
    if (rel.memberIds.length < 2) fail(409, 'パートナーが参加してから始めてください');
    const theme = text(req.body?.theme, 60, 'テーマ');
    if (!theme) fail(400, 'テーマを入力してください');
    const quota = quotaOf(rel);
    if (quota.remaining <= 0) {
      fail(402, quota.plan === 'free'
        ? `無料プランの今月の話し合い（${quota.limit}回）を使い切りました。`
        : `今月の話し合いの上限（${quota.limit}回）に達しました。`, { quota });
    }
    const talk = repo.createTalk({ relationshipId: rel.id, theme, createdBy: user.id });
    res.status(201).json(talkSummary(talk, rel, user));
  }));

  app.get('/api/talks/:id', route((req, res) => {
    const user = requireUser(req);
    const { talk, rel } = requireTalk(user, req.params.id);
    const me = repo.findParticipant(talk.id, user.id) || { answers: {}, chat: [], phase: 'questions' };
    const partner = partnerOf(rel, user);
    const done = talk.status === 'done';
    res.json({
      id: talk.id,
      relationshipId: rel.id,
      theme: talk.theme,
      status: talk.status,
      error: talk.error || null,
      canRetry: talk.status === 'error' && talk.synthesisAttempts < MAX_SYNTHESIS_ATTEMPTS,
      questions: COMMON_QUESTIONS,
      me: {
        name: user.name,
        phase: me.phase,
        answers: me.answers,
        chat: me.chat,
        busy: Boolean(me.busy),
        interviewComplete: Boolean(me.interviewComplete),
      },
      // Never expose the partner's answers or interview — only their progress.
      partner: partner && { name: partner.name, phase: repo.findParticipant(talk.id, partner.id)?.phase || 'questions' },
      labels: Object.fromEntries(rel.memberIds.map((id, i) => [i === 0 ? 'A' : 'B', repo.userById(id).name])),
      result: done ? talk.result : null,
      memoryProposals: done
        ? repo.proposals(talk.id).map((p) => ({
          index: p.index,
          text: p.text,
          myVote: p.votes[user.id] ?? null,
          partnerVoted: partner ? p.votes[partner.id] !== undefined : false,
          saved: Boolean(p.memoryId),
        }))
        : [],
    });
  }));

  app.put('/api/talks/:id/answers', route((req, res) => {
    const user = requireUser(req);
    const { talk } = requireTalk(user, req.params.id);
    const me = repo.participant(talk.id, user.id);
    if (me.phase !== 'questions') fail(409, '回答はすでに提出済みです');
    const answers = {};
    for (const q of COMMON_QUESTIONS) answers[q.id] = text(req.body?.answers?.[q.id], MAX_ANSWER_LENGTH, '回答');
    me.answers = answers;
    if (req.body?.submit) {
      if (!answers.feeling && !answers.hurt && !answers.wish) fail(400, '少なくとも「気持ち」「つらかったこと」「してほしかったこと」のどれかに回答してください');
      me.phase = 'interview';
      me.apiMessages = [{
        role: 'user',
        content: interviewOpening({ theme: talk.theme, name: user.name, answers, memories: repo.memoriesOf(talk.relationshipId) }),
      }];
    }
    repo.saveParticipant(me);
    res.json({ phase: me.phase });
  }));

  // Advances the AI interview. With `content`, the user replies; without it (only
  // valid before the AI has spoken) the AI asks its opening question.
  app.post('/api/talks/:id/messages', aiLimiter, route(async (req, res) => {
    const user = requireUser(req);
    const { talk } = requireTalk(user, req.params.id);
    const content = text(req.body?.content, MAX_MESSAGE_LENGTH, 'メッセージ');
    let me = repo.participant(talk.id, user.id);
    if (me.phase !== 'interview') fail(409, 'ヒアリング中ではありません');
    if (me.interviewComplete) fail(409, 'ヒアリングは完了しています。「回答を完了する」を押してください');
    const last = me.apiMessages.at(-1);
    if (content ? last.role !== 'assistant' : last.role !== 'user') fail(409, content ? 'AIの質問を待っています' : 'メッセージを入力してください');
    if (!repo.claimParticipant(talk.id, user.id)) fail(409, 'AIが応答中です');

    me = repo.findParticipant(talk.id, user.id);
    if (content) {
      me.apiMessages.push({ role: 'user', content });
      me.chat.push({ role: 'user', content });
    }
    try {
      const reply = await ai.interview({ talkId: talk.id, apiMessages: me.apiMessages, answers: me.answers });
      // Append-only: keep the verbatim assistant content so thinking blocks replay unchanged.
      me.apiMessages.push({ role: 'assistant', content: reply.assistantContent || reply.message });
      me.chat.push({ role: 'assistant', content: reply.message });
      const turns = me.chat.filter((m) => m.role === 'assistant').length;
      me.interviewComplete = reply.finished || turns >= MAX_INTERVIEW_TURNS;
    } catch (err) {
      // Roll back only the unanswered tail so the user can resend.
      if (content) {
        me.apiMessages.pop();
        me.chat.pop();
      }
      if (err instanceof AIError) fail(502, err.message);
      throw err;
    } finally {
      me.busy = false;
      if (repo.talk(talk.id)) repo.saveParticipant(me);
    }
    res.json({ chat: me.chat, interviewComplete: me.interviewComplete });
  }));

  app.post('/api/talks/:id/finish', route((req, res) => {
    const user = requireUser(req);
    const { talk, rel } = requireTalk(user, req.params.id);
    const me = repo.participant(talk.id, user.id);
    if (me.phase !== 'interview') fail(409, 'ヒアリング中ではありません');
    if (me.busy) fail(409, 'AIが応答中です');
    me.phase = 'done';
    repo.saveParticipant(me);
    const allDone = rel.memberIds.length === 2 && rel.memberIds.every((id) => repo.findParticipant(talk.id, id)?.phase === 'done');
    if (allDone && talk.status === 'open') startSynthesis(talk.id);
    res.json({ status: repo.talk(talk.id).status });
  }));

  app.post('/api/talks/:id/retry', route((req, res) => {
    const user = requireUser(req);
    const { talk } = requireTalk(user, req.params.id);
    if (talk.status !== 'error') fail(409, '再実行できる状態ではありません');
    if (talk.synthesisAttempts >= MAX_SYNTHESIS_ATTEMPTS) fail(409, '再実行の上限に達しました。お問い合わせください。');
    startSynthesis(talk.id);
    res.json({ status: 'synthesizing' });
  }));

  // Relationship Memory: a proposal is saved only once BOTH partners approve it.
  app.post('/api/talks/:id/memories/:index', route((req, res) => {
    const user = requireUser(req);
    const { talk, rel } = requireTalk(user, req.params.id);
    if (talk.status !== 'done') fail(404, '見つかりません');
    const result = repo.voteProposal(talk.id, Number(req.params.index), user.id, req.body?.approve === true, rel.memberIds);
    if (!result) fail(404, '見つかりません');
    res.json(result);
  }));

  // --- errors ---------------------------------------------------------------

  app.use('/api', (req, res) => res.status(404).json({ error: '見つかりません' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: '不正なリクエストです' });
    console.error(err);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  });

  return app;
}

function parseCookies(header = '') {
  return Object.fromEntries(
    header.split(';').map((c) => c.trim().split('=')).filter(([k]) => k).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]),
  );
}
