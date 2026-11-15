'use strict';
const NEWS_URL = './data/news.json';
const STORAGE = 'mynews-preferences-v1';
const SIGNAL_KINDS = new Set(['search_trend', 'popular_link', 'social_post']);
const state = {items: [], failures: [], updatedAt: null, view: 'focus', category: 'all', sort: 'score', search: '', unread: false, visible: 36, saved: new Set(), read: new Set()};
const $ = id => document.getElementById(id);
try {
  const store = JSON.parse(localStorage.getItem(STORAGE) || '{}');
  state.saved = new Set(Array.isArray(store.saved) ? store.saved : []);
  state.read = new Set(Array.isArray(store.read) ? store.read : []);
} catch (_) { /* Private mode can block storage. */ }
function persist() {
  try { localStorage.setItem(STORAGE, JSON.stringify({saved: [...state.saved], read: [...state.read]})); } catch (_) {}
}
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function fmt(iso) {
  const date = new Date(iso);
  return Number.isNaN(+date) ? '時刻不明' : new Intl.DateTimeFormat('ja-JP', {timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'}).format(date);
}
function kindLabel(item) {
  return {search_trend: '検索急上昇', popular_link: '人気記事', social_post: 'Bluesky投稿', news: 'ニュース'}[item.kind] || '外部記事';
}
function kindClass(item) {
  return {search_trend: 'signal', popular_link: 'popular', social_post: 'social'}[item.kind] || '';
}
function filtered() {
  let result = state.items.filter(item => {
    if (state.category !== 'all' && item.category !== state.category) return false;
    if (state.view === 'signal' && !SIGNAL_KINDS.has(item.kind)) return false;
    if (state.view === 'saved' && !state.saved.has(item.id)) return false;
    if (state.view === 'focus' && Number(item.score || 0) < 55) return false;
    if (state.unread && state.read.has(item.id)) return false;
    if (state.search && !(`${item.title} ${item.source} ${item.excerpt || ''} ${item.category}`).toLocaleLowerCase().includes(state.search)) return false;
    return true;
  });
  result.sort((a, b) => {
    if (state.sort === 'latest') return new Date(b.published_at) - new Date(a.published_at);
    return (b.score || 0) - (a.score || 0) || new Date(b.published_at) - new Date(a.published_at);
  });
  // Give civic/news categories and personal interests room in the first screen.
  // This is editorial balance, not evidence that a topic has become popular on X.
  if (state.view === 'focus' && state.category === 'all' && state.sort === 'score') {
    const priority = ['政治', '経済', '国際', '社会', '野球', '漫画', 'IT', 'AI', '話題'];
    const first = [], seen = new Set();
    for (let round = 0; round < 2; round++) {
      for (const cat of priority) {
        const matches = result.filter(item => item.category === cat);
        if (matches[round]) { first.push(matches[round]); seen.add(matches[round].id); }
      }
    }
    return [...first, ...result.filter(item => !seen.has(item.id))];
  }
  return result;
}
function createCard(item) {
  const card = el('article', 'card' + (state.read.has(item.id) ? ' read' : ''));
  const top = el('div', 'card-top');
  const cat = el('span', 'pill', item.category);
  const kind = el('span', 'pill ' + kindClass(item), kindLabel(item));
  const meta = el('span', 'meta', `${fmt(item.published_at)} ・ ${item.source}`);
  top.append(cat, kind, meta);
  const headline = el('h3');
  const link = el('a', null, item.title);
  link.href = isSafeUrl(item.url) ? item.url : '#';
  link.target = '_blank'; link.rel = 'noopener noreferrer'; link.referrerPolicy = 'no-referrer';
  link.addEventListener('click', () => {state.read.add(item.id); persist();});
  headline.append(link);
  const snippet = el('p', 'excerpt', item.excerpt || '見出しの詳細は配信元で確認してください。');
  const footer = el('div', 'card-footer');
  const left = el('div', 'card-actions');
  const save = el('button', state.saved.has(item.id) ? 'selected' : '', state.saved.has(item.id) ? '★ 保存済' : '☆ 保存');
  save.type = 'button'; save.setAttribute('aria-label', item.title + ' を保存または解除');
  save.addEventListener('click', () => {state.saved.has(item.id) ? state.saved.delete(item.id) : state.saved.add(item.id); persist(); render();});
  const read = el('button', state.read.has(item.id) ? 'selected' : '', state.read.has(item.id) ? '✓ 既読' : '✓ 既読にする');
  read.type = 'button'; read.addEventListener('click', () => {state.read.has(item.id) ? state.read.delete(item.id) : state.read.add(item.id); persist(); render();});
  left.append(save, read);
  const open = el('a', 'open-link', '出典を開く ↗');
  open.href = isSafeUrl(item.url) ? item.url : '#'; open.target = '_blank'; open.rel = 'noopener noreferrer'; open.referrerPolicy = 'no-referrer';
  open.addEventListener('click', () => {state.read.add(item.id); persist();});
  footer.append(left, open);
  card.append(top, headline, snippet, footer);
  return card;
}
function isSafeUrl(url) { try {return ['https:', 'http:'].includes(new URL(url).protocol);} catch {return false;} }
function render() {
  const all = filtered();
  const list = $('cards'); list.replaceChildren();
  const frag = document.createDocumentFragment();
  for (const item of all.slice(0, state.visible)) frag.append(createCard(item));
  list.append(frag);
  if (!all.length) list.append(el('div', 'empty', state.items.length ? '条件に一致するニュースはありません。検索・フィルターを変更してください。' : 'まだニュースがありません。GitHubのActionsから「Run workflow」を実行して最初の情報収集を行ってください。'));
  $('shown-count').textContent = `${all.length}件`;
  $('load-more').hidden = all.length <= state.visible;
  const count = state.items.length;
  const signals = state.items.filter(x => SIGNAL_KINDS.has(x.kind)).length;
  $('summary').replaceChildren(...[[count, '表示可能な記事'], [signals, '話題シグナル'], [state.failures.length, '収集元エラー']].map(([num, label]) => {
    const box = el('div'); box.append(el('b', null, String(num)), el('span', null, label)); return box;
  }));
  $('last-updated').textContent = state.updatedAt ? `最終更新 ${fmt(state.updatedAt)} JST` : '初回収集前';
  const notice = $('notice');
  if (state.failures.length) {
    notice.hidden = false;
    notice.textContent = `${state.failures.length}件の収集元でエラーがありました。一部ニュースが欠けている可能性があります。`;
  } else notice.hidden = true;
}
async function loadNews() {
  $('refresh').disabled = true;
  try {
    const response = await fetch(NEWS_URL + '?t=' + Date.now(), {cache: 'no-store'});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    if (!Array.isArray(result.items)) throw new Error('Invalid news file');
    state.items = result.items.filter(item => item && item.id && item.title && isSafeUrl(item.url));
    state.updatedAt = result.updated_at || null;
    state.failures = Array.isArray(result.failed_sources) ? result.failed_sources : [];
    render();
  } catch (error) {
    const notice = $('notice'); notice.hidden = false;
    notice.textContent = 'データの読み込みに失敗しました。ネット接続・Pagesの公開設定を確認してください。';
  } finally { $('refresh').disabled = false; }
}
document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => {
  state.view = btn.dataset.view; state.visible = 36;
  document.querySelectorAll('.tab').forEach(tab => {tab.classList.toggle('active', tab === btn); tab.setAttribute('aria-pressed', String(tab === btn));});
  render();
}));
$('category').addEventListener('change', e => {state.category = e.target.value; state.visible = 36; render();});
$('search').addEventListener('input', e => {state.search = e.target.value.trim().toLocaleLowerCase(); state.visible = 36; render();});
$('sort').addEventListener('change', e => {state.sort = e.target.value; render();});
$('unread').addEventListener('change', e => {state.unread = e.target.checked; render();});
$('load-more').addEventListener('click', () => {state.visible += 36; render();});
$('refresh').addEventListener('click', loadNews);
render(); loadNews();
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
