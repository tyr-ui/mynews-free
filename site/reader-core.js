/* MyNews private reader. Article bodies never enter the public news JSON.
 * Google News URL parsing is adapted from dariandanciu/google-news-url-decoder
 * (MIT); see vendor/GNEWS-DECODER-LICENSE.txt. No proxy or block retries are used.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MyNewsReaderCore = api;
})(typeof window === 'undefined' ? this : window, function () {
  'use strict';
  const HOSTS = ['news.google.com', 'sponichi.co.jp', 'sanspo.com', 'daily.co.jp', 'hochi.news',
    'nikkansports.com', 'sankei.com', 'full-count.jp', 'baseballking.jp', 'news.yahoo.co.jp',
    'itmedia.co.jp', 'impress.co.jp', 'nikkeibp.co.jp', 'nikkei.com', 'nhk.or.jp', 'web.nhk',
    'asahi.com', 'yomiuri.co.jp', 'mainichi.jp', 'reuters.com', 'afpbb.com', 'bbc.com',
    'cnn.co.jp', 'jiji.com', 'tokyo-np.co.jp', 'chunichi.co.jp', 'tokyo-sports.co.jp',
    'news.mynavi.jp', 'oricon.co.jp', 'natalie.mu', 'zenn.dev', 'qiita.com', 'note.com',
    'gigazine.net', 'gizmodo.jp', 'wired.jp', 'ascii.jp', 'cnet.com', 'zdnet.com',
    'techcrunch.com', 'theverge.com', 'openai.com', 'anthropic.com', 'blog.google'];
  class ReaderError extends Error {
    constructor(code, message) {super(message || code); this.code = code;}
  }
  function safeUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
        HOSTS.some(host => url.hostname === host || url.hostname.endsWith('.' + host)) ? url.href : null;
    } catch (_) {return null;}
  }
  function articleId(value) {
    const url = new URL(value);
    return url.hostname === 'news.google.com' ? url.pathname.match(/^\/(?:rss\/)?(?:articles|read)\/([\w-]+)$/)?.[1] || null : null;
  }
  function decodingParams(html) {
    const sg = html.match(/data-n-a-sg="([^"]+)"/)?.[1];
    const ts = Number(html.match(/data-n-a-ts="(\d+)"/)?.[1]);
    return sg && Number.isSafeInteger(ts) && ts > 0 ? {sg, ts} : null;
  }
  function rpcBody(id, params) {
    const inner = JSON.stringify(['garturlreq',
      [['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1], 'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0],
      id, params.ts, params.sg]);
    return 'f.req=' + encodeURIComponent(JSON.stringify([[['Fbv4je', inner, null, 'generic']]]));
  }
  function rpcUrl(text) {
    for (const line of text.split('\n')) {
      if (!line.startsWith('[[')) continue;
      try {
        for (const row of JSON.parse(line)) {
          if (row[1] === 'Fbv4je' && typeof row[2] === 'string') {
            const url = JSON.parse(row[2])?.[1];
            if (typeof url === 'string' && safeUrl(url)) return url;
          }
        }
      } catch (_) { /* Other RPC rows are not article URLs. */ }
    }
    return null;
  }
  function checkResponse(response) {
    if (response.status < 200 || response.status >= 300) throw new ReaderError('http_' + response.status);
    if (typeof response.text !== 'string' || response.text.length > 2500000) throw new ReaderError('oversize');
    if (!safeUrl(response.url)) throw new ReaderError('unsupported_host');
    return response;
  }
  async function articlePage(url, request) {
    const safe = safeUrl(url);
    if (!safe) throw new ReaderError('unsupported_host');
    const page = checkResponse(await request(safe, {method:'GET'}));
    if (new URL(page.url).hostname !== 'news.google.com') return page;
    const id = articleId(safe);
    const params = decodingParams(page.text);
    if (!id || !params) throw new ReaderError('link_unresolved');
    const reply = checkResponse(await request('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
      method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8'}, data:rpcBody(id, params),
    }));
    const resolved = rpcUrl(reply.text);
    if (!resolved || new URL(resolved).hostname === 'news.google.com') throw new ReaderError('link_unresolved');
    return checkResponse(await request(resolved, {method:'GET'}));
  }
  function titleSimilarity(a, b) {
    const clean = text => (text || '').toLocaleLowerCase().replace(/\s+-\s+[^-]+$/, '').replace(/[^\p{L}\p{N}]/gu, '');
    const grams = text => new Set(Array.from({length:Math.max(0, text.length - 1)}, (_, i) => text.slice(i, i + 2)));
    const first = grams(clean(a)), second = grams(clean(b));
    if (!first.size || !second.size) return 0;
    return 2 * [...first].filter(gram => second.has(gram)).length / (first.size + second.size);
  }
  function paywalled(doc) {
    function hasPaidArticle(value) {
      if (!value || typeof value !== 'object') return false;
      const type = [].concat(value['@type'] || []).join(' ');
      if (/Article|NewsArticle|BlogPosting/.test(type) && (value.isAccessibleForFree === false || value.isAccessibleForFree === 'false')) return true;
      return Object.values(value).some(child => Array.isArray(child) ? child.some(hasPaidArticle) : hasPaidArticle(child));
    }
    for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {if (hasPaidArticle(JSON.parse(script.textContent))) return true;} catch (_) {}
    }
    return !!doc.querySelector('[itemprop="isAccessibleForFree"][content="false"]');
  }
  function fusionStory(doc) {
    for (const script of doc.querySelectorAll('script:not([src])')) {
      const text = script.textContent;
      const match = /Fusion\.globalContent\s*=\s*/.exec(text);
      if (!match) continue;
      const start = match.index + match[0].length;
      if (text[start] !== '{') continue;
      let quoted = false, escaped = false, depth = 0;
      for (let end = start; end < text.length && end - start < 2000000; end++) {
        const char = text[end];
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') quoted = false;
        } else if (char === '"') quoted = true;
        else if (char === '{') depth++;
        else if (char === '}' && --depth === 0) {
          try {const value = JSON.parse(text.slice(start, end + 1)); if (value.type === 'story') return value;} catch (_) {}
          break;
        }
      }
    }
    return null;
  }
  function nextPage(doc, current) {
    const link = doc.querySelector('link[rel="next"], a[rel="next"]');
    if (!link) return {url:null, more:false};
    try {
      const target = new URL(link.getAttribute('href'), current);
      const original = new URL(current);
      const base = original.pathname.replace(/\/\d{1,2}\/?$/, '/').replace(/\/$/, '');
      const sameArticle = target.pathname === original.pathname ||
        (target.pathname.startsWith(base + '/') && /^\d{1,2}\/?$/.test(target.pathname.slice(base.length + 1)));
      return {url:target.hostname === original.hostname && sameArticle && target.href !== original.href ? safeUrl(target.href) : null, more:true};
    } catch (_) {return {url:null, more:true};}
  }
  function photoPage(url) {return /\/(?:gazo|photonews|photo|gallery)(?:\/|_)/i.test(new URL(url).pathname);}
  function originalFromPhoto(doc, url) {
    for (const link of doc.querySelectorAll('a[href]')) {
      if (!/写真の記事を読む|記事に戻|記事へ戻|記事本文|本文を読む/.test(link.textContent)) continue;
      try {
        const target = new URL(link.getAttribute('href'), url);
        if (target.hostname === new URL(url).hostname && safeUrl(target.href) && !photoPage(target.href)) return target.href;
      } catch (_) {}
    }
    return null;
  }
  function extract(doc, url, expectedTitle, ReadabilityClass) {
    if (/verify (?:you are|that you are) human|checking your browser|just a moment/i.test(doc.title || '')) throw new ReaderError('blocked');
    if (paywalled(doc)) throw new ReaderError('paywall');
    const next = nextPage(doc, url);
    const story = fusionStory(doc);
    if (story?.content_restrictions?.content_code && story.content_restrictions.content_code !== 'free') throw new ReaderError('paywall');
    // Some free Arc/Fusion articles render from explicitly free structured data.
    // Parse JSON, never execute page scripts or use hidden paid article bodies.
    if (story?.content_restrictions?.content_code === 'free' && Array.isArray(story.content_elements)) {
      const title = story.headlines?.basic || doc.title;
      if (titleSimilarity(expectedTitle, title) < 0.18) throw new ReaderError('title_mismatch');
      const blocks = [];
      for (const element of story.content_elements) {
        if (!['text', 'header'].includes(element.type) || typeof element.content !== 'string') continue;
        const holder = doc.createElement('div'); holder.innerHTML = element.content;
        holder.querySelectorAll('script,style,iframe,[hidden]').forEach(node => node.remove());
        const text = holder.textContent.replace(/\s+/g, ' ').trim();
        if (text) blocks.push({type:element.type === 'header' ? 'heading' : 'paragraph', text});
      }
      const chars = blocks.reduce((sum, block) => sum + block.text.length, 0);
      if (chars >= 80 && chars <= 60000) return {title, blocks, chars, next, truncated:false,
        embedded:story.content_elements.some(element => element.type === 'raw_html')};
    }
    const clean = doc.cloneNode(true);
    clean.querySelectorAll('script, style, noscript, iframe, form, [hidden], [aria-hidden="true"]').forEach(node => node.remove());
    const article = new ReadabilityClass(clean, {charThreshold:100, keepClasses:false}).parse();
    if (!article || !article.content) throw new ReaderError('no_body');
    if (titleSimilarity(expectedTitle, article.title) < 0.18) throw new ReaderError('title_mismatch');
    const holder = doc.createElement('div'); holder.innerHTML = article.content;
    const blocks = [];
    for (const node of holder.querySelectorAll('h1,h2,h3,h4,p,li,blockquote,pre')) {
      if (node.closest('li') !== node && node.closest('li')) continue;
      if (node.parentElement?.closest('blockquote,pre')) continue;
      const text = node.textContent.replace(/[\t ]+/g, ' ').trim();
      if (text && blocks[blocks.length - 1]?.text !== text) blocks.push({type:/^H\d$/.test(node.tagName) ? 'heading' : 'paragraph', text});
    }
    if (!blocks.length && article.textContent) blocks.push({type:'paragraph', text:article.textContent.trim()});
    const chars = blocks.reduce((sum, block) => sum + block.text.length, 0);
    if (chars < 80) throw new ReaderError('no_body');
    let total = 0;
    const bounded = blocks.filter(block => {total += block.text.length; return total <= 60000;});
    return {title:article.title, blocks:bounded, chars, next, truncated:total > 60000};
  }
  async function readArticle(item, request, parseDocument, ReadabilityClass) {
    let page = await articlePage(item.url, request);
    if (photoPage(page.url)) {
      const original = originalFromPhoto(parseDocument(page.text, page.url), page.url);
      if (!original) throw new ReaderError('photo_page');
      page = checkResponse(await request(original, {method:'GET'}));
    }
    const originalUrl = page.url;
    const visited = new Set();
    let blocks = [], title = item.title, partial = false, reason = '';
    for (let index = 0; index < 3; index++) {
      visited.add(page.url);
      let result;
      try {result = extract(parseDocument(page.text, page.url), page.url, item.title, ReadabilityClass);}
      catch (error) {if (index === 0) throw error; partial = true; reason = 'next_page_unavailable'; break;}
      title = result.title; blocks.push(...result.blocks);
      if (result.embedded) {partial = true; reason = 'embedded_content';}
      if (result.truncated) {partial = true; reason = 'length_limit'; break;}
      if (!result.next.more) break;
      if (!result.next.url || visited.has(result.next.url) || index === 2) {partial = true; reason = 'more_pages'; break;}
      try {page = checkResponse(await request(result.next.url, {method:'GET'}));}
      catch (_) {partial = true; reason = 'next_page_unavailable'; break;}
    }
    return {status:partial ? 'partial' : 'ready', reason, title, url:originalUrl, blocks,
      chars:blocks.reduce((sum, block) => sum + block.text.length, 0), fetchedAt:new Date().toISOString()};
  }
  return Object.freeze({safeUrl, articleId, decodingParams, rpcBody, rpcUrl, titleSimilarity, paywalled, nextPage, photoPage, originalFromPhoto, extract, readArticle, ReaderError});
});
