const $ = id => document.getElementById(id);
let currentId = null, deleteId = null, deleting = false, requestSerial = 0;
const date = value => new Date(value).toLocaleString('ru-RU');
function error(message) { $('admin-error').textContent = message; $('admin-error').hidden = !message; }
function view(id) { ['login-view', 'results-view', 'detail-view'].forEach(v => { $(v).hidden = v !== id; }); $('logout').hidden = id === 'login-view'; }
async function api(path, method = 'GET', body) {
  let response;
  try { response = await fetch(path, { method, ...(method === 'GET' ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }) }); }
  catch { throw new Error('Нет связи с сервером. Попробуйте снова.'); }
  if (response.status === 401) view('login-view');
  if (!response.ok) { const data = await response.json(); throw new Error(data.error || 'Ошибка сервера.'); }
  return response;
}
const query = () => new URLSearchParams({ search: $('search').value, sort: $('sort').value, direction: $('direction').value });
function node(tag, text, className) { const el = document.createElement(tag); el.textContent = text; if (className) el.className = className; return el; }
async function loadResults() {
  const serial = ++requestSerial;
  const { results } = await (await api('/api/admin/results?' + query())).json();
  if (serial !== requestSerial) return;
  view('results-view'); $('results-body').replaceChildren();
  $('total-results').textContent = results.length;
  $('average-result').textContent = results.length ? (results.reduce((sum, r) => sum + r.percentage, 0) / results.length).toFixed(1) + '%' : '—';
  $('results-empty').hidden = results.length > 0;
  $('results-empty').textContent = $('search').value ? 'По вашему запросу ничего не найдено.' : 'Завершённых попыток пока нет.';
  results.forEach(r => {
    const row = document.createElement('tr');
    [r.id, r.name, r.group_name || '—', date(r.completed_at), r.correct, r.incorrect, r.skipped, r.percentage + '%'].forEach((text, i) => row.append(node('td', text, i === 7 ? 'score-cell' : '')));
    const actions = document.createElement('td'); actions.className = 'row-actions';
    const details = node('button', 'Подробнее', 'text-button'); details.onclick = () => showDetail(r.id).catch(e => error(e.message));
    const remove = node('button', 'Удалить', 'text-button danger-text'); remove.onclick = () => askDelete(r.id, r.name);
    actions.append(details, remove); row.append(actions); $('results-body').append(row);
  });
}
async function showDetail(id) {
  error(''); const data = await (await api('/api/admin/results/' + id)).json(); currentId = id; view('detail-view');
  $('detail-name').textContent = data.attempt.name;
  $('detail-meta').textContent = `Попытка №${id} · ${data.attempt.group_name || 'Без группы'} · Начало: ${date(data.attempt.started_at)} · Завершение: ${date(data.attempt.completed_at)}`;
  const a = data.attempt;
  $('detail-summary').textContent = `Правильно: ${a.correct} · Неправильно: ${a.incorrect} · Пропущено: ${a.skipped} · Результат: ${a.percentage}%`;
  $('detail-questions').replaceChildren();
  data.questions.forEach(q => {
    const card = document.createElement('article'); card.className = 'card detail-question';
    const labels = { correct: 'Правильно', incorrect: 'Неправильно', skipped: 'Пропущено' };
    const status = node('span', labels[q.result], 'badge ' + q.result);
    const title = node('h2', `${q.id}. ${q.text}`);
    const chosen = q.options.find(o => o.id === q.selectedOption), correct = q.options.find(o => o.id === q.correctOption);
    const answer = node('p', 'Ответ участника: ' + (chosen ? `${chosen.id}. ${chosen.text}` : 'Не выбран'));
    const key = node('p', `Правильный ответ: ${correct.id}. ${correct.text}`, 'correct-answer');
    card.append(status, title, answer, key); $('detail-questions').append(card);
  }); window.scrollTo({ top: 0 });
}
function askDelete(id, name) { deleteId = id; $('delete-description').textContent = `Попытка №${id}: ${name}`; $('delete-dialog').showModal(); }
$('delete-dialog').addEventListener('cancel', e => { if (deleting) e.preventDefault(); });
$('confirm-delete').onclick = async () => {
  if (deleting) return;
  deleting = true; $('confirm-delete').disabled = true; $('cancel-delete').disabled = true; $('confirm-delete').textContent = 'Удаляем…';
  try { await api('/api/admin/results/' + deleteId, 'DELETE'); $('delete-dialog').close(); error(''); await loadResults(); }
  catch (e) { $('delete-dialog').close(); error(e.message); }
  finally { deleting = false; $('confirm-delete').disabled = false; $('cancel-delete').disabled = false; $('confirm-delete').textContent = 'Удалить'; }
};
$('delete-detail').onclick = () => askDelete(currentId, $('detail-name').textContent);
$('login-form').onsubmit = async e => {
  e.preventDefault(); error(''); $('login-button').disabled = true; $('login-button').textContent = 'Входим…';
  try { await api('/api/admin/login', 'POST', { password: $('password').value }); $('password').value = ''; await loadResults(); }
  catch (e) { error(e.message); } finally { $('login-button').disabled = false; $('login-button').textContent = 'Войти →'; }
};
$('logout').onclick = async () => { try { await api('/api/admin/logout', 'POST'); view('login-view'); $('results-body').replaceChildren(); $('detail-questions').replaceChildren(); error(''); } catch (e) { error(e.message); } };
$('filters').onsubmit = e => { e.preventDefault(); error(''); loadResults().catch(e => error(e.message)); };
$('sort').onchange = $('direction').onchange = () => loadResults().catch(e => error(e.message));
$('back-results').onclick = () => loadResults().catch(e => error(e.message));
$('export').onclick = async () => { try { const response = await api('/api/admin/results/export.csv?' + query()); const url = URL.createObjectURL(await response.blob()); const a = document.createElement('a'); a.href = url; a.download = 'quiz-results.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); } catch (e) { error(e.message); } };
(async () => { try { await api('/api/admin/session'); await loadResults(); } catch (e) { if (e.message !== 'Войдите в панель администратора.') error(e.message); view('login-view'); } })();
