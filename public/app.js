// comsapo SPA — hash routing, no build step.
const $app = document.getElementById('app');
const $who = document.getElementById('who');
const $banner = document.getElementById('banner');

let me = null;
let pollTimer = null;

const THEME_SUGGESTIONS = ['結婚式の準備について', '家事の分担について', 'お金の使い方について', '最近会話が少ないことについて', '休日の過ごし方について'];
const PHASE_LABEL = { questions: '質問に回答中', interview: 'AIと対話中', done: '回答完了' };
const STATUS_LABEL = { open: '回答中', synthesizing: 'AIが整理中', done: '結果あり', error: 'エラー' };

// --- utilities ---------------------------------------------------------------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-comsapo': '1' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || '通信に失敗しました'), { status: res.status, data });
  return data;
}

function render(html) {
  $app.innerHTML = html;
  window.scrollTo(0, 0);
}

function showError(el, err) {
  if (el) el.textContent = err.message;
}

function busy(button, on, label) {
  if (!button) return;
  if (on) {
    button.dataset.label = button.textContent;
    button.textContent = label || '送信中…';
  } else if (button.dataset.label) {
    button.textContent = button.dataset.label;
  }
  button.disabled = on;
}

// --- router ------------------------------------------------------------------

let site = {};

async function router() {
  clearInterval(pollTimer);
  const raw = location.hash.replace(/^#/, '') || '/';
  const [hash, query] = raw.split('?');
  const params = new URLSearchParams(query || '');
  const [, section, id] = hash.split('/');
  try {
    site = await api('GET', '/api/me');
    me = site.user;
    $who.innerHTML = me?.name ? `<a href="#/account">${esc(me.name)} さん</a>` : '';
    $banner.innerHTML = site.aiMode === 'mock'
      ? '<div class="banner">デモモード：AIの応答は固定の例です（ANTHROPIC_API_KEY を設定すると Claude が応答します）</div>'
      : '';
    if (section === 'login') return viewVerify(id, params.get('next'));
    if (me && !me.name) return viewName(params.get('next') || (section === 'join' ? `#/join/${id}` : ''));
    if (section === 'join') return viewJoin(id);
    if (!me) return viewWelcome();
    if (section === 'account') return viewAccount(params);
    if (section === 'r') return viewRelationship(id);
    if (section === 't') return viewTalk(id);
    return viewHome(site.relationships);
  } catch (err) {
    render(`<div class="card"><p class="error">${esc(err.message)}</p><a class="btn secondary" href="#/">ホームへ</a></div>`);
  }
}
window.addEventListener('hashchange', router);
router();

// --- views -------------------------------------------------------------------

function loginForm({ cta, next = '' }) {
  return `
    <form id="login-form" class="card">
      <label for="email" style="margin-top:0">メールアドレス</label>
      <input id="email" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com" required>
      <label class="check"><input type="checkbox" id="agree" required>
        <span><a href="/legal/terms" target="_blank">利用規約</a>と<a href="/legal/privacy" target="_blank">プライバシーポリシー</a>に同意します（18歳以上の方がご利用いただけます）</span></label>
      <button class="full" type="submit" style="margin-top:12px">${esc(cta)}</button>
      <p class="muted">パスワードは不要です。届いたメールのリンクからログインできます。</p>
      <p class="error" id="err"></p>
    </form>`;
}

function bindLoginForm(next = '') {
  const form = document.getElementById('login-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button');
    busy(btn, true);
    try {
      const res = await api('POST', '/api/auth/request', { email: form.email.value, agree: form.agree.checked, next });
      form.outerHTML = `<div class="card soft"><p><strong>メールを送信しました。</strong></p>
        <p>${esc(form.email.value)} に届いたリンクを15分以内に開いてください。届かない場合は迷惑メールフォルダもご確認ください。</p>
        ${res.url ? `<p class="muted">開発用リンク: <a href="${esc(res.url)}">${esc(res.url)}</a></p>` : ''}</div>`;
    } catch (err) {
      showError(document.getElementById('err'), err);
      busy(btn, false);
    }
  });
}

async function viewVerify(token, next) {
  render('<div class="spinner" role="status" aria-label="ログイン中"></div>');
  try {
    await api('POST', '/api/auth/verify', { token });
    location.replace(safeNext(next) || '#/');
  } catch (err) {
    render(`<div class="card"><p class="error">${esc(err.message)}</p><a class="btn secondary" href="#/">ログイン画面へ</a></div>`);
  }
}

