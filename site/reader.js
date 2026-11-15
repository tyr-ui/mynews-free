/* In-page reading with a private, bounded IndexedDB cache. No article uploads. */
(function () {
  'use strict';
  const core = window.MyNewsReaderCore;
  const ORIGIN = location.origin;
  const CACHE_DAYS = 7, CACHE_LIMIT = 150;
  const memory = new Map(), pending = new Map(), requests = new Map(), queue = [];
  const prefetched = new Set();
  let helperReady = false, active = 0, current = null, prefetchTimer, oldOverflow = '';
  const $ = id => document.getElementById(id);
  const dbPromise = new Promise(resolve => {
    try {
      const open = indexedDB.open('mynews-private-reader-v1', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('articles', {keyPath:'id'});
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => resolve(null);
      open.onblocked = () => resolve(null);
    } catch (_) {resolve(null);}
  });
  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  }
  function age(record) {return Date.now() - record.savedAt;}
  async function cached(item) {
    let record = memory.get(item.id);
    if (!record) {
      const db = await dbPromise;
      if (db) record = await new Promise(resolve => {
        const request = db.transaction('articles').objectStore('articles').get(item.id);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
      });
      if (record) memory.set(item.id, record);
    }
    const maxAge = record?.error ? 30 * 60000 : CACHE_DAYS * 86400000;
    return record && record.url === item.url && age(record) < maxAge &&
      (record.error || validArticle(record.article)) ? record : null;
  }
  async function save(item, result) {
    const record = {id:item.id, url:item.url, savedAt:Date.now(), ...result};
    memory.set(item.id, record);
    for (const row of [...memory.values()].sort((a, b) => b.savedAt - a.savedAt).slice(CACHE_LIMIT)) memory.delete(row.id);
    const db = await dbPromise;
    if (db) {
      try {
        const store = db.transaction('articles', 'readwrite').objectStore('articles');
        store.put(record);
        const all = store.getAll();
        all.onsuccess = () => {
          const rows = all.result.sort((a, b) => b.savedAt - a.savedAt);
          for (const [index, row] of rows.entries()) if (index >= CACHE_LIMIT || age(row) >= CACHE_DAYS * 86400000) {store.delete(row.id); memory.delete(row.id);}
        };
      } catch (_) { /* Reading still works in memory when local storage is unavailable. */ }
    }
    if (record.article) document.dispatchEvent(new CustomEvent('mynews-body-cached', {detail:{id:item.id}}));
    return record;
  }
  function validArticle(article) {
    return article && ['ready', 'partial'].includes(article.status) && core.safeUrl(article.url) &&
      typeof article.title === 'string' && article.title.length < 500 && Number.isFinite(Date.parse(article.fetchedAt)) &&
      Number.isSafeInteger(article.chars) && article.chars > 0 &&
      Array.isArray(article.blocks) && article.blocks.length > 0 && article.blocks.length < 1500 &&
      article.blocks.every(block => typeof block.text === 'string' && ['paragraph', 'heading'].includes(block.type)) &&
      article.blocks.reduce((sum, block) => sum + block.text.length, 0) <= 180000;
  }
  function drain() {
    while (helperReady && active < 2 && queue.length) {
      const task = queue.shift(); active++;
      requests.set(task.requestId, task);
      task.timer = setTimeout(() => finish(task.requestId, {error:'timeout'}), 100000);
      window.postMessage({channel:'mynews-private-reader-request', version:1, type:'read', requestId:task.requestId,
        item:{url:task.item.url, title:task.item.title}}, ORIGIN);
    }
  }
  async function finish(id, result) {
    const task = requests.get(id);
    if (!task) return;
    clearTimeout(task.timer); requests.delete(id); pending.delete(task.item.id); active--;
    const record = await save(task.item, result);
    task.resolve(record); drain();
  }
  function fetchBody(item, background=false) {
    if (pending.has(item.id)) return pending.get(item.id);
    const requestId = [...crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, '0')).join('');
    const promise = new Promise(resolve => {
      const task = {item, requestId, resolve};
      background ? queue.push(task) : queue.unshift(task);
    });
    pending.set(item.id, promise); drain();
    return promise;
  }
  const errorMessages = {
    unsupported_host:'この媒体は本文取得の対応対象外です。元記事へのリンクから読めます。',
    link_unresolved:'元記事のURLを特定できませんでした。Google News側のリンク形式が変わった可能性があります。',
    paywall:'会員向け記事のため、本文の自動取得は行いません。元記事で確認できます。',
    blocked:'取得元でブラウザー確認が必要なため、本文を取得できませんでした。',
    no_body:'本文を取り出せませんでした。配信抜粋と元記事リンクを表示しています。',
    photo_page:'写真ページの記事本文を取得できませんでした。写真の説明文を全文として表示することはしません。',
    title_mismatch:'見出しと本文の対応を確認できなかったため、取得した文章は表示しません。',
    timeout:'本文の取得が時間内に終わりませんでした。しばらくしてから元記事で確認できます。',
    network:'本文を取得できませんでした。ネット接続やSafariの拡張設定を確認してください。',
    busy:'ほかの記事を取得中です。少し待ってから開き直してください。',
    oversize:'本文データが大きいため、取得を中止しました。元記事で確認できます。',
  };
  function message(error) {
    if (error?.startsWith('http_')) return `取得元がHTTP ${error.slice(5)}を返したため、本文を取得できませんでした。`;
    return errorMessages[error] || errorMessages.network;
  }
  function preview(item, status) {
    $('reader-body').replaceChildren();
    $('reader-state').textContent = status;
    $('reader-format').textContent = '配信抜粋・本文未取得';
    if (item.excerpt) {
      $('reader-body').append(node('p', '配信元の短い抜粋', 'reader-caption'), node('p', item.excerpt));
    }
    if (!helperReady && item.kind !== 'search_trend' && core.safeUrl(item.url)) {
      const setup = node('button', 'Safariで本文読書を設定する', 'reader-primary');
      setup.type = 'button'; setup.addEventListener('click', showSetup); $('reader-body').append(setup);
    }
  }
  function display(article, fromCache) {
    $('reader-format').textContent = article.status === 'partial' ? '本文（一部）' : '取得できた本文';
    const fetched = new Intl.DateTimeFormat('ja-JP', {timeZone:'Asia/Tokyo', month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit'}).format(new Date(article.fetchedAt));
    $('reader-state').textContent = `${fromCache ? '端末の保存データ' : 'この端末で取得'} · 約${Math.max(1, Math.ceil(article.chars / 600))}分 · 取得 ${fetched}` +
      (article.status === 'partial' ? (article.reason === 'embedded_content' ? '。図表・動画などの埋め込み部分は元記事で確認できます。' : '。全体を取得できていないため、一部の本文です。') : '。掲載ページから抽出した文章です。');
    $('reader-body').replaceChildren(...article.blocks.map(block => node(block.type === 'heading' ? 'h3' : 'p', block.text)));
    $('reader-original').href = article.url;
    if (current) document.dispatchEvent(new CustomEvent('mynews-reader-opened', {detail:{id:current.id}}));
  }
  async function open(item) {
    current = item;
    $('reader-title').textContent = item.title;
    $('reader-meta').textContent = item.source;
    $('reader-original').href = item.url;
    preview(item, helperReady ? '本文を確認しています…' : '全文を読むにはSafariで一度だけ初回設定が必要です。');
    if (!$('reader-dialog').open) {oldOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; $('reader-dialog').showModal();}
    const record = await cached(item);
    if (current?.id !== item.id) return;
    if (record?.article) {display(record.article, true); return;}
    if (record?.error) {preview(item, message(record.error)); return;}
    if (item.kind === 'search_trend') {
      preview(item, '検索急上昇のキーワードです。記事本文はありません。元のリンクから関連情報を検索できます。');
      $('reader-format').textContent = '検索キーワード';
      return;
    }
    if (!core.safeUrl(item.url)) {preview(item, message('unsupported_host')); return;}
    if (!helperReady) return;
    preview(item, '本文を取得中です。取得後はこの端末に保存され、次回は保存データから開きます。');
    const result = await fetchBody(item);
    if (current?.id !== item.id || !$('reader-dialog').open) return;
    result.article ? display(result.article, false) : preview(item, message(result.error));
  }
  function showSetup() {if (!$('reader-setup-dialog').open) $('reader-setup-dialog').showModal();}
  function capability() {$('reader-capability').textContent = helperReady ? '本文読書：接続済み・端末保存' : '本文読書：Safariで初回設定';}
  async function prefetch(items) {
    if (!helperReady || !$('reader-prefetch').checked || prefetched.size >= 12) return;
    for (const item of items.filter(item => item.kind !== 'search_trend' && core.safeUrl(item.url)).slice(0, 3)) {
      if (prefetched.has(item.id) || prefetched.size >= 12) continue;
      prefetched.add(item.id);
      if (!await cached(item)) fetchBody(item, true);
    }
  }
  window.addEventListener('message', event => {
    const data = event.data;
    if (event.source !== window || event.origin !== ORIGIN || data?.channel !== 'mynews-private-reader' || data.version !== 1) return;
    if (data.type === 'ready') {
      const first = !helperReady; helperReady = true; capability(); drain();
      if (first) document.dispatchEvent(new CustomEvent('mynews-reader-ready'));
      return;
    }
    if (data.type === 'result' && requests.has(data.requestId)) {
      finish(data.requestId, validArticle(data.article) ? {article:data.article} : {error:typeof data.error === 'string' ? data.error.slice(0, 100) : 'no_body'});
    }
  });
  $('reader-close').addEventListener('click', () => $('reader-dialog').close());
  $('reader-dialog').addEventListener('close', () => {
    current = null; document.body.style.overflow = oldOverflow;
    document.dispatchEvent(new CustomEvent('mynews-reader-closed'));
  });
  $('reader-setup').addEventListener('click', showSetup);
  $('reader-setup-close').addEventListener('click', () => $('reader-setup-dialog').close());
  $('reader-font').addEventListener('click', () => {
    const large = $('reader-dialog').classList.toggle('large-text');
    $('reader-font').setAttribute('aria-pressed', String(large));
  });
  try {$('reader-prefetch').checked = localStorage.getItem('mynews-prefetch') !== 'false';} catch (_) {}
  $('reader-prefetch').addEventListener('change', () => {try {localStorage.setItem('mynews-prefetch', String($('reader-prefetch').checked));} catch (_) {}});
  capability();
  for (const delay of [0, 600, 1800]) setTimeout(() => window.postMessage({channel:'mynews-private-reader-request', version:1, type:'ping'}, ORIGIN), delay);
  window.MyNewsReader = Object.freeze({open, schedule(items) {clearTimeout(prefetchTimer); prefetchTimer = setTimeout(() => prefetch(items), 500);},
    isCached(id) {const record = memory.get(id); return !!record?.article && age(record) < CACHE_DAYS * 86400000;}});
})();
