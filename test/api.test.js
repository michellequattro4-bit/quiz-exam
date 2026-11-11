import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { questions, answerKey } from '../server/questions.js';
const correct = q => answerKey[q.id];
const wrong = q => 'ABCD'[('ABCD'.indexOf(correct(q)) + 1) % 4];

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
  assert.equal(response.status, 200); assert.deepEqual(Object.keys(data).sort(), ['total', 'version']); assert.equal(data.total, 40); version = data.version;
  assert.equal(questions.length, 180);
  const source = readFileSync(new URL('../server/data/source.txt', import.meta.url), 'utf8').trim().split(/\r?\n\s*\r?\n/);
  questions.forEach((q, i) => {
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
  assert.equal(attempt.questions.length, 40);
  assert.equal(new Set(attempt.questions.map(q => q.id)).size, 40);
  for (const q of attempt.questions) assert.deepEqual(q, questions.find(original => original.id === q.id));
  assert.ok(!JSON.stringify(attempt).includes('correctOption'));
});
test('попытка требует секретный токен; восстановление не содержит ключа', async () => {
  assert.equal((await request('/api/submit', 'POST', { ...attempt, token: '0'.repeat(64), answers: [] })).response.status, 404);
  const result = await request('/api/attempts/resume', 'POST', attempt);
  assert.equal(result.data.completed, false); assert.equal(result.data.questions.length, 40);
  assert.ok(!JSON.stringify(result.data).includes('correctOption'));
  assert.deepEqual(result.data.questions, attempt.questions);
  assert.deepEqual((await request('/api/attempts/resume', 'POST', attempt)).data.questions, attempt.questions);
});

test('новые ученики получают свои уникальные перемешанные наборы; база не меняется', async () => {
  const original = JSON.stringify(questions);
  const draws = [attempt.questions.map(q => q.id)];
  for (let i = 0; i < 5; i++) {
    const { data, response } = await request('/api/attempts', 'POST', { name: `Другой Участник ${i}`, version });
    assert.equal(response.status, 201);
    const ids = data.questions.map(q => q.id);
    assert.equal(ids.length, 40); assert.equal(new Set(ids).size, 40);
    assert.ok(ids.every(id => questions.some(q => q.id === id)));
    assert.notDeepEqual(ids, [...ids].sort((a, b) => a - b));
    assert.ok(draws.every(previous => JSON.stringify([...previous].sort()) !== JSON.stringify([...ids].sort())));
    draws.push(ids);
    db.prepare('DELETE FROM attempts WHERE public_id = ?').run(data.attemptId);
  }
  assert.equal(JSON.stringify(questions), original);
});
test('незавершённая попытка сохраняет все 40 вопросов и порядок после перезапуска', async () => {
  await new Promise(resolve => server.close(resolve)); db.close();
  ({ app, db } = createApp({ adminPassword: password, databasePath: join(temp, 'test.sqlite') }));
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); }); base = `http://127.0.0.1:${server.address().port}`;
  const { data } = await request('/api/attempts/resume', 'POST', attempt);
  assert.equal(data.completed, false); assert.deepEqual(data.questions, attempt.questions);
});
test('неизвестные вопросы, дубли и недопустимые варианты отклоняются', async () => {
  const id = attempt.questions[0].id;
  const outside = questions.find(q => !attempt.questions.some(selected => selected.id === q.id)).id;
  for (const answers of [null, [{ questionId: outside, optionId: 'A' }], [{ questionId: 181, optionId: 'A' }], [{ questionId: id, optionId: 'E' }], [{ questionId: id, optionId: 0 }], [{ questionId: id, optionId: 'A' }, { questionId: id, optionId: 'B' }], Array.from({ length: 41 }, () => ({ questionId: id, optionId: 'A' }))]) {
    assert.equal((await request('/api/submit', 'POST', { ...attempt, answers })).response.status, 400);
  }
});
test('сервер считает 2 правильных, 1 неправильный, 37 пропущенных; поддельный score игнорируется', async () => {
  const { response, data } = await request('/api/submit', 'POST', { ...attempt, score: 180, percentage: 100, answers: attempt.questions.slice(0, 3).map((q, i) => ({ questionId: q.id, optionId: i < 2 ? correct(q) : wrong(q) })) });
  assert.equal(response.status, 200); assert.deepEqual(data, { message: 'Тест завершён. Ответы успешно отправлены.' });
  const saved = db.prepare('SELECT * FROM attempts WHERE public_id = ?').get(attempt.attemptId);
  assert.equal(saved.correct, 2); assert.equal(saved.incorrect, 1); assert.equal(saved.skipped, 37); assert.equal(saved.percentage, 5);
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
test('детали содержат 40 вопросов этой попытки, ответы участника, ключ и статусы', async () => {
  const { data } = await request('/api/admin/results/1', 'GET', undefined, true);
  assert.equal(data.questions.length, 40);
  assert.equal(data.questions[0].result, 'correct'); assert.equal(data.questions[2].result, 'incorrect'); assert.equal(data.questions[3].result, 'skipped');
  assert.deepEqual(data.questions.map(q => q.id), attempt.questions.map(q => q.id));
  assert.equal(data.questions[2].correctOption, correct(attempt.questions[2])); assert.equal(data.questions[2].selectedOption, wrong(attempt.questions[2]));
});
test('пропуск всего теста, поиск, сортировка и CSV с защитой формул', async () => {
  const start = await request('/api/attempts', 'POST', { name: '=SUM(1) Студент', group: 'Класс "А"', version });
  await request('/api/submit', 'POST', { ...start.data, answers: [] });
  const { data } = await request('/api/admin/results?sort=percentage&direction=asc', 'GET', undefined, true);
  assert.equal(data.results[0].percentage, 0); assert.equal(data.results[0].skipped, 40); secondId = data.results[0].id;
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

test('полностью правильная и полностью неправильная попытки оцениваются от 40', async () => {
  for (const allCorrect of [true, false]) {
    const { data: started } = await request('/api/attempts', 'POST', { name: 'Полная Попытка', version });
    const { response } = await request('/api/submit', 'POST', { ...started, answers: started.questions.map(q => ({ questionId: q.id, optionId: allCorrect ? correct(q) : wrong(q) })) });
    assert.equal(response.status, 200);
    const row = db.prepare('SELECT * FROM attempts WHERE public_id = ?').get(started.attemptId);
    assert.equal(row.correct, allCorrect ? 40 : 0); assert.equal(row.incorrect, allCorrect ? 0 : 40);
    assert.equal(row.skipped, 0); assert.equal(row.percentage, allCorrect ? 100 : 0);
    assert.equal((await request('/api/admin/results/' + row.id, 'DELETE', {}, true)).response.status, 200);
  }
});
test('выход отзывает сессию', async () => {
  assert.equal((await request('/api/admin/logout', 'POST', {}, true)).response.status, 200);
  assert.equal((await request('/api/admin/results', 'GET', undefined, true)).response.status, 401);
});
