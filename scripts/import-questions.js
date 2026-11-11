import { readFileSync, writeFileSync } from 'node:fs';
const source = new URL('../server/data/source.txt', import.meta.url);
const text = readFileSync(source, 'utf8').replace(/^\uFEFF/, '').trim();
const blocks = text.split(/\r?\n\s*\r?\n/);
const questions = blocks.map((block, index) => {
  const [heading, ...variants] = block.split(/\r?\n/);
  const match = heading.match(/^(\d+)\.\s*<question>(.+)$/);
  if (!match || Number(match[1]) !== index + 1 || variants.length !== 4 || variants.some(v => !v.startsWith('<variant>'))) {
    throw new Error(`Некорректный блок вопроса ${index + 1}`);
  }
  return { id: Number(match[1]), text: match[2], options: variants.map((v, i) => ({ id: 'ABCD'[i], text: v.slice(9) })) };
});
if (questions.length !== 180) throw new Error(`Ожидалось 180 вопросов, получено ${questions.length}`);
writeFileSync(new URL('../server/data/questions.json', import.meta.url), JSON.stringify(questions, null, 2) + '\n');
console.log(`Импортировано ${questions.length} вопросов без изменения текста и порядка вариантов.`);
