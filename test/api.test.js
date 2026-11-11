import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';

const password = 'test-only-password-42';
const temp = mkdtempSync(join(tmpdir(), 'quiz-api-'));
let app, db, server, base, version, cookie, attempt, secondId;
const request = async (path, method = 'GET', body, admin = false, headers = {}) => {
  const response = await fetch(base + path, { method, headers: { ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}), ...(admin ? { Cookie: cookie } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text();
  return { response, data };
};
before(async () => {
  ({ app, db } = createApp({ adminPassword: password, databasePath: join(temp, 'test.sqlite') }));
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); rmSync(temp, { recursive: true, force: true }); });

test('180 вопросов, 720 вариантов, точное совпадение с источником; ключ не отправляется', async () => {
  const { response, data } = await request('/api/questions');
  assert.equal(response.status, 200); assert.equal(data.questions.length, 180); version = data.version;
  const source = readFileSync(new URL('../server/data/source.txt', import.meta.url), 'utf8').trim().split(/\r?\n\s*\r?\n/);
  data.questions.forEach((q, i) => {
    assert.deepEqual(Object.keys(q).sort(), ['id', 'options', 'text']);
    const [line, ...options] = source[i].split(/\r?\n/);
    assert.equal(q.text, line.split('<question>')[1]);
    assert.deepEqual(q.options, options.map((v, j) => ({ id: 'ABCD'[j], text: v.slice(9) })));
  });
  assert.ok(!JSON.stringify(data).includes('correct'));
});
test('серверные данные и .env недоступны через HTTP; admin API закрыт', async () => {
  for (const path of ['/server/data/answer-key.json', '/server/data/source.txt', '/.env', '/data/quiz.sqlite', '/server/app.js']) assert.equal((await request(path)).response.status, 404);
  for (const path of ['/api/admin/results', '/api/admin/results/1', '/api/admin/results/export.csv']) assert.equal((await request(path)).response.status, 401);
  assert.equal((await request('/api/admin/results/1', 'DELETE', {})).response.status, 401);
});
test('валидация имени, группы и версии; начало фиксирует сервер', async () => {
  for (const body of [{ name: 'Иван', version }, { name: 'Иван Иванов', group: 123, version }, { name: 'Иван Иванов', version: 'old' }]) {
    assert.ok((await request('/api/attempts', 'POST', body)).response.status >= 400);
  }
  const result = await request('/api/attempts', 'POST', { name: 'Тестовый Участник', group: 'ИБ-21', version, startedAt: '2000-01-01' });
  assert.equal(result.response.status, 201); attempt = result.data;
  assert.ok(Date.now() - Date.parse(attempt.startedAt) < 10_000);
});
test('попытка требует секретный токен; восстановление не содержит ключа', async () => {
  assert.equal((await request('/api/submit', 'POST', { ...attempt, token: '0'.repeat(64), answers: [] })).response.status, 404);
  const result = await request('/api/attempts/resume', 'POST', attempt);
  assert.equal(result.data.completed, false); assert.equal(result.data.questions.length, 180);
  assert.ok(!JSON.stringify(result.data).includes('correctOption'));
});
test('неизвестные вопросы, дубли и недопустимые варианты отклоняются', async () => {
  for (const answers of [null, [{ questionId: 181, optionId: 'A' }], [{ questionId: 1, optionId: 'E' }], [{ questionId: 1, optionId: 0 }], [{ questionId: 1, optionId: 'A' }, { questionId: 1, optionId: 'B' }]]) {
    assert.equal((await request('/api/submit', 'POST', { ...attempt, answers })).response.status, 400);
  }
});
test('сервер считает 2 правильных, 1 неправильный, 177 пропущенных; поддельный score игнорируется', async () => {
  const { response, data } = await request('/api/submit', 'POST', { ...attempt, score: 180, percentage: 100, answers: [{ questionId: 1, optionId: 'A' }, { questionId: 2, optionId: 'B' }, { questionId: 3, optionId: 'A' }] });
  assert.equal(response.status, 200); assert.deepEqual(data, { message: 'Тест завершён. Ответы успешно отправлены.' });
  const saved = db.prepare('SELECT * FROM attempts WHERE public_id = ?').get(attempt.attemptId);
  assert.equal(saved.correct, 2); assert.equal(saved.incorrect, 1); assert.equal(saved.skipped, 177); assert.equal(saved.percentage, 1.11);
  assert.ok(saved.completed_at >= saved.started_at); assert.equal(JSON.parse(saved.answers_json).length, 3);
});
test('одновременная повторная отправка не дублирует и не меняет результат', async () => {
  const responses = await Promise.all(Array.from({ length: 5 }, () => request('/api/submit', 'POST', { ...attempt, answers: [] })));
  assert.ok(responses.every(r => r.response.status === 200));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE completed_at IS NOT NULL').get().n, 1);
  assert.equal(db.prepare('SELECT correct FROM attempts').get().correct, 2);
  assert.equal((await request('/api/attempts/resume', 'POST', attempt)).data.completed, true);
});
test('логин, защищённая cookie и список сохранённых результатов', async () => {
  assert.equal((await request('/api/admin/login', 'POST', { password: 'wrong' })).response.status, 401);
  const login = await request('/api/admin/login', 'POST', { password }); assert.equal(login.response.status, 200);
  const header = login.response.headers.get('set-cookie'); assert.match(header, /HttpOnly/); assert.match(header, /SameSite=Strict/i);
  cookie = header.split(';')[0];
  const { data } = await request('/api/admin/results', 'GET', undefined, true);
  assert.equal(data.results.length, 1); assert.equal(data.results[0].name, 'Тестовый Участник');
  assert.equal(data.results[0].correct, 2); assert.ok(!JSON.stringify(data).includes('token'));
});
test('детали содержат все 180 вопросов, ответы участника, ключ и статусы', async () => {
  const { data } = await request('/api/admin/results/1', 'GET', undefined, true);
  assert.equal(data.questions.length, 180);
  assert.equal(data.questions[0].result, 'correct'); assert.equal(data.questions[2].result, 'incorrect'); assert.equal(data.questions[3].result, 'skipped');
  assert.equal(data.questions[2].correctOption, 'C'); assert.equal(data.questions[2].selectedOption, 'A');
});
test('пропуск всего теста, поиск, сортировка и CSV с защитой формул', async () => {
  const start = await request('/api/attempts', 'POST', { name: '=SUM(1) Студент', group: 'Класс "А"', version });
  await request('/api/submit', 'POST', { ...start.data, answers: [] });
  const { data } = await request('/api/admin/results?sort=percentage&direction=asc', 'GET', undefined, true);
  assert.equal(data.results[0].percentage, 0); assert.equal(data.results[0].skipped, 180); secondId = data.results[0].id;
  assert.equal((await request('/api/admin/results?search=' + encodeURIComponent('Студент'), 'GET', undefined, true)).data.results.length, 1);
  assert.equal((await request('/api/admin/results?search=' + encodeURIComponent('студент'), 'GET', undefined, true)).data.results.length, 1);
  assert.equal((await request('/api/admin/results?search=%25', 'GET', undefined, true)).data.results.length, 0);
  const csv = await request('/api/admin/results/export.csv', 'GET', undefined, true);
  assert.match(csv.response.headers.get('content-type'), /text\/csv/); assert.match(csv.data, /'=SUM\(1\)/); assert.match(csv.data, /Класс ""А""/);
});
test('запросы с другого origin и без JSON блокируются', async () => {
  assert.equal((await request('/api/admin/results/1', 'DELETE', {}, true, { Origin: 'https://evil.example' })).response.status, 403);
  const r = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' }); assert.equal(r.status, 415);
});
test('SQLite переживает перезапуск; после повторного входа удаление работает', async () => {
  await new Promise(resolve => server.close(resolve)); db.close();
  ({ app, db } = createApp({ adminPassword: password, databasePath: join(temp, 'test.sqlite') }));
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); }); base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await request('/api/admin/results', 'GET', undefined, true)).response.status, 401);
  cookie = (await request('/api/admin/login', 'POST', { password })).response.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/api/admin/results', 'GET', undefined, true)).data.results.length, 2);
  for (const id of [1, secondId]) assert.equal((await request('/api/admin/results/' + id, 'DELETE', {}, true)).response.status, 200);
  assert.equal((await request('/api/admin/results/1', 'GET', undefined, true)).response.status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n, 0);
});
test('выход отзывает сессию', async () => {
  assert.equal((await request('/api/admin/logout', 'POST', {}, true)).response.status, 200);
  assert.equal((await request('/api/admin/results', 'GET', undefined, true)).response.status, 401);
});
