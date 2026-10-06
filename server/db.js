// SQLite persistence (single file, WAL). One Node process owns the database.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const newId = (bytes = 9) => crypto.randomBytes(bytes).toString('base64url');
export const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const now = () => new Date().toISOString();
const json = (v) => JSON.stringify(v ?? null);
const parse = (s, fallback) => (s == null ? fallback : JSON.parse(s));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  plan TEXT NOT NULL DEFAULT 'free',
  stripe_customer_id TEXT UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS login_tokens (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS relationships (
  id TEXT PRIMARY KEY,
  invite_code TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  relationship_id TEXT NOT NULL REFERENCES relationships(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY (relationship_id, user_id)
);
CREATE TABLE IF NOT EXISTS talks (
  id TEXT PRIMARY KEY,
  relationship_id TEXT NOT NULL REFERENCES relationships(id) ON DELETE CASCADE,
  theme TEXT NOT NULL,
  created_by TEXT NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  error TEXT,
  synthesis_attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS talks_by_rel ON talks(relationship_id, created_at);
CREATE TABLE IF NOT EXISTS participants (
  talk_id TEXT NOT NULL REFERENCES talks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phase TEXT NOT NULL DEFAULT 'questions',
  answers TEXT NOT NULL DEFAULT '{}',
  chat TEXT NOT NULL DEFAULT '[]',
  api_messages TEXT NOT NULL DEFAULT '[]',
  interview_complete INTEGER NOT NULL DEFAULT 0,
  busy INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (talk_id, user_id)
);
CREATE TABLE IF NOT EXISTS memory_proposals (
  talk_id TEXT NOT NULL REFERENCES talks(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  text TEXT NOT NULL,
  votes TEXT NOT NULL DEFAULT '{}',
  memory_id TEXT,
  PRIMARY KEY (talk_id, idx)
);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  relationship_id TEXT NOT NULL REFERENCES relationships(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  source_talk_id TEXT,
  source_theme TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  talk_id TEXT,
  kind TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_usage_by_time ON ai_usage(created_at);
`;

export function openDb(file = ':memory:') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return createRepo(db);
}

function createRepo(db) {
  const q = (sql) => db.prepare(sql);

  const userRow = (r) => (r ? {
    id: r.id, email: r.email, name: r.name, plan: r.plan, stripeCustomerId: r.stripe_customer_id, createdAt: r.created_at,
  } : null);
  const talkRow = (r) => (r ? {
    id: r.id,
    relationshipId: r.relationship_id,
    theme: r.theme,
    createdBy: r.created_by,
    status: r.status,
    result: parse(r.result, null),
    error: r.error,
    synthesisAttempts: r.synthesis_attempts,
    createdAt: r.created_at,
    completedAt: r.completed_at,
  } : null);
  const participantRow = (r) => (r ? {
    talkId: r.talk_id,
    userId: r.user_id,
    phase: r.phase,
    answers: parse(r.answers, {}),
    chat: parse(r.chat, []),
    apiMessages: parse(r.api_messages, []),
    interviewComplete: Boolean(r.interview_complete),
    busy: Boolean(r.busy),
  } : null);
  const memoryRow = (r) => ({
    id: r.id, relationshipId: r.relationship_id, text: r.text, sourceTalkId: r.source_talk_id, sourceTheme: r.source_theme, createdAt: r.created_at,
  });

  return {
    transaction: (fn) => db.transaction(fn)(),
    close: () => db.close(),

    // --- users & auth -------------------------------------------------------
    userById: (id) => userRow(q('SELECT * FROM users WHERE id = ?').get(id)),
    userByEmail: (email) => userRow(q('SELECT * FROM users WHERE email = ?').get(email)),
    userByCustomer: (cid) => userRow(q('SELECT * FROM users WHERE stripe_customer_id = ?').get(cid)),
    createUser(email) {
      const user = { id: newId(), email, name: null, plan: 'free', createdAt: now() };
      q('INSERT INTO users (id, email, plan, created_at) VALUES (?, ?, ?, ?)').run(user.id, email, user.plan, user.createdAt);
      return user;
    },
    setUserName: (id, name) => q('UPDATE users SET name = ? WHERE id = ?').run(name, id),
    setUserPlan: (id, plan) => q('UPDATE users SET plan = ? WHERE id = ?').run(plan, id),
    setCustomer: (id, cid) => q('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(cid, id),

    createLoginToken(email, token, ttlMs) {
      q('DELETE FROM login_tokens WHERE expires_at < ?').run(now());
      q('INSERT INTO login_tokens (token_hash, email, expires_at) VALUES (?, ?, ?)')
        .run(hashToken(token), email, new Date(Date.now() + ttlMs).toISOString());
    },
    // Single use: returns the email once, then never again.
    consumeLoginToken(token) {
      const row = q('SELECT * FROM login_tokens WHERE token_hash = ?').get(hashToken(token));
      if (!row || row.used_at || row.expires_at < now()) return null;
      q('UPDATE login_tokens SET used_at = ? WHERE token_hash = ?').run(now(), row.token_hash);
      return row.email;
    },
    createSession(userId, token, ttlMs) {
      q('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
        .run(hashToken(token), userId, new Date(Date.now() + ttlMs).toISOString());
    },
    userBySession(token) {
      const row = q(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ?`).get(hashToken(token), now());
      return userRow(row);
    },
    deleteSession: (token) => q('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token)),

    // Removes the user and every relationship they belong to (shared history included).
    deleteUser(id) {
      db.transaction(() => {
        const rels = q('SELECT relationship_id FROM members WHERE user_id = ?').all(id);
        for (const r of rels) q('DELETE FROM relationships WHERE id = ?').run(r.relationship_id);
        q('DELETE FROM users WHERE id = ?').run(id);
      })();
    },

    // --- relationships ------------------------------------------------------
    createRelationship(userId) {
      const rel = { id: newId(), inviteCode: newId(12), createdAt: now() };
      db.transaction(() => {
        q('INSERT INTO relationships (id, invite_code, created_at) VALUES (?, ?, ?)').run(rel.id, rel.inviteCode, rel.createdAt);
        q('INSERT INTO members (relationship_id, user_id, position) VALUES (?, ?, 0)').run(rel.id, userId);
      })();
      return { ...rel, memberIds: [userId] };
    },
    relationship(id) {
      const r = q('SELECT * FROM relationships WHERE id = ?').get(id);
      if (!r) return null;
      const memberIds = q('SELECT user_id FROM members WHERE relationship_id = ? ORDER BY position').all(id).map((m) => m.user_id);
      return { id: r.id, inviteCode: r.invite_code, createdAt: r.created_at, memberIds };
    },
    relationshipByInvite(code) {
      const r = q('SELECT id FROM relationships WHERE invite_code = ?').get(code);
      return r ? this.relationship(r.id) : null;
    },
    relationshipsOf(userId) {
      return q(`SELECT r.id FROM relationships r JOIN members m ON m.relationship_id = r.id
        WHERE m.user_id = ? ORDER BY r.created_at DESC`).all(userId).map((r) => this.relationship(r.id));
    },
    addMember(relId, userId) {
      return db.transaction(() => {
        const count = q('SELECT COUNT(*) n FROM members WHERE relationship_id = ?').get(relId).n;
        if (count >= 2) return false;
        q('INSERT INTO members (relationship_id, user_id, position) VALUES (?, ?, ?)').run(relId, userId, count);
        return true;
      })();
    },
    deleteRelationship: (id) => q('DELETE FROM relationships WHERE id = ?').run(id),

    // --- talks --------------------------------------------------------------
    createTalk({ relationshipId, theme, createdBy }) {
      const talk = { id: newId(), relationshipId, theme, createdBy, status: 'open', createdAt: now() };
      q('INSERT INTO talks (id, relationship_id, theme, created_by, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(talk.id, relationshipId, theme, createdBy, talk.status, talk.createdAt);
      return talk;
    },
    talk: (id) => talkRow(q('SELECT * FROM talks WHERE id = ?').get(id)),
    talksOf: (relId) => q('SELECT * FROM talks WHERE relationship_id = ? ORDER BY created_at DESC').all(relId).map(talkRow),
    countTalksSince: (relId, since) => q('SELECT COUNT(*) n FROM talks WHERE relationship_id = ? AND created_at >= ?').get(relId, since).n,
    updateTalk(id, fields) {
      const cols = { status: 'status', result: 'result', error: 'error', synthesisAttempts: 'synthesis_attempts', completedAt: 'completed_at' };
      for (const [k, v] of Object.entries(fields)) {
        q(`UPDATE talks SET ${cols[k]} = ? WHERE id = ?`).run(k === 'result' ? json(v) : v, id);
      }
    },
    // A server restart means no AI call is still in flight.
    resetInFlight() {
      q('UPDATE participants SET busy = 0').run();
      q(`UPDATE talks SET status = 'error', error = 'サーバー再起動により中断されました。再実行してください。'
        WHERE status = 'synthesizing'`).run();
    },

    participant(talkId, userId) {
      let row = q('SELECT * FROM participants WHERE talk_id = ? AND user_id = ?').get(talkId, userId);
      if (!row) {
        q('INSERT INTO participants (talk_id, user_id) VALUES (?, ?)').run(talkId, userId);
        row = q('SELECT * FROM participants WHERE talk_id = ? AND user_id = ?').get(talkId, userId);
      }
      return participantRow(row);
    },
    findParticipant: (talkId, userId) => participantRow(q('SELECT * FROM participants WHERE talk_id = ? AND user_id = ?').get(talkId, userId)),
    saveParticipant(p) {
      q(`UPDATE participants SET phase = ?, answers = ?, chat = ?, api_messages = ?, interview_complete = ?, busy = ?
        WHERE talk_id = ? AND user_id = ?`)
        .run(p.phase, json(p.answers), json(p.chat), json(p.apiMessages), p.interviewComplete ? 1 : 0, p.busy ? 1 : 0, p.talkId, p.userId);
    },
    // Atomically claims the participant for an AI call; false if one is already running.
    claimParticipant: (talkId, userId) => q('UPDATE participants SET busy = 1 WHERE talk_id = ? AND user_id = ? AND busy = 0').run(talkId, userId).changes === 1,

    // --- memory -------------------------------------------------------------
    setProposals(talkId, texts) {
      db.transaction(() => {
        q('DELETE FROM memory_proposals WHERE talk_id = ?').run(talkId);
        texts.forEach((t, i) => q('INSERT INTO memory_proposals (talk_id, idx, text) VALUES (?, ?, ?)').run(talkId, i, t));
      })();
    },
    proposals: (talkId) => q('SELECT * FROM memory_proposals WHERE talk_id = ? ORDER BY idx').all(talkId)
      .map((r) => ({ index: r.idx, text: r.text, votes: parse(r.votes, {}), memoryId: r.memory_id })),
    // Records a vote; once every member approved, stores the memory exactly once.
    voteProposal(talkId, idx, userId, approve, memberIds) {
      return db.transaction(() => {
        const row = q('SELECT * FROM memory_proposals WHERE talk_id = ? AND idx = ?').get(talkId, idx);
        if (!row) return null;
        const votes = { ...parse(row.votes, {}), [userId]: approve };
        q('UPDATE memory_proposals SET votes = ? WHERE talk_id = ? AND idx = ?').run(json(votes), talkId, idx);
        let memoryId = row.memory_id;
        if (!memoryId && memberIds.length === 2 && memberIds.every((id) => votes[id] === true)) {
          const talk = talkRow(q('SELECT * FROM talks WHERE id = ?').get(talkId));
          memoryId = newId();
          q('INSERT INTO memories (id, relationship_id, text, source_talk_id, source_theme, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(memoryId, talk.relationshipId, row.text, talkId, talk.theme, now());
          q('UPDATE memory_proposals SET memory_id = ? WHERE talk_id = ? AND idx = ?').run(memoryId, talkId, idx);
        }
        return { saved: Boolean(memoryId) };
      })();
    },
    memoriesOf: (relId) => q('SELECT * FROM memories WHERE relationship_id = ? ORDER BY created_at').all(relId).map(memoryRow),
    memory: (id) => {
      const r = q('SELECT * FROM memories WHERE id = ?').get(id);
      return r ? memoryRow(r) : null;
    },
    deleteMemory: (id) => q('DELETE FROM memories WHERE id = ?').run(id),

    // --- AI usage / cost guard ----------------------------------------------
    recordUsage({ talkId, kind, model, inputTokens, outputTokens, costUsd }) {
      q('INSERT INTO ai_usage (talk_id, kind, model, input_tokens, output_tokens, cost_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(talkId ?? null, kind, model, inputTokens, outputTokens, costUsd, now());
    },
    costSince: (since) => q('SELECT COALESCE(SUM(cost_usd), 0) c FROM ai_usage WHERE created_at >= ?').get(since).c,
  };
}