const safeNext = (next) => (next && /^#\/[\w/-]*$/.test(next) ? next : '');

function viewName(next) {
  render(`
    <h1>はじめまして</h1>
    <p class="lead">相手に表示される呼び名を教えてください。</p>
    <form id="name-form" class="card">
      <label for="name" style="margin-top:0">あなたの呼び名</label>
      <input id="name" type="text" maxlength="30" autocomplete="nickname" placeholder="例：はると" required>
      <button class="full" type="submit" style="margin-top:12px">はじめる</button>
      <p class="error" id="err"></p>
    </form>`);
  document.getElementById('name-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    busy(btn, true);
    try {
      await api('PATCH', '/api/me', { name: e.target.name.value });
      const target = safeNext(next);
      if (target && target !== location.hash) location.hash = target;
      else router();
    } catch (err) {
      showError(document.getElementById('err'), err);
      busy(btn, false);
    }
  });
}

function pricing() {
  return `
    <h2>料金</h2>
    <div class="plans">
      <div class="card"><h3>Free</h3><p class="price">0円</p><p>2人で月${site.plans.free.talksPerMonth}回まで話し合いができます。</p></div>
      ${site.billingEnabled ? `<div class="card soft"><h3>Plus</h3><p class="price">${esc(site.priceLabel)}</p>
        <p>月${site.plans.plus.talksPerMonth}回まで。どちらか1人が加入すれば2人とも使えます。</p></div>` : ''}
    </div>`;
}

function viewWelcome() {
  render(`
    <h1>言いにくいことを、<br>AIが“伝わる言葉”に。</h1>
    <p class="lead">恋人・夫婦のすれ違いを、AIが第三者として整理します。どちらが正しいかは決めません。「相手 vs 自分」ではなく「2人 vs すれ違い」へ。</p>
    <div class="card soft stack">
      <div><strong>1.</strong> それぞれが、相手に見えない状態で質問に答えます</div>
      <div><strong>2.</strong> AIが個別に話を聞いて、本音を言葉にします</div>
      <div><strong>3.</strong> 2人とも終わったら、AIが気持ち・すれ違い・次の一歩をまとめます</div>
    </div>
    ${loginForm({ cta: 'メールでログイン / 登録' })}
    ${pricing()}
    <p class="muted">comsapo はカウンセリングや医療の代わりではありません。暴力や身の危険がある場合は、<a href="/legal/support">相談窓口</a>にご相談ください。</p>`);
  bindLoginForm();
}

function viewHome(relationships) {
  const list = relationships.map((r) => `
    <a class="card" href="#/r/${r.id}">
      <div class="row" style="justify-content:space-between">
        <strong>${r.partner ? `${esc(r.partner.name)} さんとの2人の場所` : '招待中のパートナー'}</strong>
        ${r.partner ? '' : '<span class="badge wait">招待待ち</span>'}
      </div>
    </a>`).join('');
  render(`
    <h1>2人の場所</h1>
    <p class="lead">パートナーとつながると、テーマごとに話し合いを作れます。</p>
    ${list || '<p class="muted">まだパートナーとつながっていません。</p>'}
    <button id="new-rel" class="full" style="margin-top:12px">パートナーを招待する</button>
    <p class="error" id="err"></p>`);
  document.getElementById('new-rel').addEventListener('click', async (e) => {
    busy(e.target, true, '作成中…');
    try {
      const rel = await api('POST', '/api/relationships');
      location.hash = `#/r/${rel.id}`;
    } catch (err) {
      showError(document.getElementById('err'), err);
      busy(e.target, false);
    }
  });
}

async function viewJoin(code) {
  const invite = await api('GET', `/api/invites/${encodeURIComponent(code)}`);
  render(`
    <h1>${esc(invite.inviterName)} さんから招待が届いています</h1>
    <p class="lead">comsapo は、2人のすれ違いをAIが第三者として整理するアプリです。あなたの回答がそのまま相手に見えることはありません。</p>
    ${invite.full ? '<p class="error">この招待はすでに使われています。</p>'
    : me ? `<button id="accept" class="full">${esc(me.name)} さんとして参加する</button><p class="error" id="err"></p>`
      : loginForm({ cta: 'メールで参加する' })}`);
  if (invite.full) return;
  if (!me) return bindLoginForm(`#/join/${code}`);
  document.getElementById('accept').addEventListener('click', async (e) => {
    busy(e.target, true);
    try {
      const rel = await api('POST', `/api/invites/${encodeURIComponent(code)}/accept`);
      location.hash = `#/r/${rel.id}`;
    } catch (err) {
      showError(document.getElementById('err'), err);
      busy(e.target, false);
    }
  });
}

