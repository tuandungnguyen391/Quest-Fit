const path = require('path');
const http = require('http');
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { WebSocketServer } = require('ws');
const { pool, initSchema } = require('./db');

const SPORTS = [
  'basketball','football','american-football','tennis','running','cycling',
  'swimming','volleyball','yoga','golf','boxing','climbing','baseball','hiking','badminton'
];

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- tiny query helpers ----------
async function one(sql, params) { const r = await pool.query(sql, params); return r.rows[0] || null; }
async function many(sql, params) { const r = await pool.query(sql, params); return r.rows; }

// Wraps an async route handler so a thrown error becomes a 500 response
// instead of crashing the process or hanging the request.
function ah(fn) {
  return (req, res) => fn(req, res).catch(err => {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server.' });
  });
}

// In-memory token -> userId map. Each browser TAB holds its own token
// (in sessionStorage, not a cookie), so multiple tabs in the same browser
// can be logged in as different accounts at once. Tokens are lost if the
// server restarts, which just means everyone has to log back in.
const sessions = new Map();

function createToken(userId) {
  const token = crypto.randomUUID();
  sessions.set(token, userId);
  return token;
}
function getUserIdFromReq(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  return sessions.get(token) || null;
}

// ---------- live chat (WebSocket) ----------
// Tracks which open sockets belong to which user, so a new chat message can
// be pushed to the recipient the instant it's sent, without them refreshing.
const socketsByUser = new Map(); // userId -> Set<ws>

