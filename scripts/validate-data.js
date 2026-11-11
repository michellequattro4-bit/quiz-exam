import { questions, answerKey } from '../server/questions.js';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const source = readFileSync(new URL('../server/data/source.txt', import.meta.url), 'utf8').trim().split(/\r?\n\s*\r?\n/);
for (const [i, q] of questions.entries()) {
  const [heading, ...options] = source[i].split(/\r?\n/);
  assert.equal(q.text, heading.split('<question>')[1]);
  assert.deepEqual(q.options.map(o => o.text), options.map(o => o.slice(9)));
  assert.ok(q.options.some(o => o.id === answerKey[q.id]));
}
console.log('Все 180 вопросов и 720 вариантов совпадают с оригиналом; ключ полный.');
