import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { questions, answerKey, version } from './questions.js';

const hash = value => createHash('sha256').update(value).digest();
const safeEqual = (a, b) => timingSafeEqual(hash(a), hash(b));
const uuid = /^[a-f0-9-]{36}$/i;
const bad = message => Object.assign(new Error(message), { status: 400 });
const publicDir = fileURLToPath(new URL('../public/', import.meta.url));

export function createApp({ adminPassword, databasePath = './data/quiz.sqlite', secureCookie = false, trustProxy = false } = {}) {
  if (!adminPassword || adminPassword.length < 12) throw new Error('Укажите ADMIN_PASSWORD длиной не менее 12 символов в .env. См. .env.example.');
  if (databasePath !== ':memory:') mkdirSync(dirname(resolve(databasePath)), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.function('casefold', { deterministic: true }, value => String(value ?? '').toLocaleLowerCase('ru-RU'));
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      public_id TEXT NOT NULL UNIQUE, token_hash TEXT NOT NULL,
      name TEXT NOT NULL, group_name TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL, completed_at TEXT,
      correct INTEGER, incorrect INTEGER, skipped INTEGER, percentage REAL,
      answers_json TEXT NOT NULL DEFAULT '[]', snapshot_json TEXT NOT NULL,
      version TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS attempts_completed ON attempts(completed_at);
  `);
  const sessions = new Map();
  const app = express();
  app.disable('x-powered-by');
  if (trustProxy) app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: { directives: { 'script-src': ["'self'"], 'style-src': ["'self'"], 'img-src': ["'self'", 'data:'], 'upgrade-insecure-requests': null } } }));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (['POST', 'DELETE', 'PUT', 'PATCH'].includes(req.method)) {
      const origin = req.get('origin');
      if (origin && origin !== `${req.protocol}://${req.get('host')}`) return res.status(403).json({ error: 'Запрос с другого сайта запрещён.' });
      if (!req.is('application/json')) return res.status(415).json({ error: 'Ожидается JSON.' });
    }
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  const limiter = (limit, windowMs) => rateLimit({ windowMs, limit, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Слишком много запросов. Попробуйте немного позже.' } });
  app.use('/api/attempts', limiter(500, 15 * 60_000));
  app.use('/api/submit', limiter(500, 15 * 60_000));
  const cookieOptions = { httpOnly: true, sameSite: 'strict', secure: secureCookie, path: '/api/admin' };
  const sessionToken = req => {
    const raw = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('quiz_admin='));
    return raw?.slice('quiz_admin='.length) ?? '';
  };
  const admin = (req, res, next) => {
    const token = sessionToken(req);
    const expires = sessions.get(token);
    if (!expires || expires < Date.now()) {
      sessions.delete(token);
      return res.status(401).json({ error: 'Войдите в панель администратора.' });
    }
    next();
  };
  app.get('/api/questions', (req, res) => res.json({ version, total: questions.length, questions }));
  app.post('/api/attempts', (req, res) => {
    const { name, group = '', version: clientVersion } = req.body ?? {};
    if (typeof name !== 'string' || name.trim().length < 3 || name.trim().length > 120 || name.trim().split(/\s+/).length < 2 || /[\x00-\x1f]/.test(name)) throw bad('Укажите имя и фамилию (до 120 символов).');
    if (typeof group !== 'string' || group.length > 80 || /[\x00-\x1f]/.test(group)) throw bad('Название группы должно быть не длиннее 80 символов.');
    if (clientVersion !== version) return res.status(409).json({ error: 'Вопросы обновились. Перезагрузите страницу.' });
    const attemptId = randomUUID();
    const token = randomBytes(32).toString('hex');
    const startedAt = new Date().toISOString();
    const snapshot = questions.map(q => ({ ...q, correctOption: answerKey[q.id] }));
    db.prepare('INSERT INTO attempts (public_id, token_hash, name, group_name, started_at, snapshot_json, version) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(attemptId, hash(token).toString('hex'), name.trim(), group.trim(), startedAt, JSON.stringify(snapshot), version);
    res.status(201).json({ attemptId, token, startedAt });
  });
  function attemptFor(req) {
    const { attemptId, token } = req.body ?? {};
    if (typeof attemptId !== 'string' || !uuid.test(attemptId) || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw bad('Некорректные данные попытки.');
    const row = db.prepare('SELECT * FROM attempts WHERE public_id = ?').get(attemptId);
    if (!row || !safeEqual(row.token_hash, hash(token).toString('hex'))) throw Object.assign(new Error('Попытка не найдена или доступ запрещён.'), { status: 404 });
    return row;
  }
  app.post('/api/attempts/resume', (req, res) => {
    const row = attemptFor(req);
    res.json({ completed: Boolean(row.completed_at), version: row.version, questions: JSON.parse(row.snapshot_json).map(({ correctOption, ...q }) => q) });
  });
  app.post('/api/submit', (req, res) => {
    const row = attemptFor(req);
    if (row.completed_at) return res.json({ message: 'Тест завершён. Ответы успешно отправлены.' });
    const { answers } = req.body;
    const snapshot = JSON.parse(row.snapshot_json);
    if (!Array.isArray(answers) || answers.length > snapshot.length) throw bad('Некорректный список ответов.');
    const ids = new Set();
    for (const a of answers) {
      if (!a || !Number.isInteger(a.questionId) || !snapshot.some(q => q.id === a.questionId) || ids.has(a.questionId) || typeof a.optionId !== 'string' || !/^[ABCD]$/.test(a.optionId)) throw bad('Проверьте номера вопросов и выбранные варианты.');
      ids.add(a.questionId);
    }
    const selected = new Map(answers.map(a => [a.questionId, a.optionId]));
    const correct = snapshot.filter(q => selected.get(q.id) === q.correctOption).length;
    const incorrect = answers.length - correct;
    const skipped = snapshot.length - answers.length;
    const percentage = Math.round(correct / snapshot.length * 10000) / 100;
    db.prepare('UPDATE attempts SET completed_at = ?, correct = ?, incorrect = ?, skipped = ?, percentage = ?, answers_json = ? WHERE id = ? AND completed_at IS NULL')
      .run(new Date().toISOString(), correct, incorrect, skipped, percentage, JSON.stringify(answers.map(({ questionId, optionId }) => ({ questionId, optionId }))), row.id);
    res.json({ message: 'Тест завершён. Ответы успешно отправлены.' });
  });
  app.post('/api/admin/login', limiter(10, 15 * 60_000), (req, res) => {
    const password = req.body?.password;
    if (typeof password !== 'string' || password.length > 1024 || !safeEqual(password, adminPassword)) return res.status(401).json({ error: 'Неверный пароль.' });
    for (const [token, expiry] of sessions) if (expiry < Date.now()) sessions.delete(token);
    sessions.delete(sessionToken(req));
    const token = randomBytes(32).toString('hex');
    sessions.set(token, Date.now() + 8 * 60 * 60_000);
    res.cookie('quiz_admin', token, { ...cookieOptions, maxAge: 8 * 60 * 60_000 }).json({ ok: true });
  });
  app.use('/api/admin', admin);
  app.get('/api/admin/session', (req, res) => res.json({ ok: true }));
  app.post('/api/admin/logout', (req, res) => {
    sessions.delete(sessionToken(req));
    res.clearCookie('quiz_admin', cookieOptions).json({ ok: true });
  });
  function results(req) {
    const search = typeof req.query.search === 'string' ? req.query.search.slice(0, 120) : '';
    const sort = req.query.sort === 'percentage' ? 'percentage' : 'completed_at';
    const direction = req.query.direction === 'asc' ? 'ASC' : 'DESC';
    return db.prepare(`SELECT id, name, group_name, started_at, completed_at, correct, incorrect, skipped, percentage FROM attempts WHERE completed_at IS NOT NULL AND casefold(name) LIKE casefold(?) ESCAPE '\\' ORDER BY ${sort} ${direction}, id DESC`)
      .all(`%${search.replace(/[\\%_]/g, '\\$&')}%`);
  }
  app.get('/api/admin/results', (req, res) => res.json({ results: results(req) }));
  app.get('/api/admin/results/export.csv', (req, res) => {
    const cell = value => {
      let s = String(value ?? '');
      if (/^[\s]*[=+@-]/.test(s)) s = "'" + s;
      return '"' + s.replaceAll('"', '""') + '"';
    };
    const rows = [['ID', 'Имя', 'Группа', 'Начало (UTC)', 'Завершение (UTC)', 'Правильных', 'Неправильных', 'Пропущенных', 'Процент'], ...results(req).map(r => [r.id, r.name, r.group_name, r.started_at, r.completed_at, r.correct, r.incorrect, r.skipped, r.percentage])];
    res.type('text/csv').attachment('quiz-results.csv').send('\uFEFF' + rows.map(row => row.map(cell).join(';')).join('\r\n'));
  });
  const resultRow = req => {
    if (!/^[1-9]\d*$/.test(req.params.id)) throw bad('Некорректный ID.');
    const row = db.prepare('SELECT * FROM attempts WHERE id = ? AND completed_at IS NOT NULL').get(Number(req.params.id));
    if (!row) throw Object.assign(new Error('Результат не найден.'), { status: 404 });
    return row;
  };
  app.get('/api/admin/results/:id', (req, res) => {
    const row = resultRow(req);
    const answers = new Map(JSON.parse(row.answers_json).map(a => [a.questionId, a.optionId]));
    const { token_hash, snapshot_json, public_id, answers_json, ...attempt } = row;
    res.json({ attempt, questions: JSON.parse(snapshot_json).map(q => ({ ...q, selectedOption: answers.get(q.id) ?? null, result: !answers.has(q.id) ? 'skipped' : answers.get(q.id) === q.correctOption ? 'correct' : 'incorrect' })) });
  });
  app.delete('/api/admin/results/:id', (req, res) => {
    const row = resultRow(req);
    db.prepare('DELETE FROM attempts WHERE id = ?').run(row.id);
    res.json({ ok: true });
  });
  app.get('/admin', (req, res) => res.sendFile(resolve(publicDir, 'admin.html')));
  app.use(express.static(publicDir, { dotfiles: 'deny', index: 'index.html' }));
  app.use((req, res) => res.status(404).json({ error: 'Страница не найдена.' }));
  app.use((err, req, res, next) => {
    const status = err.status ?? 500;
    if (status >= 500) console.error('Ошибка сервера:', err.message);
    res.status(status).json({ error: status >= 500 ? 'Не удалось выполнить запрос. Попробуйте ещё раз.' : err.type === 'entity.parse.failed' ? 'Некорректный JSON.' : err.message });
  });
  return { app, db };
}