function registerSocket(userId, ws) {
  if (!socketsByUser.has(userId)) socketsByUser.set(userId, new Set());
  socketsByUser.get(userId).add(ws);
}
function unregisterSocket(userId, ws) {
  const set = socketsByUser.get(userId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) socketsByUser.delete(userId);
}
function pushToUser(userId, payload) {
  const set = socketsByUser.get(userId);
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

// ---------- helpers ----------
function publicUser(row, sports) {
  return { id: row.id, name: row.name, age: row.age, gender: row.gender, sports };
}
async function getSportsForUser(userId) {
  const rows = await many('SELECT sport_id FROM user_sports WHERE user_id = $1', [userId]);
  return rows.map(r => r.sport_id);
}
function requireAuth(req, res, next) {
  const userId = getUserIdFromReq(req);
  if (!userId) return res.status(401).json({ error: 'Not logged in.' });
  req.userId = userId;
  next();
}
function validEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
function validPassword(pw) {
  return typeof pw === 'string' &&
    pw.length >= 8 &&
    /[A-Z]/.test(pw) &&
    /[a-z]/.test(pw) &&
    /[0-9]/.test(pw) &&
    /[^A-Za-z0-9]/.test(pw);
}
function matchKey(idA, idB) {
  return idA < idB ? [idA, idB] : [idB, idA];
}
async function findMatch(idA, idB) {
  const [a, b] = matchKey(idA, idB);
  return one('SELECT * FROM matches WHERE user_a = $1 AND user_b = $2', [a, b]);
}

// ---------- auth ----------
app.post('/api/signup', ah(async (req, res) => {
  const { name, email, password, age, gender, sports } = req.body || {};

  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Enter a name.' });
  }
  if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (!validPassword(password)) {
    return res.status(400).json({ error: 'Password needs 8+ characters, an uppercase letter, a lowercase letter, a number, and a symbol.' });
  }
  const ageNum = Number(age);
  if (!ageNum || ageNum < 13 || ageNum > 100) return res.status(400).json({ error: 'Enter a valid age (13-100).' });
  if (!gender || typeof gender !== 'string') return res.status(400).json({ error: 'Select a gender.' });
  if (!Array.isArray(sports) || sports.length === 0 || !sports.every(s => SPORTS.includes(s))) {
    return res.status(400).json({ error: "Pick at least one sport you're interested in." });
  }

  const cleanName = name.trim();
  const existingName = await one('SELECT id FROM users WHERE LOWER(name) = LOWER($1)', [cleanName]);
  if (existingName) return res.status(409).json({ error: 'That name is already taken - try another.' });
  const existingEmail = await one('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email.trim()]);
  if (existingEmail) return res.status(409).json({ error: 'An account with that email already exists.' });

  const hash = bcrypt.hashSync(password, 10);

  const client = await pool.connect();
  let userId;
  try {
    await client.query('BEGIN');
    const result = await client.query(
      'INSERT INTO users (name, email, password_hash, age, gender, created_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [cleanName, email.trim(), hash, ageNum, gender, Date.now()]
    );
    userId = result.rows[0].id;
    for (const s of sports) {
      await client.query('INSERT INTO user_sports (user_id, sport_id) VALUES ($1,$2)', [userId, s]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const token = createToken(userId);
  res.json({ user: publicUser({ id: userId, name: cleanName, age: ageNum, gender }, sports), token });
}));

app.post('/api/login', ah(async (req, res) => {
  const { email, password } = req.body || {};
  if (!validEmail(email) || !password) return res.status(400).json({ error: 'Enter your email and password.' });

  const row = await one('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email.trim()]);
  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  const token = createToken(row.id);
  res.json({ user: publicUser(row, await getSportsForUser(row.id)), token });
}));

app.post('/api/logout', (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (token) sessions.delete(token);
  res.json({ ok: true });
});

app.get('/api/me', ah(async (req, res) => {
  const userId = getUserIdFromReq(req);
  if (!userId) return res.json({ user: null });
  const row = await one('SELECT * FROM users WHERE id = $1', [userId]);
  if (!row) return res.json({ user: null });
  res.json({ user: publicUser(row, await getSportsForUser(row.id)) });
}));

// ---------- discover ----------
app.get('/api/discover', requireAuth, ah(async (req, res) => {
  const me = await one('SELECT * FROM users WHERE id = $1', [req.userId]);
  const mySports = await getSportsForUser(me.id);

  const candidates = mySports.length === 0 ? [] : await many(`
    SELECT DISTINCT u.* FROM users u
    JOIN user_sports us ON us.user_id = u.id
    WHERE u.id != $1
      AND us.sport_id = ANY($2)
      AND u.id NOT IN (SELECT target_id FROM swipes WHERE user_id = $1)
      AND NOT EXISTS (
        SELECT 1 FROM matches m WHERE (m.user_a = $1 AND m.user_b = u.id) OR (m.user_a = u.id AND m.user_b = $1)
      )
  `, [req.userId, mySports]);

  const withSports = [];
  for (const c of candidates) {
    const cs = await getSportsForUser(c.id);
    const shared = cs.filter(s => mySports.includes(s));
    withSports.push({ user: publicUser(c, cs), sharedCount: shared.length });
  }
  withSports.sort((a, b) => b.sharedCount - a.sharedCount);

  res.json({ candidates: withSports.map(w => w.user) });
}));

app.post('/api/swipe', requireAuth, ah(async (req, res) => {
  const { targetName, action } = req.body || {};
  if (!['like', 'pass'].includes(action)) return res.status(400).json({ error: 'Invalid action.' });

  const target = await one('SELECT * FROM users WHERE LOWER(name) = LOWER($1)', [targetName || '']);
  if (!target) return res.status(404).json({ error: 'Profile not found.' });

  await pool.query(`
    INSERT INTO swipes (user_id, target_id, action, created_at) VALUES ($1,$2,$3,$4)
    ON CONFLICT (user_id, target_id) DO UPDATE SET action = EXCLUDED.action
  `, [req.userId, target.id, action, Date.now()]);

  if (action !== 'like') {
    return res.json({ ok: true, status: 'passed' });
  }

  const existing = await findMatch(req.userId, target.id);
  let status;

  if (!existing) {
    // First request between these two people: create it as pending and
    // notify the target that someone wants to match with them.
    const [a, b] = matchKey(req.userId, target.id);
    await pool.query(
      'INSERT INTO matches (user_a, user_b, status, requested_by, created_at) VALUES ($1,$2,$3,$4,$5)',
      [a, b, 'pending', req.userId, Date.now()]
    );
    status = 'pending';
    const me = await one('SELECT name FROM users WHERE id = $1', [req.userId]);
    pushToUser(target.id, { type: 'match_request', fromName: me.name });
  } else if (existing.status === 'pending' && existing.requested_by !== req.userId) {
    // The other person already requested to match with me - my like
    // instantly accepts it, same as a mutual match.
    await pool.query('UPDATE matches SET status = $1 WHERE id = $2', ['accepted', existing.id]);
    status = 'accepted';
    const me = await one('SELECT name FROM users WHERE id = $1', [req.userId]);
    pushToUser(existing.requested_by, { type: 'match_accepted', withName: me.name });
  } else {
    // Already pending (I already requested them) or already accepted.
    status = existing.status;
  }

  res.json({
    ok: true,
    status,
    matched: status === 'accepted',
    match: publicUser(target, await getSportsForUser(target.id))
  });
}));

// ---------- search ----------
app.get('/api/search', requireAuth, ah(async (req, res) => {
  const { sport, minAge, maxAge, name } = req.query;
  let rows = await many('SELECT * FROM users WHERE id != $1', [req.userId]);

  rows = rows.filter(u => {
    if (name && !u.name.toLowerCase().includes(String(name).toLowerCase())) return false;
    if (minAge && u.age < Number(minAge)) return false;
    if (maxAge && u.age > Number(maxAge)) return false;
    return true;
  });

  const results = [];
  for (const row of rows) {
    const sports = await getSportsForUser(row.id);
    if (sport && !sports.includes(sport)) continue;
    results.push(publicUser(row, sports));
  }

  res.json({ results });
}));

// ---------- matches & chat ----------
app.get('/api/matches', requireAuth, ah(async (req, res) => {
  const rows = await many(
    'SELECT * FROM matches WHERE user_a = $1 OR user_b = $1 ORDER BY created_at DESC',
    [req.userId]
  );

  const incoming = [], sent = [], accepted = [];
  for (const m of rows) {
    const otherId = m.user_a === req.userId ? m.user_b : m.user_a;
    const other = await one('SELECT * FROM users WHERE id = $1', [otherId]);
    const entry = { matchId: m.id, ts: Number(m.created_at), other: publicUser(other, await getSportsForUser(other.id)) };

    if (m.status === 'accepted') accepted.push(entry);
    else if (m.requested_by === req.userId) sent.push(entry);
    else incoming.push(entry);
  }
  res.json({ incoming, sent, accepted });
}));

app.post('/api/matches/:matchId/accept', requireAuth, ah(async (req, res) => {
  const m = await one('SELECT * FROM matches WHERE id = $1', [req.params.matchId]);
  if (!m || (m.user_a !== req.userId && m.user_b !== req.userId)) {
    return res.status(404).json({ error: 'Match request not found.' });
  }
  if (m.status !== 'pending') return res.status(400).json({ error: 'This request has already been responded to.' });
  if (m.requested_by === req.userId) return res.status(403).json({ error: "You can't accept your own request." });

  await pool.query('UPDATE matches SET status = $1 WHERE id = $2', ['accepted', m.id]);

  const me = await one('SELECT name FROM users WHERE id = $1', [req.userId]);
  pushToUser(m.requested_by, { type: 'match_accepted', withName: me.name });

  res.json({ ok: true });
}));

app.post('/api/matches/:matchId/decline', requireAuth, ah(async (req, res) => {
  const m = await one('SELECT * FROM matches WHERE id = $1', [req.params.matchId]);
  if (!m || (m.user_a !== req.userId && m.user_b !== req.userId)) {
    return res.status(404).json({ error: 'Match request not found.' });
  }
  if (m.status !== 'pending') return res.status(400).json({ error: 'This request has already been responded to.' });
  if (m.requested_by === req.userId) return res.status(403).json({ error: "You can't decline your own request." });

  await pool.query('DELETE FROM matches WHERE id = $1', [m.id]);
  // Record it as a pass so this person doesn't reappear in Discover.
  await pool.query(`
    INSERT INTO swipes (user_id, target_id, action, created_at) VALUES ($1,$2,'pass',$3)
    ON CONFLICT (user_id, target_id) DO UPDATE SET action = 'pass'
  `, [req.userId, m.requested_by, Date.now()]);

  res.json({ ok: true });
}));

app.get('/api/chat/:name', requireAuth, ah(async (req, res) => {
  const other = await one('SELECT * FROM users WHERE LOWER(name) = LOWER($1)', [req.params.name]);
  if (!other) return res.status(404).json({ error: 'Profile not found.' });
  const m = await findMatch(req.userId, other.id);
  if (!m || m.status !== 'accepted') return res.status(403).json({ error: 'You are not matched with this person yet.' });

  const messages = await many('SELECT * FROM messages WHERE match_id = $1 ORDER BY created_at ASC', [m.id]);
  res.json({
    messages: messages.map(msg => ({
      from: msg.sender_id === req.userId ? 'me' : 'them',
      text: msg.body,
      ts: Number(msg.created_at)
    }))
  });
}));

app.post('/api/chat/:name', requireAuth, ah(async (req, res) => {
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'Message cannot be empty.' });

  const other = await one('SELECT * FROM users WHERE LOWER(name) = LOWER($1)', [req.params.name]);
  if (!other) return res.status(404).json({ error: 'Profile not found.' });
  const m = await findMatch(req.userId, other.id);
  if (!m || m.status !== 'accepted') return res.status(403).json({ error: 'You are not matched with this person yet.' });

  const ts = Date.now();
  await pool.query(
    'INSERT INTO messages (match_id, sender_id, body, created_at) VALUES ($1,$2,$3,$4)',
    [m.id, req.userId, text.trim(), ts]
  );

  const me = await one('SELECT name FROM users WHERE id = $1', [req.userId]);
  pushToUser(other.id, {
    type: 'message',
    withName: me.name,
    message: { from: 'them', text: text.trim(), ts }
  });

  res.json({ ok: true, message: { from: 'me', text: text.trim(), ts } });
}));

const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  const userId = token ? sessions.get(token) : null;
  if (!userId) { ws.close(4001, 'Unauthorized'); return; }

  ws.userId = userId;
  registerSocket(userId, ws);
  ws.on('close', () => unregisterSocket(userId, ws));
  ws.on('error', () => unregisterSocket(userId, ws));
});

const PORT = process.env.PORT || 3000;
initSchema()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Quest Fit server running at http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to set up the database:', err.message);
    process.exit(1);
  });
