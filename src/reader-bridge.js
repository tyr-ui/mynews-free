/* Installed only in Safari's Userscripts content context on this MyNews site. */
(function () {
  'use strict';
  const ORIGIN = 'https://tyr-ui.github.io';
  if (location.origin !== ORIGIN || !location.pathname.startsWith('/mynews-free/')) return;
  const core = window.MyNewsReaderCore;
  const processed = new Set();
  let running = 0;
  function send(data) {window.postMessage({channel:'mynews-private-reader', version:1, ...data}, ORIGIN);}
  async function request(url, init) {
    if (!core.safeUrl(url)) throw new core.ReaderError('unsupported_host');
    // Use the user's Safari connection. No login secrets, proxy or server body cache.
    const response = await GM.xmlHttpRequest({url, method:init.method || 'GET', data:init.data,
      headers:init.headers || {}, responseType:'text', timeout:18000});
    return {status:response.status, text:response.responseText || '', url:response.responseURL || url};
  }
  window.addEventListener('message', async event => {
    const message = event.data;
    if (event.source !== window || event.origin !== ORIGIN || message?.channel !== 'mynews-private-reader-request' || message.version !== 1) return;
    if (message.type === 'ping') {send({type:'ready'}); return;}
    if (message.type !== 'read' || !/^[a-f0-9]{32}$/.test(message.requestId || '') || processed.has(message.requestId)) return;
    if (!message.item || typeof message.item.title !== 'string' || message.item.title.length > 500 || !core.safeUrl(message.item.url)) {send({type:'result', requestId:message.requestId, error:'unsupported_host'}); return;}
    if (running >= 2) {send({type:'result', requestId:message.requestId, error:'busy'}); return;}
    processed.add(message.requestId);
    if (processed.size > 200) processed.delete(processed.values().next().value);
    running++;
    try {
      const article = await core.readArticle(message.item, request, html => new DOMParser().parseFromString(html, 'text/html'), Readability);
      send({type:'result', requestId:message.requestId, article});
    } catch (error) {send({type:'result', requestId:message.requestId, error:error.code || 'network'});}
    finally {running--;}
  });
  send({type:'ready'});
})();
