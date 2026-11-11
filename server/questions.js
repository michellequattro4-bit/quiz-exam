import { readFileSync } from 'node:fs';
import { createHash, randomInt } from 'node:crypto';
export const questions = JSON.parse(readFileSync(new URL('./data/questions.json', import.meta.url), 'utf8'));
export const answerKey = JSON.parse(readFileSync(new URL('./data/answer-key.json', import.meta.url), 'utf8'));
if (questions.length !== 180 || Object.keys(answerKey).length !== 180) throw new Error('Требуется ровно 180 вопросов и ответов');
for (const [index, q] of questions.entries()) {
  if (q.id !== index + 1 || !q.text || q.options.length !== 4 || q.options.some((o, i) => o.id !== 'ABCD'[i] || !o.text) || typeof answerKey[q.id] !== 'string' || !/^[ABCD]$/.test(answerKey[q.id])) throw new Error(`Некорректные данные вопроса ${q.id}`);
}
export const attemptSize = 40;
export const version = createHash('sha256').update(JSON.stringify({ questions, answerKey, attemptSize })).digest('hex').slice(0, 16);

// Fisher–Yates over a copy: each question has the same chance of being selected.
// Called only when creating a new attempt; its ordered snapshot is stored in SQLite.
export function selectQuestions() {
  const shuffled = [...questions];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, attemptSize);
}