function viewAccount(params) {
  const plus = me.plan === 'plus';
  render(`
    <a href="#/" class="muted">← ホームへ</a>
    <h1>アカウント</h1>
    ${params.get('checkout') === 'success' ? '<div class="card soft"><p>お申し込みありがとうございます。反映まで少し時間がかかることがあります。</p></div>' : ''}
    <div class="card">
      <dl class="kv">
        <dt>呼び名</dt><dd>${esc(me.name)}</dd>
        <dt>メールアドレス</dt><dd>${esc(me.email)}</dd>
        <dt>プラン</dt><dd>${plus ? 'Plus' : 'Free'}</dd>
      </dl>
      <div class="row" style="margin-top:12px">
        ${site.billingEnabled && !plus ? '<button id="upgrade">Plus にアップグレード</button>' : ''}
        ${site.billingEnabled && me.hasBilling ? '<button id="portal" class="secondary">お支払い・解約の管理</button>' : ''}
      </div>
      <p class="error" id="err"></p>
    </div>
    ${site.billingEnabled && !plus ? pricing() : ''}
    <h2>データ</h2>
    <div class="card stack">
      <a class="btn secondary" href="/api/me/export" download>自分のデータをダウンロード</a>
      <button id="logout" class="secondary">ログアウト</button>
      <button id="delete" class="ghost danger">アカウントを削除する</button>
    </div>`);
  const $err = document.getElementById('err');
  const go = (path) => async (e) => {
    busy(e.target, true, '移動中…');
    try {
      location.href = (await api('POST', path)).url;
    } catch (err) {
      showError($err, err);
      busy(e.target, false);
    }
  };
  document.getElementById('upgrade')?.addEventListener('click', go('/api/billing/checkout'));
  document.getElementById('portal')?.addEventListener('click', go('/api/billing/portal'));
  document.getElementById('logout').addEventListener('click', async () => {
    await api('POST', '/api/logout');
    location.hash = '#/';
    router();
  });
  document.getElementById('delete').addEventListener('click', async () => {
    if (!confirm('アカウントを削除すると、パートナーとの2人の場所・話し合い・メモもすべて削除され、相手からも見られなくなります。有料プランは解約されます。元に戻せません。削除しますか？')) return;
    await api('DELETE', '/api/me');
    location.hash = '#/';
    router();
  });
}

