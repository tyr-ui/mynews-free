'use strict';
const NEWS_URL = './data/news.json';
const STORAGE = 'mynews-preferences-v1';
const SIGNAL_KINDS = new Set(['search_trend', 'popular_link', 'social_post']);
const CATEGORIES = [['all', '全分野'], ['野球', '野球'], ['漫画', '漫画・アニメ'], ['IT', 'IT'], ['AI', 'AI'], ['政治', '政治'], ['経済', '経済'], ['国際', '国際'], ['社会', '社会'], ['話題', '話題']];
const MEDIA = ['スポニチ', 'サンスポ', 'デイリー', 'スポーツ報知', '日刊スポーツ', '産経新聞', 'Full-Count', 'BASEBALL KING'];
const AUTO_CHECK_MS = 5 * 60 * 1000;
const RESUME_CHECK_MS = 60 * 1000;
let feedRequest = false, lastCheckAttempt = 0, pendingNews = null;
const state = {items: [], failures: [], sources: [], updatedAt: null, view: 'all', category: 'all', publisher: 'all', sort: 'latest', search: '', unread: false, visible: 36, saved: new Set(), read: new Set()};
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
function mediaName(item) {
  const name = item.publisher || item.source.replace(' / Google News経由', '');
  if (/スポニチ|sponichi/i.test(name)) return 'スポニチ';
  if (/デイリー/.test(name)) return 'デイリー';
  if (/報知/.test(name)) return 'スポーツ報知';
  if (/産経/.test(name)) return '産経新聞';
  return name;
}
function filtered() {
  let result = state.items.filter(item => {
    if (state.category !== 'all' && item.category !== state.category) return false;
    if (state.category === '野球' && state.publisher !== 'all') {
      if (state.publisher === 'others' ? MEDIA.includes(mediaName(item)) : mediaName(item) !== state.publisher) return false;
    }
    if (state.view === 'signal' && !SIGNAL_KINDS.has(item.kind)) return false;
    if (state.view === 'saved' && !state.saved.has(item.id)) return false;
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
    result = [...first, ...result.filter(item => !seen.has(item.id))];
  }
  return state.view === 'focus' ? result.slice(0, 36) : result;
}
function addFilterButtons(container, values, key) {
  for (const [value, label] of values) {
    const button = el('button', 'filter-tab', label);
    button.type = 'button'; button.dataset[key] = value; button.dataset.label = label;
    button.addEventListener('click', () => {
      state[key] = value; state.visible = 36;
      if (key === 'category') state.publisher = 'all';
      render();
    });
    container.append(button);
  }
}
function renderFilters() {
  const categoryCounts = {};
  const publisherCounts = {all: 0, others: 0};
  for (const item of state.items) {
    categoryCounts[item.category] = (categoryCounts[item.category] || 0) + 1;
    if (item.category === '野球') {
      publisherCounts.all++;
      const publisher = MEDIA.includes(mediaName(item)) ? mediaName(item) : 'others';
      publisherCounts[publisher] = (publisherCounts[publisher] || 0) + 1;
    }
  }
  for (const button of $('category-tabs').querySelectorAll('button')) {
    const value = button.dataset.category;
    const count = value === 'all' ? state.items.length : categoryCounts[value] || 0;
    button.replaceChildren(el('span', null, button.dataset.label), el('span', 'tab-count', String(count)));
    button.classList.toggle('active', value === state.category);
    button.setAttribute('aria-pressed', String(value === state.category));
  }
  $('publisher-section').hidden = state.category !== '野球';
  for (const button of $('publisher-tabs').querySelectorAll('button')) {
    const value = button.dataset.publisher;
    button.replaceChildren(el('span', null, button.dataset.label), el('span', 'tab-count', String(publisherCounts[value] || 0)));
    button.classList.toggle('active', value === state.publisher);
    button.setAttribute('aria-pressed', String(value === state.publisher));
  }
  document.querySelectorAll('[data-view]').forEach(button => {
    button.classList.toggle('active', button.dataset.view === state.view);
    button.setAttribute('aria-pressed', String(button.dataset.view === state.view));
  });
  document.querySelectorAll('[data-sort]').forEach(button => {
    button.classList.toggle('active', button.dataset.sort === state.sort);
    button.setAttribute('aria-pressed', String(button.dataset.sort === state.sort));
  });
}
function renderSourceHealth() {
  const container = $('source-health'); container.replaceChildren();
  const empty = state.sources.filter(source => source.status === 'empty').length;
  $('source-summary').textContent = state.sources.length ? `収集元の状況を見る（${state.sources.length}件・取得0件 ${empty}・エラー ${state.failures.length}）` : '収集元の状況を見る';
  if (!state.sources.length) {container.append(el('p', null, '次回の収集後に媒体別の件数を表示します。')); return;}
  for (const source of state.sources) {
    const row = el('div', 'source-row' + (source.status === 'error' ? ' source-error' : ''));
    const status = source.status === 'error' ? `取得失敗 ${source.error || ''}` : `今回取得 ${source.fetched_count}件 / 保持 ${source.retained_count || 0}件`;
    row.append(el('span', null, source.name), el('span', null, status));
    container.append(row);
  }
}
function createCard(item) {
  const card = el('article', 'card' + (state.read.has(item.id) ? ' read' : ''));
  card.dataset.articleId = item.id;
  const top = el('div', 'card-top');
  const cat = el('span', 'pill', item.category);
  const kind = el('span', 'pill ' + kindClass(item), kindLabel(item));
  const meta = el('span', 'meta', `${fmt(item.published_at)} ・ ${item.source}`);
  top.append(cat, kind, meta);
  const headline = el('h3');
  const link = el('button', 'headline-button', item.title);
  link.type = 'button';
  link.addEventListener('click', () => window.MyNewsReader.open(item));
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
  const inline = el('button', 'inline-read', window.MyNewsReader.isCached(item.id) ? '✓ 保存本文を読む' : '本文を読む');
  inline.type = 'button'; inline.dataset.readerId = item.id;
  inline.addEventListener('click', () => window.MyNewsReader.open(item));
  left.prepend(inline);
  const open = el('a', 'open-link', '出典を開く ↗');
  open.href = isSafeUrl(item.url) ? item.url : '#'; open.target = '_blank'; open.rel = 'noopener noreferrer'; open.referrerPolicy = 'no-referrer';
  open.addEventListener('click', () => {state.read.add(item.id); persist();});
  footer.append(left, open);
  card.append(top, headline, snippet, footer);
  return card;
}
function isSafeUrl(url) { try {return ['https:', 'http:'].includes(new URL(url).protocol);} catch {return false;} }
function render() {
  renderFilters();
  const all = filtered();
  const list = $('cards'); list.replaceChildren();
  const frag = document.createDocumentFragment();
  for (const item of all.slice(0, state.visible)) frag.append(createCard(item));
  list.append(frag);
  if (!all.length) list.append(el('div', 'empty', state.items.length ? '条件に一致するニュースはありません。検索・フィルターを変更してください。' : 'まだニュースがありません。GitHubのActionsから「Run workflow」を実行して最初の情報収集を行ってください。'));
  $('shown-count').textContent = `${all.length}件`;
  const label = CATEGORIES.find(([value]) => value === state.category)[1];
  $('list-title').textContent = label === '全分野' ? 'ニュース一覧' : label + 'のニュース';
  $('feed-context').textContent = state.view === 'focus' ? `注目の${all.length}件を表示。「すべて」で収集済みの記事を一覧できます。` : `${label}${state.category === '野球' && state.publisher !== 'all' ? ' / ' + (state.publisher === 'others' ? 'その他の媒体' : state.publisher) : ''} · ${state.sort === 'latest' ? '新着順' : 'おすすめ順'} · ${Math.min(state.visible, all.length)} / ${all.length}件を表示`;
  $('load-more').hidden = all.length <= state.visible;
  const count = state.items.length;
  const signals = state.items.filter(x => SIGNAL_KINDS.has(x.kind)).length;
  $('summary').replaceChildren(...[[count, '表示可能な記事'], [signals, '話題シグナル'], [state.failures.length, '収集元エラー']].map(([num, label]) => {
    const box = el('div'); box.append(el('b', null, String(num)), el('span', null, label)); return box;
  }));
  $('last-updated').textContent = state.updatedAt ? `収集完了 ${fmt(state.updatedAt)} JST` : '初回収集前';
  const notice = $('notice');
  if (state.failures.length) {
    notice.hidden = false;
    notice.textContent = state.failures.every(source => source.startsWith('Bluesky') && source.includes('403')) ? 'Bluesky検索はHTTP 403で取得できていません。他のニュースは閲覧できます。詳細は「収集元の状況」を確認してください。' : `${state.failures.length}件の収集元でエラーがありました。詳細は「収集元の状況」を確認してください。`;
  } else notice.hidden = true;
  window.MyNewsReader.schedule(all.slice(0, state.visible));
}
function applyNews(result) {
  state.items = result.items.filter(item => item && item.id && item.title && isSafeUrl(item.url));
  state.updatedAt = result.updated_at;
  state.failures = Array.isArray(result.failed_sources) ? result.failed_sources : [];
  state.sources = Array.isArray(result.source_status) ? result.source_status : [];
  pendingNews = null;
  $('apply-news').hidden = true;
  renderSourceHealth();
  render();
}
async function loadNews({automatic = false} = {}) {
  if (feedRequest || (automatic && document.hidden)) return;
  if (automatic && navigator.onLine === false) {
    $('load-status').textContent = 'オフラインです。表示中の記事は、最後に取得できたデータです。';
    return;
  }
  feedRequest = true;
  lastCheckAttempt = Date.now();
  $('refresh').disabled = true;
  $('load-status').textContent = '公開データを確認中…';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    // Revalidate the HTTP cache so unchanged feeds can use conditional requests.
    const response = await fetch(NEWS_URL, {cache: 'no-cache', signal: controller.signal});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    if (!Array.isArray(result.items) || !Number.isFinite(Date.parse(result.updated_at))) throw new Error('Invalid news file');
    const offline = response.headers?.get('X-MyNews-Cache') === 'offline';
    const newestKnown = pendingNews?.updated_at || state.updatedAt;
    if (newestKnown && Date.parse(result.updated_at) < Date.parse(newestKnown)) {
      $('load-status').textContent = pendingNews ? 'より新しい公開データを取得済みです。表示ボタンで反映できます。' : '公開先の反映待ちです。新しい収集日時の記事を表示したままにしています。';
      return;
    }
    if (!state.updatedAt || (!automatic && !offline)) {
      if (state.updatedAt !== result.updated_at) applyNews(result);
      else if (pendingNews) applyNews(pendingNews);
    } else if (!offline && state.updatedAt !== result.updated_at) {
      pendingNews = result;
      const known = new Set(state.items.map(item => item.id));
      const added = result.items.filter(item => item && item.id && item.title && isSafeUrl(item.url) && !known.has(item.id)).length;
      $('apply-news').textContent = `更新された一覧を表示（新着${added}件）`;
      $('apply-news').hidden = false;
    }
    $('load-status').textContent = offline ? '通信できないため端末に保存された一覧を表示しています。最新情報の確認は未完了です。' :
      pendingNews ? '新しい公開データがあります。読んでいる位置を保つため、表示ボタンで反映します。' : `公開データ確認 ${fmt(new Date().toISOString())} JST（収集日時は上部に表示）`;
  } catch (error) {
    $('load-status').textContent = state.updatedAt ? '公開データを確認できませんでした。表示中の記事を保持しています。通信が戻ったら↻で再確認できます。' : 'データを読み込めませんでした。ネット接続を確認し、↻でもう一度お試しください。';
  } finally {
    clearTimeout(timeout);
    feedRequest = false;
    $('refresh').disabled = false;
  }
}
function checkOnReturn() {
  if (!document.hidden && Date.now() - lastCheckAttempt >= RESUME_CHECK_MS) loadNews({automatic: true});
}
addFilterButtons($('category-tabs'), CATEGORIES, 'category');
addFilterButtons($('publisher-tabs'), [['all', '全媒体'], ...MEDIA.map(name => [name, name]), ['others', 'その他']], 'publisher');
document.querySelectorAll('[data-view]').forEach(btn => btn.addEventListener('click', () => {
  state.view = btn.dataset.view; state.visible = 36;
  if (state.view === 'focus') state.sort = 'score';
  render();
}));
$('search').addEventListener('input', e => {state.search = e.target.value.trim().toLocaleLowerCase(); state.visible = 36; render();});
document.querySelectorAll('[data-sort]').forEach(button => button.addEventListener('click', () => {state.sort = button.dataset.sort; state.visible = 36; render();}));
$('unread').addEventListener('change', e => {state.unread = e.target.checked; render();});
$('load-more').addEventListener('click', () => {state.visible += 36; render();});
$('refresh').addEventListener('click', () => loadNews());
$('apply-news').addEventListener('click', () => {
  if (!pendingNews) return;
  applyNews(pendingNews);
  $('load-status').textContent = '更新された一覧を表示しました。';
});
document.addEventListener('visibilitychange', checkOnReturn);
window.addEventListener('pageshow', event => {if (event.persisted) checkOnReturn();});
window.addEventListener('online', () => loadNews({automatic: true}));
window.addEventListener('offline', () => {$('load-status').textContent = 'オフラインです。表示中の記事は、最後に取得できたデータです。';});
setInterval(() => loadNews({automatic: true}), AUTO_CHECK_MS);
document.addEventListener('mynews-reader-opened', event => {
  state.read.add(event.detail.id); persist();
  document.querySelectorAll('[data-article-id]').forEach(card => {if (card.dataset.articleId === event.detail.id) card.classList.add('read');});
});
document.addEventListener('mynews-reader-closed', () => {if (state.unread) render();});
document.addEventListener('mynews-reader-ready', () => window.MyNewsReader.schedule(filtered().slice(0, state.visible)));
document.addEventListener('mynews-body-cached', event => {
  document.querySelectorAll('[data-reader-id]').forEach(button => {if (button.dataset.readerId === event.detail.id) button.textContent = '✓ 保存本文を読む';});
});
render(); loadNews();
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
