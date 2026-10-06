import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { createAI, AIError } from '../server/ai.js';
import { createApp, monthStartJst } from '../server/app.js';
import { loadConfig } from '../server/config.js';

let server;
let base;
let app;
let repo;
let overBudget = false;

before(async () => {
  repo = openDb(':memory:');
  const config = loadConfig({ FREE_TALKS_PER_MONTH: '2', LOGIN_RATE_LIMIT: '1000' });
  const ai = createAI({
    mode: 'mock',
    guard() {
      if (overBudget) throw new AIError('budget');
    },
  });
  const mailer = { sendLoginLink: async () => {} };
  app = createApp({ repo, ai, config, mailer, billing: { enabled: false }, exposeLoginLink: true });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  repo.close();
});

// Tiny cookie-keeping client, one per simulated person.
function client() {
  let cookie = '';
  const call = async (method, url, body, { csrf = true } = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
        ...(csrf && method !== 'GET' ? { 'x-comsapo': '1' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  call.login = async (email, name) => {
    const req = await call('POST', '/api/auth/request', { email, agree: true });
    assert.equal(req.status, 200);
    const token = req.body.url.split('/login/')[1];
    const verify = await call('POST', '/api/auth/verify', { token });
    assert.equal(verify.status, 200);
    if (name) assert.equal((await call('PATCH', '/api/me', { name })).status, 200);
    // Login links are single use.
    assert.equal((await call('POST', '/api/auth/verify', { token })).status, 400);
  };
  return call;
}

const ANSWERS_A = {
  feeling: '自分ばかり準備していて寂しい',
  gratitude: '仕事が忙しいのに話は聞いてくれる',
  hurt: '式場の見積もりを全部一人で比較した',
  wish: 'もっと一緒に考えてほしかった',
  self: '頼み方が曖昧だったかも',
  goal: '2人で楽しく準備したい',
};
const ANSWERS_B = {
  feeling: '任せすぎたかもしれないと思っている',
  gratitude: '段取りが上手',
  hurt: '急に怒られて驚いた',
  wish: 'してほしいことは具体的に言ってほしい',
  self: '自分から聞けばよかった',
  goal: '仲良く当日を迎えたい',
};

async function completeTalk(call, talkId, answers) {
  assert.equal((await call('PUT', `/api/talks/${talkId}/answers`, { answers, submit: true })).status, 200);
  const opening = await call('POST', `/api/talks/${talkId}/messages`, {});
  assert.equal(opening.status, 200);
  assert.equal(opening.body.chat[0].role, 'assistant');
  const reply = await call('POST', `/api/talks/${talkId}/messages`, { content: '週末にずっと一人で調べていたとき' });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.chat.length, 3);
  assert.equal((await call('POST', `/api/talks/${talkId}/finish`)).status, 200);
}

async function pair(a, b) {
  const rel = (await a('POST', '/api/relationships')).body;
  const code = rel.inviteUrl.split('/join/')[1];
  assert.equal((await b('POST', `/api/invites/${code}/accept`)).status, 200);
  return { rel, code };
}

test('full flow: login, pair, answer privately, synthesize, agree on memory', async () => {
  const a = client();
  const b = client();
  assert.equal((await a('GET', '/api/me')).body.user, null);
  await a.login('haruto@example.com', 'はると');
  await b.login('mio@example.com', 'みお');

  const rel = (await a('POST', '/api/relationships')).body;
  const code = rel.inviteUrl.split('/join/')[1];
  assert.equal((await b('GET', `/api/invites/${code}`)).body.inviterName, 'はると');
  assert.equal((await b('POST', `/api/invites/${code}/accept`)).body.partner.name, 'はると');

  // A third person cannot take the seat or read the pair.
  const c = client();
  await c.login('outsider@example.com', 'outsider');
  assert.equal((await c('POST', `/api/invites/${code}/accept`)).status, 409);
  assert.equal((await c('GET', `/api/relationships/${rel.id}`)).status, 404);

  const talk = (await a('POST', `/api/relationships/${rel.id}/talks`, { theme: '結婚式の準備について' })).body;
  await completeTalk(a, talk.id, ANSWERS_A);

  // B sees only A's progress, never A's words.
  const bView = (await b('GET', `/api/talks/${talk.id}`)).body;
  assert.equal(bView.partner.phase, 'done');
  assert.equal(bView.result, null);
  assert.ok(!JSON.stringify(bView).includes(ANSWERS_A.hurt));
  assert.equal((await c('GET', `/api/talks/${talk.id}`)).status, 404);

  await completeTalk(b, talk.id, ANSWERS_B);
  await Promise.all(app.locals.pending);

  const resultA = (await a('GET', `/api/talks/${talk.id}`)).body;
  assert.equal(resultA.status, 'done');
  assert.equal(resultA.result.perspectives.length, 2);
  assert.deepEqual(resultA.labels, { A: 'はると', B: 'みお' });
  assert.ok(!JSON.stringify(resultA).includes(ANSWERS_B.hurt), 'raw answers stay private');

  // Memory needs both approvals.
  assert.equal((await a('POST', `/api/talks/${talk.id}/memories/0`, { approve: true })).body.saved, false);
  assert.equal((await b('POST', `/api/talks/${talk.id}/memories/0`, { approve: true })).body.saved, true);
  const { memories } = (await b('GET', `/api/relationships/${rel.id}`)).body;
  assert.equal(memories.length, 1);

  // The saved memory is fed into the next interview's opening context.
  const talk2 = (await b('POST', `/api/relationships/${rel.id}/talks`, { theme: '家事について' })).body;
  await b('PUT', `/api/talks/${talk2.id}/answers`, { answers: ANSWERS_B, submit: true });
  const bId = (await b('GET', '/api/me')).body.user.id;
  assert.ok(repo.findParticipant(talk2.id, bId).apiMessages[0].content.includes(memories[0].text));

  // Export contains my own words and the shared result, but not the partner's raw answers.
  const exported = (await a('GET', '/api/me/export')).body;
  const exportedText = JSON.stringify(exported);
  assert.ok(exportedText.includes(ANSWERS_A.hurt));
  assert.ok(!exportedText.includes(ANSWERS_B.hurt));

  // Either partner can withdraw a memory.
  assert.equal((await a('DELETE', `/api/memories/${memories[0].id}`)).status, 200);
  assert.equal((await a('GET', `/api/relationships/${rel.id}`)).body.memories.length, 0);
});

test('free plan quota is per pair per month', async () => {
  const a = client();
  const b = client();
  await a.login('q1@example.com', 'q1');
  await b.login('q2@example.com', 'q2');
  const { rel } = await pair(a, b);
  for (let i = 0; i < 2; i += 1) {
    assert.equal((await b('POST', `/api/relationships/${rel.id}/talks`, { theme: `t${i}` })).status, 201);
  }
  const blocked = await a('POST', `/api/relationships/${rel.id}/talks`, { theme: 'over' });
  assert.equal(blocked.status, 402);
  assert.equal(blocked.body.quota.plan, 'free');

  // Either partner upgrading lifts the pair's limit.
  repo.setUserPlan((await a('GET', '/api/me')).body.user.id, 'plus');
  const relView = (await b('GET', `/api/relationships/${rel.id}`)).body;
  assert.equal(relView.quota.plan, 'plus');
  assert.equal((await b('POST', `/api/relationships/${rel.id}/talks`, { theme: 'ok' })).status, 201);
});

test('account deletion removes shared spaces for both partners', async () => {
  const a = client();
  const b = client();
  await a.login('del1@example.com', 'del1');
  await b.login('del2@example.com', 'del2');
  const { rel } = await pair(a, b);
  const talk = (await a('POST', `/api/relationships/${rel.id}/talks`, { theme: 'x' })).body;
  await a('PUT', `/api/talks/${talk.id}/answers`, { answers: ANSWERS_A, submit: true });

  assert.equal((await a('DELETE', '/api/me')).status, 200);
  assert.equal((await a('GET', '/api/me')).body.user, null);
  assert.equal((await b('GET', `/api/relationships/${rel.id}`)).status, 404);
  assert.equal(repo.talk(talk.id), null);
  assert.equal(repo.userByEmail('del1@example.com'), null);
});

test('AI failures roll back the unanswered message and report cleanly', async () => {
  const a = client();
  const b = client();
  await a.login('ai1@example.com', 'ai1');
  await b.login('ai2@example.com', 'ai2');
  const { rel } = await pair(a, b);
  const talk = (await a('POST', `/api/relationships/${rel.id}/talks`, { theme: 'x' })).body;
  await a('PUT', `/api/talks/${talk.id}/answers`, { answers: ANSWERS_A, submit: true });
  await a('POST', `/api/talks/${talk.id}/messages`, {});

  overBudget = true;
  try {
    const res = await a('POST', `/api/talks/${talk.id}/messages`, { content: 'hello' });
    assert.equal(res.status, 502);
  } finally {
    overBudget = false;
  }
  const view = (await a('GET', `/api/talks/${talk.id}`)).body;
  assert.equal(view.me.chat.length, 1);
  assert.equal(view.me.busy, false);
  assert.equal((await a('POST', `/api/talks/${talk.id}/messages`, { content: 'hello' })).status, 200);
});

test('guards: auth, csrf, validation, phase order', async () => {
  const a = client();
  assert.equal((await a('POST', '/api/relationships')).status, 401);
  assert.equal((await a('POST', '/api/auth/request', { email: 'bad' })).status, 400);
  assert.equal((await a('POST', '/api/auth/request', { email: 'x@example.com' })).status, 400, 'consent required');
  assert.equal((await a('POST', '/api/auth/verify', { token: 'nope' })).status, 400);

  await a.login('solo@example.com');
  assert.equal((await a('POST', '/api/relationships')).status, 403, 'name required first');
  await a('PATCH', '/api/me', { name: 'solo' });
  assert.equal((await a('POST', '/api/relationships', undefined, { csrf: false })).status, 403, 'csrf header required');

  const rel = (await a('POST', '/api/relationships')).body;
  assert.equal((await a('POST', `/api/relationships/${rel.id}/talks`, { theme: 'x' })).status, 409, 'partner required');
  assert.equal((await a('GET', `/api/qr?data=${encodeURIComponent('https://evil.example')}`)).status, 400);
});

test('monthStartJst uses Japan time', () => {
  assert.equal(monthStartJst(new Date('2026-10-31T16:00:00Z')), '2026-10-31T15:00:00.000Z');
  assert.equal(monthStartJst(new Date('2026-10-31T14:00:00Z')), '2026-09-30T15:00:00.000Z');
});

test('stripe webhook rejects unsigned payloads', async () => {
  const { createBilling } = await import('../server/billing.js');
  const config = loadConfig({ STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PRICE_ID: 'price_x', STRIPE_WEBHOOK_SECRET: 'whsec_x', LOGIN_RATE_LIMIT: '1000' });
  const billing = createBilling(config, repo);
  assert.equal(billing.enabled, true);
  const app2 = createApp({ repo, ai: createAI({ mode: 'mock' }), config, mailer: {}, billing });
  const srv = app2.listen(0);
  await new Promise((r) => srv.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/stripe/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=bad' },
      body: JSON.stringify({ type: 'customer.subscription.updated' }),
    });
    assert.equal(res.status, 400);
  } finally {
    srv.close();
  }
});
