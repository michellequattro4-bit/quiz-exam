const $ = id => document.getElementById(id);
const STORAGE_KEY = 'quiz-exam:draft:v1';
let questions = [], version, draft = null, sending = false;
const screens = ['loading', 'welcome', 'quiz', 'review', 'success'];
function screen(name) { screens.forEach(id => { $(id).hidden = id !== name; }); }
function error(message) { $('global-error').textContent = message; $('global-error').hidden = !message; }
async function api(path, body) {
  let response;
  try { response = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
  catch { throw new Error('Нет связи с сервером. Проверьте подключение и попробуйте снова. Ваши ответы сохранены.'); }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Ошибка сервера. Попробуйте снова.');
  return data;
}
function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(draft)); $('storage-warning').hidden = true; }
  catch { $('storage-warning').hidden = false; }
  document.querySelector('.save-status').textContent = $('storage-warning').hidden ? 'Сохранено в браузере' : 'Сохранено в этой вкладке';
}
function removeDraft() { try { localStorage.removeItem(STORAGE_KEY); } catch {} }
const count = () => questions.filter(q => /^[ABCD]$/.test(draft.answers[q.id] ?? '')).length;
function complete() { draft = null; removeDraft(); screen('success'); error(''); }
function renderMap() {
  $('question-map').replaceChildren();
  questions.forEach((q, i) => {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = i + 1;
    button.className = 'map-button' + (draft.answers[q.id] ? ' answered' : '') + (draft.index === i ? ' current' : '');
    button.setAttribute('aria-label', `Вопрос ${i + 1}${draft.answers[q.id] ? ', ответ выбран' : ', без ответа'}`);
    if (draft.index === i) button.setAttribute('aria-current', 'step');
    button.onclick = () => go(i);
    $('question-map').append(button);
  });
}
function renderQuestion(focus = false) {
  const q = questions[draft.index];
  screen('quiz');
  $('participant').textContent = draft.name + (draft.group ? ` · ${draft.group}` : '');
  $('question-counter').textContent = `Вопрос ${draft.index + 1} из ${questions.length}`;
  $('answered-count').textContent = `Отвечено: ${count()}`;
  $('progress').value = count(); $('progress').max = questions.length;
  $('question-text').textContent = q.text;
  $('options').replaceChildren();
  q.options.forEach(option => {
    const label = document.createElement('label'); label.className = 'option';
    const input = document.createElement('input'); input.type = 'radio'; input.name = 'answer'; input.value = option.id; input.checked = draft.answers[q.id] === option.id;
    const marker = document.createElement('span'); marker.className = 'option-letter'; marker.textContent = option.id;
    const text = document.createElement('span'); text.className = 'option-text'; text.textContent = option.text;
    input.onchange = () => { draft.answers[q.id] = option.id; save(); $('answered-count').textContent = `Отвечено: ${count()}`; $('progress').value = count(); $('clear-answer').disabled = false; renderMap(); };
    label.append(input, marker, text); $('options').append(label);
  });
  $('clear-answer').disabled = !draft.answers[q.id];
  $('previous').disabled = draft.index === 0;
  $('next').textContent = draft.index === questions.length - 1 ? 'К отправке →' : 'Далее →';
  renderMap();
  if (focus) $('question-text').focus({ preventScroll: true });
}
function go(index) { draft.index = index; save(); renderQuestion(true); window.scrollTo({ top: 0 }); }
function review() {
  screen('review'); const answered = count(), skipped = questions.length - answered;
  $('review-summary').textContent = `Вы ответили на ${answered} из ${questions.length} вопросов`;
  $('skip-warning').hidden = skipped === 0;
  $('skip-warning').textContent = `Пропущено вопросов: ${skipped}. Их можно оставить без ответа и отправить тест.`;
  $('first-skipped').hidden = skipped === 0;
  $('finish').focus(); window.scrollTo({ top: 0 });
}
$('start-form').onsubmit = async event => {
  event.preventDefault(); error(''); const button = $('start-button'); button.disabled = true; button.textContent = 'Начинаем…';
  try {
    const name = $('name').value.trim(), group = $('group').value.trim();
    const attempt = await api('/api/attempts', { name, group, version });
    questions = attempt.questions;
    draft = { attemptId: attempt.attemptId, token: attempt.token, startedAt: attempt.startedAt, name, group, answers: {}, index: 0, version: attempt.version }; save(); renderQuestion(true);
  } catch (e) { error(e.message); }
  finally { button.disabled = false; button.textContent = 'Начать тест →'; }
};
$('previous').onclick = () => go(draft.index - 1);
$('next').onclick = () => draft.index < questions.length - 1 ? go(draft.index + 1) : review();
$('clear-answer').onclick = () => { delete draft.answers[questions[draft.index].id]; save(); renderQuestion(); };
$('open-review').onclick = review;
$('back-to-test').onclick = () => renderQuestion(true);
$('first-skipped').onclick = () => go(questions.findIndex(q => !draft.answers[q.id]));
$('finish').onclick = () => { $('confirm-error').hidden = true; $('confirm-dialog').showModal(); };
$('confirm-dialog').addEventListener('cancel', event => { if (sending) event.preventDefault(); });
$('confirm-submit').onclick = async () => {
  if (sending) return;
  sending = true; $('confirm-submit').disabled = true; $('cancel-submit').disabled = true; $('finish').disabled = true; $('confirm-submit').textContent = 'Отправляем…';
  try {
    await api('/api/submit', { attemptId: draft.attemptId, token: draft.token, answers: Object.entries(draft.answers).map(([id, optionId]) => ({ questionId: Number(id), optionId })) });
    $('confirm-dialog').close(); complete();
  } catch (e) { $('confirm-error').hidden = false; $('confirm-error').textContent = e.message; }
  finally { sending = false; $('confirm-submit').disabled = false; $('cancel-submit').disabled = false; $('finish').disabled = false; $('confirm-submit').textContent = 'Да, отправить'; }
};
$('new-test').onclick = () => location.reload();
window.addEventListener('beforeunload', event => { if (draft) { event.preventDefault(); event.returnValue = ''; } });
async function init() {
  try {
    const data = await api('/api/questions'); version = data.version;
    try { draft = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch { removeDraft(); }
    if (draft && typeof draft.attemptId === 'string' && typeof draft.token === 'string' && draft.answers && typeof draft.answers === 'object' && !Array.isArray(draft.answers)) {
      const resumed = await api('/api/attempts/resume', { attemptId: draft.attemptId, token: draft.token });
      if (resumed.completed) return complete();
      questions = resumed.questions; version = resumed.version;
      draft.answers = Object.fromEntries(Object.entries(draft.answers).filter(([id, value]) => questions.some(q => q.id === Number(id)) && typeof value === 'string' && /^[ABCD]$/.test(value)));
      draft.index = Number.isInteger(draft.index) ? Math.max(0, Math.min(draft.index, questions.length - 1)) : 0;
      save(); renderQuestion();
    } else { draft = null; screen('welcome'); }
  } catch (e) { screen('loading'); $('loading').textContent = 'Не удалось загрузить тест. Перезагрузите страницу, чтобы повторить попытку.'; error(e.message); }
}
init();