async function viewRelationship(id) {
  const rel = await api('GET', `/api/relationships/${id}`);
  if (!rel.partner) {
    render(`
      <h1>パートナーを招待</h1>
      <p class="lead">このリンクかQRコードをパートナーに送ってください。相手が参加すると、2人専用の場所ができます。</p>
      <div class="card stack" style="text-align:center">
        <img class="qr" alt="招待用QRコード" src="/api/qr?data=${encodeURIComponent(rel.inviteUrl)}">
        <div class="invite-url">${esc(rel.inviteUrl)}</div>
        <div class="row" style="justify-content:center">
          <button id="copy">リンクをコピー</button>
          ${navigator.share ? '<button id="share" class="secondary">共有…</button>' : ''}
        </div>
      </div>
      <button class="secondary full" id="reload">相手が参加したか確認する</button>`);
    document.getElementById('copy').addEventListener('click', async (e) => {
      await navigator.clipboard?.writeText(rel.inviteUrl);
      e.target.textContent = 'コピーしました';
    });
    document.getElementById('share')?.addEventListener('click', () => navigator.share({ title: 'comsapo', text: '2人の話し合いに招待します', url: rel.inviteUrl }).catch(() => {}));
    document.getElementById('reload').addEventListener('click', router);
    pollTimer = setInterval(async () => {
      const latest = await api('GET', `/api/relationships/${id}`).catch(() => null);
      if (latest?.partner) router();
    }, 5000);
    return;
  }

  const talks = rel.talks.map((t) => {
    const badge = t.status === 'done' ? '<span class="badge ok">結果あり</span>'
      : t.status === 'open' && t.myPhase !== 'done' ? `<span class="badge wait">${PHASE_LABEL[t.myPhase]}</span>`
        : `<span class="badge">${STATUS_LABEL[t.status]}</span>`;
    return `<a class="card" href="#/t/${t.id}"><div class="row" style="justify-content:space-between"><strong>${esc(t.theme)}</strong>${badge}</div>
      <div class="muted">${new Date(t.createdAt).toLocaleDateString('ja-JP')}</div></a>`;
  }).join('');
  const memories = rel.memories.map((m) => `
    <li class="row" style="justify-content:space-between;flex-wrap:nowrap">
      <span>${esc(m.text)} <span class="muted">（${esc(m.sourceTheme)}）</span></span>
      <button class="ghost" data-forget="${m.id}" aria-label="このメモを削除">削除</button>
    </li>`).join('');

  const q = rel.quota;
  render(`
    <h1>${esc(rel.partner.name)} さんとの2人の場所</h1>
    <p class="muted">今月の話し合い ${q.used} / ${q.limit} 回（${q.plan === 'plus' ? 'Plus' : 'Free'}）</p>
    <form id="talk-form" class="card">
      <label for="theme" style="margin-top:0">新しい話し合いのテーマ</label>
      <input id="theme" type="text" maxlength="60" placeholder="例：結婚式の準備について" required>
      <div class="chips">${THEME_SUGGESTIONS.map((s) => `<button type="button" class="chip" data-theme="${esc(s)}">${esc(s)}</button>`).join('')}</div>
      <button class="full" type="submit" style="margin-top:14px">話し合いをはじめる</button>
      <p class="error" id="err"></p>
    </form>
    <h2>これまでの話し合い</h2>
    ${talks || '<p class="muted">まだありません。</p>'}
    <h2>2人のメモ（Relationship Memory）</h2>
    <p class="muted">2人とも保存に同意した内容だけが、次回以降の話し合いでAIに参照されます。どちらからでも削除できます。</p>
    ${memories ? `<ul class="plain card">${memories}</ul>` : '<p class="muted">まだありません。</p>'}
    <button id="dissolve" class="ghost danger" style="margin-top:24px">この2人の場所を解消する</button>`);
  document.getElementById('dissolve').addEventListener('click', async () => {
    if (!confirm('2人の場所を解消すると、これまでの話し合いとメモがすべて削除され、相手からも見られなくなります。元に戻せません。解消しますか？')) return;
    await api('DELETE', `/api/relationships/${id}`);
    location.hash = '#/';
  });

  document.querySelectorAll('[data-theme]').forEach((b) => b.addEventListener('click', () => {
    document.getElementById('theme').value = b.dataset.theme;
  }));
  document.querySelectorAll('[data-forget]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('このメモを削除しますか？AIは今後この内容を参照しなくなります。')) return;
    await api('DELETE', `/api/memories/${b.dataset.forget}`);
    router();
  }));
  document.getElementById('talk-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    busy(btn, true, '作成中…');
    try {
      const talk = await api('POST', `/api/relationships/${id}/talks`, { theme: e.target.theme.value });
      location.hash = `#/t/${talk.id}`;
    } catch (err) {
      const $e = document.getElementById('err');
      showError($e, err);
      if (err.status === 402 && site.billingEnabled && err.data.quota?.plan === 'free') {
        $e.insertAdjacentHTML('beforeend', ' <a href="#/account">Plus プランを見る</a>');
      }
      busy(btn, false);
    }
  });
}

async function viewTalk(id) {
  const talk = await api('GET', `/api/talks/${id}`);
  if (talk.status === 'done') return viewResult(talk);
  if (talk.me.phase === 'questions') return viewQuestions(talk);
  if (talk.me.phase === 'interview') return viewInterview(talk);
  return viewWaiting(talk);
}

function header(talk, step) {
  return `
    <a href="#/r/${talk.relationshipId}" class="muted">← 2人の場所へ</a>
    <h1>${esc(talk.theme)}</h1>
    <div class="progress">${[1, 2, 3].map((i) => `<span class="${i <= step ? 'on' : ''}"></span>`).join('')}</div>`;
}

