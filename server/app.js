import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { newId } from './store.js';
import { COMMON_QUESTIONS, MAX_ANSWER_LENGTH } from './questions.js';
import { AIError, MAX_INTERVIEW_TURNS, interviewOpening } from './ai.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const COOKIE = 'cs_token';
const MAX_MESSAGE_LENGTH = 2000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};

export function createApp({ store, ai }) {
  const { db, save } = store;
  const app = express();
  app.use(express.json({ limit: '100kb' }));
  app.use(express.static(path.join(here, '..', 'public')));

  // --- helpers --------------------------------------------------------------

  const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

  function currentUser(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    return Object.values(db.users).find((u) => token && u.token === token) || null;
  }
  function requireUser(req) {
    return currentUser(req) || fail(401, 'ログインが必要です');
  }
  function requireRelationship(user, id) {
    const rel = db.relationships[id];
    if (!rel || !rel.memberIds.includes(user.id)) fail(404, '見つかりません');
    return rel;
  }
  function requireTalk(user, id) {
    const talk = db.talks[id];
    if (!talk) fail(404, '見つかりません');
    requireRelationship(user, talk.relationshipId);
    return talk;
  }
  const partnerOf = (rel, user) => db.users[rel.memberIds.find((m) => m !== user.id)] || null;
  const memoriesOf = (rel) => Object.values(db.memories).filter((m) => m.relationshipId === rel.id);
  const inviteUrl = (req, code) => `${req.protocol}://${req.get('host')}/#/join/${code}`;
  const text = (v, max, label) => {
    const s = typeof v === 'string' ? v.trim() : '';
    if (s.length > max) fail(400, `${label}が長すぎます（${max}文字まで）`);
    return s;
  };

  function participantOf(talk, user) {
    if (!talk.participants[user.id]) {
      talk.participants[user.id] = { answers: {}, chat: [], apiMessages: [], phase: 'questions', busy: false };
    }
    return talk.participants[user.id];
  }

  function talkSummary(talk, user) {
    const rel = db.relationships[talk.relationshipId];
    return {
      id: talk.id,
      theme: talk.theme,
      status: talk.status,
      createdAt: talk.createdAt,
      myPhase: talk.participants[user.id]?.phase || 'questions',
      partnerDone: rel.memberIds.filter((m) => m !== user.id).every((m) => talk.participants[m]?.phase === 'done'),
    };
  }

  function relationshipView(req, rel, user) {
    const partner = partnerOf(rel, user);
    return {
      id: rel.id,
      partner: partner && { id: partner.id, name: partner.name },
      inviteUrl: partner ? null : inviteUrl(req, rel.inviteCode),
      createdAt: rel.createdAt,
    };
  }

  async function runSynthesis(talk) {
    const rel = db.relationships[talk.relationshipId];
    talk.status = 'synthesizing';
    talk.error = null;
    save();
    try {
      const result = await ai.synthesize({
        theme: talk.theme,
        memories: memoriesOf(rel),
        participants: rel.memberIds.map((id, i) => ({
          label: i === 0 ? 'A' : 'B',
          name: db.users[id].name,
          answers: talk.participants[id].answers,
          chat: talk.participants[id].chat,
        })),
      });
      talk.result = result;
      talk.memoryProposals = (result.memory_candidates || []).map((t) => ({ text: t, votes: {} }));
      talk.status = 'done';
      talk.completedAt = new Date().toISOString();
    } catch (err) {
      talk.status = 'error';
      talk.error = err instanceof AIError ? err.message : 'AIによる整理に失敗しました';
      if (!(err instanceof AIError)) console.error(err);
    }
    save();
  }

  // Exposed so tests can await background synthesis.
  app.locals.pending = new Set();
  function startSynthesis(talk) {
    const p = runSynthesis(talk).finally(() => app.locals.pending.delete(p));
    app.locals.pending.add(p);
  }

  // --- account --------------------------------------------------------------

  app.post('/api/users', route((req, res) => {
    const name = text(req.body?.name, 30, '名前');
    if (!name) fail(400, '名前を入力してください');
    const user = { id: newId(), name, token: newId(24), createdAt: new Date().toISOString() };
    db.users[user.id] = user;
    save();
    res.cookie(COOKIE, user.token, { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 365 });
    res.status(201).json({ id: user.id, name: user.name });
  }));

  app.get('/api/me', route((req, res) => {
    const user = currentUser(req);
    if (!user) return res.json({ user: null, aiMode: ai.mode });
    const relationships = Object.values(db.relationships)
      .filter((r) => r.memberIds.includes(user.id))
      .map((r) => relationshipView(req, r, user));
    res.json({ user: { id: user.id, name: user.name }, relationships, aiMode: ai.mode });
  }));

  app.post('/api/logout', (req, res) => {
    res.clearCookie(COOKIE);
    res.json({ ok: true });
  });

  // --- pairing --------------------------------------------------------------

  app.post('/api/relationships', route((req, res) => {
    const user = requireUser(req);
    const rel = { id: newId(), memberIds: [user.id], inviteCode: newId(12), createdAt: new Date().toISOString() };
    db.relationships[rel.id] = rel;
    save();
    res.status(201).json(relationshipView(req, rel, user));
  }));

  app.get('/api/invites/:code', route((req, res) => {
    const rel = Object.values(db.relationships).find((r) => r.inviteCode === req.params.code);
    if (!rel) fail(404, '招待リンクが見つかりません');
    res.json({ inviterName: db.users[rel.memberIds[0]].name, full: rel.memberIds.length >= 2 });
  }));

  app.post('/api/invites/:code/accept', route((req, res) => {
    const user = requireUser(req);
    const rel = Object.values(db.relationships).find((r) => r.inviteCode === req.params.code);
    if (!rel) fail(404, '招待リンクが見つかりません');
    if (!rel.memberIds.includes(user.id)) {
      if (rel.memberIds.length >= 2) fail(409, 'この招待はすでに使われています');
      rel.memberIds.push(user.id);
      save();
    }
    res.json(relationshipView(req, rel, user));
  }));

  app.get('/api/qr', route(async (req, res) => {
    const data = String(req.query.data || '');
    if (!data || data.length > 500) fail(400, 'invalid');
    res.type('image/svg+xml').send(await QRCode.toString(data, { type: 'svg', margin: 1 }));
  }));

  app.get('/api/relationships/:id', route((req, res) => {
    const user = requireUser(req);
    const rel = requireRelationship(user, req.params.id);
    const talks = Object.values(db.talks)
      .filter((t) => t.relationshipId === rel.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((t) => talkSummary(t, user));
    res.json({ ...relationshipView(req, rel, user), talks, memories: memoriesOf(rel) });
  }));

  app.delete('/api/memories/:id', route((req, res) => {
    const user = requireUser(req);
    const mem = db.memories[req.params.id];
    if (!mem) fail(404, '見つかりません');
    requireRelationship(user, mem.relationshipId);
    // Either partner can withdraw consent at any time.
    delete db.memories[mem.id];
    save();
    res.json({ ok: true });
  }));

  // --- talks ----------------------------------------------------------------

  app.post('/api/relationships/:id/talks', route((req, res) => {
    const user = requireUser(req);
    const rel = requireRelationship(user, req.params.id);
    const theme = text(req.body?.theme, 60, 'テーマ');
    if (!theme) fail(400, 'テーマを入力してください');
    const talk = {
      id: newId(),
      relationshipId: rel.id,
      theme,
      createdBy: user.id,
      status: 'open',
      participants: {},
      result: null,
      memoryProposals: [],
      createdAt: new Date().toISOString(),
    };
    db.talks[talk.id] = talk;
    save();
    res.status(201).json(talkSummary(talk, user));
  }));

  app.get('/api/talks/:id', route((req, res) => {
    const user = requireUser(req);
    const talk = requireTalk(user, req.params.id);
    const rel = db.relationships[talk.relationshipId];
    const me = talk.participants[user.id] || { answers: {}, chat: [], phase: 'questions' };
    const partner = partnerOf(rel, user);
    const done = talk.status === 'done';
    res.json({
      id: talk.id,
      relationshipId: rel.id,
      theme: talk.theme,
      status: talk.status,
      error: talk.error || null,
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
      partner: partner && { name: partner.name, phase: talk.participants[partner.id]?.phase || 'questions' },
      labels: Object.fromEntries(rel.memberIds.map((id, i) => [i === 0 ? 'A' : 'B', db.users[id].name])),
      result: done ? talk.result : null,
      memoryProposals: done
        ? talk.memoryProposals.map((p, i) => ({
          index: i,
          text: p.text,
          myVote: p.votes[user.id] ?? null,
          partnerVoted: partner ? p.votes[partner.id] !== undefined : false,
          saved: Boolean(p.memoryId),
        }))
        : [],
    });
  }));

  app.put('/api/talks/:id/answers', route(async (req, res) => {
    const user = requireUser(req);
    const talk = requireTalk(user, req.params.id);
    const me = participantOf(talk, user);
    if (me.phase !== 'questions') fail(409, '回答はすでに提出済みです');
    const answers = {};
    for (const q of COMMON_QUESTIONS) answers[q.id] = text(req.body?.answers?.[q.id], MAX_ANSWER_LENGTH, '回答');
    me.answers = answers;
    if (req.body?.submit) {
      if (!answers.feeling && !answers.hurt && !answers.wish) fail(400, '少なくとも「気持ち」「つらかったこと」「してほしかったこと」のどれかに回答してください');
      me.phase = 'interview';
      const rel = db.relationships[talk.relationshipId];
      me.apiMessages = [{
        role: 'user',
        content: interviewOpening({ theme: talk.theme, name: user.name, answers, memories: memoriesOf(rel) }),
      }];
    }
    save();
    res.json({ phase: me.phase });
  }));

  // Advances the AI interview. With `content`, the user replies; without it (only
  // valid before the AI has spoken) the AI asks its opening question.
  app.post('/api/talks/:id/messages', route(async (req, res) => {
    const user = requireUser(req);
    const talk = requireTalk(user, req.params.id);
    const me = participantOf(talk, user);
    if (me.phase !== 'interview') fail(409, 'ヒアリング中ではありません');
    if (me.busy) fail(409, 'AIが応答中です');
    const content = text(req.body?.content, MAX_MESSAGE_LENGTH, 'メッセージ');
    const last = me.apiMessages.at(-1);
    if (content) {
      if (last.role !== 'assistant') fail(409, 'AIの質問を待っています');
      me.apiMessages.push({ role: 'user', content });
      me.chat.push({ role: 'user', content });
    } else if (last.role !== 'user') {
      fail(400, 'メッセージを入力してください');
    }

    me.busy = true;
    try {
      const reply = await ai.interview({ apiMessages: me.apiMessages, answers: me.answers });
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
      save();
    }
    res.json({ chat: me.chat, interviewComplete: me.interviewComplete });
  }));

  app.post('/api/talks/:id/finish', route((req, res) => {
    const user = requireUser(req);
    const talk = requireTalk(user, req.params.id);
    const me = participantOf(talk, user);
    if (me.phase !== 'interview') fail(409, 'ヒアリング中ではありません');
    if (me.busy) fail(409, 'AIが応答中です');
    me.phase = 'done';
    const rel = db.relationships[talk.relationshipId];
    const allDone = rel.memberIds.length === 2 && rel.memberIds.every((id) => talk.participants[id]?.phase === 'done');
    if (allDone && talk.status === 'open') startSynthesis(talk);
    save();
    res.json({ status: talk.status });
  }));

  app.post('/api/talks/:id/retry', route((req, res) => {
    const user = requireUser(req);
    const talk = requireTalk(user, req.params.id);
    if (talk.status !== 'error') fail(409, '再実行できる状態ではありません');
    startSynthesis(talk);
    res.json({ status: talk.status });
  }));

  // Relationship Memory: a proposal is saved only once BOTH partners approve it.
  app.post('/api/talks/:id/memories/:index', route((req, res) => {
    const user = requireUser(req);
    const talk = requireTalk(user, req.params.id);
    const proposal = talk.memoryProposals[Number(req.params.index)];
    if (talk.status !== 'done' || !proposal) fail(404, '見つかりません');
    proposal.votes[user.id] = Boolean(req.body?.approve);
    const rel = db.relationships[talk.relationshipId];
    const approved = rel.memberIds.length === 2 && rel.memberIds.every((id) => proposal.votes[id] === true);
    if (approved && !proposal.memoryId) {
      const mem = {
        id: newId(),
        relationshipId: rel.id,
        text: proposal.text,
        sourceTalkId: talk.id,
        sourceTheme: talk.theme,
        createdAt: new Date().toISOString(),
      };
      db.memories[mem.id] = mem;
      proposal.memoryId = mem.id;
    }
    save();
    res.json({ saved: Boolean(proposal.memoryId) });
  }));

  // --- errors ---------------------------------------------------------------

  app.use('/api', (req, res) => res.status(404).json({ error: '見つかりません' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
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
