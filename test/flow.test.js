import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.js';
import { createAI } from '../server/ai.js';
import { createApp } from '../server/app.js';

let server;
let base;
let app;
let store;

before(async () => {
  store = createStore(null);
  app = createApp({ store, ai: createAI({ mode: 'mock' }) });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

// Tiny cookie-keeping client, one per simulated person.
function client() {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
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

test('full flow: pair, answer privately, synthesize, agree on memory', async () => {
  const a = client();
  const b = client();
  assert.equal((await a('GET', '/api/me')).body.user, null);
  assert.equal((await a('POST', '/api/users', { name: 'はると' })).status, 201);
  assert.equal((await b('POST', '/api/users', { name: 'みお' })).status, 201);

  const rel = (await a('POST', '/api/relationships')).body;
  assert.match(rel.inviteUrl, /#\/join\//);
  const code = rel.inviteUrl.split('/join/')[1];
  assert.equal((await b('GET', `/api/invites/${code}`)).body.inviterName, 'はると');
  assert.equal((await b('POST', `/api/invites/${code}/accept`)).body.partner.name, 'はると');

  // A third person cannot take the seat or read the pair.
  const c = client();
  await c('POST', '/api/users', { name: 'outsider' });
  assert.equal((await c('POST', `/api/invites/${code}/accept`)).status, 409);
  assert.equal((await c('GET', `/api/relationships/${rel.id}`)).status, 404);

  const talk = (await a('POST', `/api/relationships/${rel.id}/talks`, { theme: '結婚式の準備について' })).body;

  await completeTalk(a, talk.id, ANSWERS_A);

  // B sees only A's progress, never A's words.
  const bView = (await b('GET', `/api/talks/${talk.id}`)).body;
  assert.equal(bView.partner.phase, 'done');
  assert.equal(bView.result, null);
  assert.ok(!JSON.stringify(bView).includes(ANSWERS_A.hurt));

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
  const memories = (await b('GET', `/api/relationships/${rel.id}`)).body.memories;
  assert.equal(memories.length, 1);

  // The saved memory is fed into the next interview's opening context.
  const talk2 = (await b('POST', `/api/relationships/${rel.id}/talks`, { theme: '家事について' })).body;
  await b('PUT', `/api/talks/${talk2.id}/answers`, { answers: ANSWERS_B, submit: true });
  const bId = (await b('GET', '/api/me')).body.user.id;
  const opening = store.db.talks[talk2.id].participants[bId].apiMessages[0].content;
  assert.ok(opening.includes(memories[0].text));

  // Either partner can withdraw it.
  assert.equal((await a('DELETE', `/api/memories/${memories[0].id}`)).status, 200);
  assert.equal((await a('GET', `/api/relationships/${rel.id}`)).body.memories.length, 0);
});

test('guards: auth, validation, phase order', async () => {
  const a = client();
  assert.equal((await a('POST', '/api/relationships')).status, 401);
  assert.equal((await a('POST', '/api/users', { name: '' })).status, 400);
  await a('POST', '/api/users', { name: 'solo' });
  const rel = (await a('POST', '/api/relationships')).body;
  assert.equal((await a('POST', `/api/relationships/${rel.id}/talks`, { theme: '' })).status, 400);
  const talk = (await a('POST', `/api/relationships/${rel.id}/talks`, { theme: 'お金について' })).body;
  assert.equal((await a('POST', `/api/talks/${talk.id}/messages`, { content: 'hi' })).status, 409);
  assert.equal((await a('PUT', `/api/talks/${talk.id}/answers`, { answers: {}, submit: true })).status, 400);
  // Draft save without submit is fine.
  assert.equal((await a('PUT', `/api/talks/${talk.id}/answers`, { answers: { feeling: 'もやもや' } })).status, 200);
  assert.equal((await a('GET', `/api/talks/${talk.id}`)).body.me.answers.feeling, 'もやもや');
});