function viewQuestions(talk) {
  const draftKey = `comsapo-draft-${talk.id}`;
  let draft = {};
  try { draft = JSON.parse(localStorage.getItem(draftKey) || '{}'); } catch { /* ignore */ }
  const value = (qid) => talk.me.answers[qid] || draft[qid] || '';
  render(`
    ${header(talk, 1)}
    <p class="notice">これからいくつか質問します。回答内容は、回答中も回答後も相手にはそのまま表示されません。2人とも終わったら、AIが整理した形でだけ共有されます。</p>
    <form id="q-form">
      ${talk.questions.map((q) => `
        <label for="q-${q.id}">${esc(q.text)}</label>
        <textarea id="q-${q.id}" name="${q.id}" maxlength="2000" placeholder="${esc(q.placeholder)}">${esc(value(q.id))}</textarea>`).join('')}
      <button class="full" type="submit" style="margin-top:20px">回答してAIと話す</button>
      <p class="error" id="err"></p>
    </form>`);
  const form = document.getElementById('q-form');
  const collect = () => Object.fromEntries(talk.questions.map((q) => [q.id, form[q.id].value]));
  form.addEventListener('input', () => {
    try { localStorage.setItem(draftKey, JSON.stringify(collect())); } catch { /* ignore */ }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    busy(btn, true);
    try {
      await api('PUT', `/api/talks/${talk.id}/answers`, { answers: collect(), submit: true });
      try { localStorage.removeItem(draftKey); } catch { /* ignore */ }
      router();
    } catch (err) {
      showError(document.getElementById('err'), err);
      busy(btn, false);
    }
  });
}

function viewInterview(talk) {
  let complete = talk.me.interviewComplete;
  const bubbles = (chat) => chat.map((m) => `<div class="bubble ${m.role === 'assistant' ? 'ai' : 'me'}">${esc(m.content)}</div>`).join('');
  render(`
    ${header(talk, 2)}
    <p class="notice">AIがもう少し詳しく話を聞きます。この会話も相手にはそのまま表示されません。</p>
    <div class="chat" id="chat">${bubbles(talk.me.chat)}</div>
    <div class="composer">
      <form id="msg-form">
        <textarea id="msg" maxlength="2000" placeholder="思ったことをそのまま書いてください"></textarea>
        <div class="row" style="justify-content:space-between;margin-top:8px">
          <button type="button" class="secondary" id="finish">ヒアリングを終える</button>
          <button type="submit" id="send">送信</button>
        </div>
        <p class="error" id="err"></p>
      </form>
    </div>`);
  const $chat = document.getElementById('chat');
  const $err = document.getElementById('err');
  const $send = document.getElementById('send');
  const $msg = document.getElementById('msg');

  const setComplete = (on) => {
    complete = on;
    const finish = document.getElementById('finish');
    finish.className = on ? '' : 'secondary';
    finish.textContent = on ? '回答を完了する' : 'ヒアリングを終える';
    $send.className = on ? 'secondary' : '';
  };
  setComplete(complete);

  async function advance(content) {
    $err.textContent = '';
    $send.disabled = true;
    if (content) $chat.insertAdjacentHTML('beforeend', `<div class="bubble me">${esc(content)}</div>`);
    $chat.insertAdjacentHTML('beforeend', '<div class="typing" id="typing">AIが考えています…</div>');
    $chat.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'end' });
    try {
      const res = await api('POST', `/api/talks/${talk.id}/messages`, content ? { content } : {});
      $chat.innerHTML = bubbles(res.chat);
      setComplete(res.interviewComplete);
      $chat.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'end' });
      return true;
    } catch (err) {
      document.getElementById('typing')?.remove();
      if (content) $chat.lastElementChild?.remove();
      showError($err, err);
      return false;
    } finally {
      $send.disabled = false;
    }
  }

  document.getElementById('msg-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const content = $msg.value.trim();
    if (!content) return;
    $msg.value = '';
    if (!(await advance(content))) $msg.value = content;
  });
  document.getElementById('finish').addEventListener('click', async (e) => {
    if (!complete && !confirm('ヒアリングを終えて回答を完了しますか？完了後は内容を変更できません。')) return;
    busy(e.target, true);
    try {
      await api('POST', `/api/talks/${talk.id}/finish`);
      router();
    } catch (err) {
      showError($err, err);
      busy(e.target, false);
    }
  });
  // The AI asks first.
  if (talk.me.chat.length === 0 && !talk.me.busy) advance();
}

function viewWaiting(talk) {
  const partnerPhase = talk.partner?.phase || 'questions';
  const synthesizing = talk.status === 'synthesizing';
  render(`
    ${header(talk, 3)}
    <ul class="status-list">
      <li><span>${esc(talk.me.name)}（あなた）</span><span class="badge ok">回答完了 ✓</span></li>
      <li><span>${esc(talk.partner?.name || 'パートナー')}</span>
        <span class="badge ${partnerPhase === 'done' ? 'ok' : ''}">${partnerPhase === 'done' ? '回答完了 ✓' : PHASE_LABEL[partnerPhase]}</span></li>
    </ul>
    ${talk.status === 'error' ? `
      <div class="card"><p class="error">${esc(talk.error)}</p>${talk.canRetry ? '<button id="retry">もう一度整理する</button>' : ''}</div>`
    : synthesizing ? `
      <div class="card soft" style="text-align:center">
        <p><strong>2人とも回答が終わりました。</strong></p>
        <p class="muted">AIが2人の気持ちを整理しています。1〜2分ほどかかることがあります。</p>
        <div class="spinner" role="status" aria-label="整理中"></div>
      </div>`
      : `<div class="card soft"><p>${esc(talk.partner?.name || 'パートナー')} さんの回答を待っています。</p>
        <p class="muted">相手が回答を終えると、AIが2人の内容を統合して結果を表示します。このページは自動で更新されます。</p></div>`}`);
  document.getElementById('retry')?.addEventListener('click', async (e) => {
    busy(e.target, true);
    await api('POST', `/api/talks/${talk.id}/retry`).catch(() => {});
    router();
  });
  if (talk.status !== 'error') {
    pollTimer = setInterval(async () => {
      const latest = await api('GET', `/api/talks/${talk.id}`).catch(() => null);
      if (latest && (latest.status !== talk.status || latest.partner?.phase !== partnerPhase)) router();
    }, synthesizing ? 3000 : 5000);
  }
}

function viewResult(talk) {
  const r = talk.result;
  const name = (label) => (label === 'both' ? '2人で' : `${talk.labels[label]} さん`);
  const tag = (label) => `<span class="who-tag ${label}">${esc(name(label))}</span>`;
  render(`
    ${header(talk, 3)}
    ${r.safety_note ? `<div class="card safety"><h3>まず大切なこと</h3><p>${esc(r.safety_note)}</p><p><a href="/legal/support">相談窓口の一覧</a></p></div>` : ''}
    <div class="card soft"><div class="headline">${esc(r.headline)}</div></div>

    <h2>それぞれの気持ち</h2>
    ${r.perspectives.map((p) => `
      <div class="card person ${p.participant}">
        <h3>${esc(talk.labels[p.participant])} さんの気持ち</h3>
        <p>${esc(p.feelings)}</p>
        <dl class="kv">
          <dt>本当に求めていること</dt><dd>${esc(p.needs)}</dd>
          <dt>相手に感謝していること</dt><dd>${esc(p.appreciation)}</dd>
        </dl>
      </div>`).join('')}

    <h2>2人に共通していること</h2>
    <div class="card"><ul class="plain">${r.common_ground.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div>

    <h2>AIが考えるすれ違い</h2>
    <div class="card"><p>${esc(r.misalignment)}</p></div>

    <h2>次にできること</h2>
    ${r.actions.map((a) => `<div class="card">${tag(a.owner)}<p>${esc(a.action)}</p></div>`).join('')}

    ${r.phrasing_tips.length ? `<h2>伝え方の言い換え</h2>
    ${r.phrasing_tips.map((t) => `<div class="card tip">${tag(t.owner)}
      <p class="before">${esc(t.instead_of)}</p><p>→ ${esc(t.try_saying)}</p></div>`).join('')}` : ''}

    <h2>話し始めの一言</h2>
    <div class="card soft"><p>「${esc(r.conversation_starter)}」</p></div>

    ${talk.memoryProposals.length ? `
      <h2>今後の話し合いのために保存しますか？</h2>
      <p class="muted">2人とも「保存する」を選んだ内容だけが Relationship Memory に保存され、次回以降AIが参照します。</p>
      ${talk.memoryProposals.map((p) => `
        <div class="card">
          <p>${esc(p.text)}</p>
          ${p.saved ? '<span class="badge ok">保存済み ✓</span>' : `
            <div class="row">
              <button data-mem="${p.index}" data-approve="1" class="${p.myVote === true ? '' : 'secondary'}">保存する</button>
              <button data-mem="${p.index}" data-approve="0" class="${p.myVote === false ? '' : 'secondary'}">保存しない</button>
              <span class="muted">${p.partnerVoted ? '相手は回答済み' : '相手の回答待ち'}</span>
            </div>`}
        </div>`).join('')}` : ''}
    <a class="btn secondary full" href="#/r/${talk.relationshipId}" style="margin-top:20px">2人の場所へ戻る</a>`);
  document.querySelectorAll('[data-mem]').forEach((b) => b.addEventListener('click', async () => {
    await api('POST', `/api/talks/${talk.id}/memories/${b.dataset.mem}`, { approve: b.dataset.approve === '1' });
    const y = window.scrollY;
    await router();
    window.scrollTo(0, y);
  }));
}
