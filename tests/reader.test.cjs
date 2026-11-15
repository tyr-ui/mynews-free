const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const {IDBFactory} = require('fake-indexeddb');
const core = require('../site/reader-core.js');
const Readability = require('../site/vendor/readability-0.6.0.js');
const ROOT = path.resolve(__dirname, '..');
const TITLE = 'MyNews読書機能の動作確認';
const URL = 'https://www.daily.co.jp/baseball/reader-test.shtml';
const paragraphs = Array.from({length:8}, (_, index) => `第${index + 1}段落です。これは読書機能のテスト用に作成した文章です。記事の本文だけを読みやすく表示し、画面の移動を減らします。取得した文章は利用者の端末に保存し、同じ記事を再び開いたときは保存済みの本文を使用します。`);
function html(options={}) {
  return `<!doctype html><html lang="ja"><head><title>${TITLE}</title>${options.paid ? '<script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":false}</script>' : ''}${options.next ? `<link rel="next" href="${options.next}">` : ''}</head><body><nav>メニュー</nav><article><h1>${TITLE}</h1>${paragraphs.map(text=>`<p>${text}</p>`).join('')}<script>window.stolen=true;</script><p hidden>非表示の文章は取得しない</p></article><footer>フッター</footer></body></html>`;
}
function doc(text, url=URL) {return new JSDOM(text, {url}).window.document;}
function response(text, url=URL, status=200) {return {text, url, status};}
const item = {id:'owned-test', title:TITLE, url:URL, kind:'news', category:'野球', source:'動作確認用', excerpt:'これは自作の動作確認用抜粋です。'};

test('only approved public HTTPS sources are requested', () => {
  assert.equal(core.safeUrl('https://www.daily.co.jp/baseball/test'), 'https://www.daily.co.jp/baseball/test');
  for (const url of ['http://www.daily.co.jp/a', 'https://daily.co.jp.evil.example/a', 'https://user:pass@daily.co.jp/a', 'https://daily.co.jp:8443/a', 'https://127.0.0.1/a', 'https://localhost/a', 'javascript:alert(1)']) assert.equal(core.safeUrl(url), null);
});
test('Google News signature and RPC parsing use the expected article result', () => {
  assert.equal(core.articleId('https://news.google.com/rss/articles/CBMiTest123?oc=5'), 'CBMiTest123');
  assert.deepEqual(core.decodingParams('<div data-n-a-sg="signature" data-n-a-ts="1234567890">'), {sg:'signature',ts:1234567890});
  const line = JSON.stringify([['wrb.fr','Fbv4je',JSON.stringify(['garturlres',URL])]]);
  assert.equal(core.rpcUrl(")]}'\n123\n"+line), URL);
  assert.equal(core.rpcUrl(JSON.stringify([['wrb.fr','Fbv4je',JSON.stringify(['garturlres','https://127.0.0.1/secret'])]])), null);
});
test('Google News links resolve then fetch only the publisher article', async () => {
  const google='https://news.google.com/rss/articles/CBMiTest123'; const calls=[];
  const request=async(url, init)=>{calls.push([url,init.method]);
    if(calls.length===1)return response('<div data-n-a-sg="signature" data-n-a-ts="1234567890">',google);
    if(calls.length===2)return response(JSON.stringify([['wrb.fr','Fbv4je',JSON.stringify(['garturlres',URL])]]),'https://news.google.com/_/DotsSplashUi/data/batchexecute');
    return response(html());};
  const article=await core.readArticle({...item,url:google},request,doc,Readability);
  assert.equal(article.status,'ready'); assert.equal(article.url,URL); assert.equal(calls.length,3); assert.equal(calls[1][1],'POST');
});
test('access refusals are not retried or sent through alternative hosts', async () => {
  let count=0;
  await assert.rejects(core.readArticle(item, async()=>{count++;return response('Forbidden',URL,403);},doc,Readability), error=>error.code==='http_403');
  assert.equal(count,1);
});
test('Readability extracts paragraphs and excludes scripts and hidden text', () => {
  const article=core.extract(doc(html()),URL,TITLE,Readability);
  assert.ok(article.chars>500);
  assert.equal(article.blocks.filter(block=>block.type==='paragraph').length,8);
  assert.ok(article.blocks.every(block=>!block.text.includes('window.stolen')&&!block.text.includes('非表示')));
});
test('paid article metadata prevents body extraction', () => {
  assert.throws(()=>core.extract(doc(html({paid:true})),URL,TITLE,Readability),error=>error.code==='paywall');
});
test('unrelated titles do not become the requested article', () => {
  assert.throws(()=>core.extract(doc(html()),URL,'全く異なる選手の契約についての速報',Readability),error=>error.code==='title_mismatch');
});
test('related story links are not followed as another page', () => {
  const next=core.nextPage(doc(html({next:'https://www.daily.co.jp/baseball/different-story.shtml'})),URL);
  assert.equal(next.more,true); assert.equal(next.url,null);
});
test('a second page is joined when it is the same article', async () => {
  const article=await core.readArticle(item,async url=>response(html(url.includes('?page=2')?{}:{next:'?page=2'}),url),doc,Readability);
  assert.equal(article.status,'ready'); assert.equal(article.blocks.length,16);
});
test('an inaccessible later page leaves explicitly partial content', async () => {
  const article=await core.readArticle(item,async url=>response(html(url.includes('?page=2')?{paid:true}:{next:'?page=2'}),url),doc,Readability);
  assert.equal(article.status,'partial'); assert.equal(article.reason,'next_page_unavailable'); assert.equal(article.blocks.length,8);
});
test('page limits cannot silently claim a complete article', async () => {
  const article=await core.readArticle(item,async url=>{const page=Number(new global.URL(url).searchParams.get('page')||1);return response(html({next:'?page='+(page+1)}),url);},doc,Readability);
  assert.equal(article.status,'partial'); assert.equal(article.blocks.length,24);
});
test('photo captions are not labelled as article bodies', async () => {
  const photo='https://www.sponichi.co.jp/baseball/gazo/123.html';
  await assert.rejects(core.readArticle({...item,url:photo},async()=>response(html(),photo),doc,Readability),error=>error.code==='photo_page');
});
test('photo pages follow an explicit link to the article', async () => {
  const photo='https://www.nikkansports.com/baseball/photonews/123-0.html';
  const articleUrl='https://www.nikkansports.com/baseball/news/123.html';
  const result=await core.readArticle({...item,url:photo},async url=>response(url===photo?`<a href="${articleUrl}">写真の記事を読む</a>`:html(),url),doc,Readability);
  assert.equal(result.url,articleUrl); assert.equal(result.status,'ready');
});
test('explicitly free Fusion text is extracted without executing scripts', () => {
  const story={type:'story',headlines:{basic:TITLE},content_restrictions:{content_code:'free'},content_elements:paragraphs.map(text=>({type:'text',content:'<p>'+text+'</p>'}))};
  const page=doc(`<html><head><title>${TITLE}</title></head><body><script>Fusion.globalContent=${JSON.stringify(story)};window.stolen=true;</script></body></html>`);
  const result=core.extract(page,URL,TITLE,Readability); assert.equal(result.blocks.length,8); assert.equal(result.embedded,false);
});
test('restricted Fusion data is never used as a free body', () => {
  const story={type:'story',content_restrictions:{content_code:'premium'},content_elements:[]};
  const page=doc(`<script>Fusion.globalContent=${JSON.stringify(story)};</script>`);
  assert.throws(()=>core.extract(page,URL,TITLE,Readability),error=>error.code==='paywall');
});

function appWindow(indexedDB) {
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT,'site/index.html'),'utf8'), {url:'https://tyr-ui.github.io/mynews-free/',runScripts:'outside-only'});
  const window=dom.window;
  if (indexedDB) window.indexedDB=indexedDB;
  window.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
  window.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');this.dispatchEvent(new window.Event('close'));};
  window.fetch=async()=>({ok:true,json:async()=>({items:[item],failed_sources:[],source_status:[],updated_at:'2026-11-15T00:00:00Z'})});
  for(const script of ['reader-core.js','reader.js','app.js']) window.eval(fs.readFileSync(path.join(ROOT,'site',script),'utf8'));
  window.document.getElementById('reader-prefetch').checked=false;
  return dom;
}
const tick=()=>new Promise(resolve=>setTimeout(resolve,20));
function send(window,data) {window.dispatchEvent(new window.MessageEvent('message',{source:window,origin:window.location.origin,data:{channel:'mynews-private-reader',version:1,...data}}));}
test('headlines open in-page and unconfigured excerpts are not labelled full text', async () => {
  const dom=appWindow(),w=dom.window; await tick();
  w.document.querySelector('.headline-button').click(); await tick();
  assert.equal(w.location.href,'https://tyr-ui.github.io/mynews-free/');
  assert.ok(w.document.getElementById('reader-dialog').open);
  assert.match(w.document.getElementById('reader-format').textContent,/本文未取得/);
  assert.match(w.document.getElementById('reader-state').textContent,/初回設定/);
  assert.equal(w.document.querySelector('.card').classList.contains('read'),false);
  dom.window.close();
});
test('a helper result renders as text and a second open uses the local cache', async () => {
  const dom=appWindow(),w=dom.window; await tick(); let count=0;
  const article={status:'ready',title:TITLE,url:URL,blocks:[{type:'paragraph',text:paragraphs[0]},{type:'paragraph',text:'<script>window.stolen=true</script>'}],chars:150,fetchedAt:'2026-11-15T00:00:00Z'};
  w.postMessage=data=>{if(data.type==='read'){count++;queueMicrotask(()=>send(w,{type:'result',requestId:data.requestId,article}));}};
  send(w,{type:'ready'});
  await w.MyNewsReader.open(item); await tick();
  assert.match(w.document.getElementById('reader-format').textContent,/取得できた本文/);
  assert.equal(w.document.getElementById('reader-body').querySelectorAll('script').length,0);
  assert.equal(w.stolen,undefined); assert.equal(count,1);
  w.document.getElementById('reader-close').click();
  await w.MyNewsReader.open(item); await tick();
  assert.equal(count,1); assert.match(w.document.getElementById('reader-state').textContent,/端末の保存データ/);
  assert.equal(w.document.querySelector('.card').classList.contains('read'),true);
  dom.window.close();
});
test('foreign-origin helper messages are ignored', async () => {
  const dom=appWindow(),w=dom.window; await tick();
  w.dispatchEvent(new w.MessageEvent('message',{source:w,origin:'https://evil.example',data:{channel:'mynews-private-reader',version:1,type:'ready'}}));
  assert.match(w.document.getElementById('reader-capability').textContent,/初回設定/);
  dom.window.close();
});
test('unsupported sources and trend keywords do not wait for a body request', async () => {
  const dom=appWindow(),w=dom.window; await tick(); let count=0;
  w.postMessage=data=>{if(data.type==='read')count++;}; send(w,{type:'ready'});
  await w.MyNewsReader.open({...item,id:'unsupported',url:'https://unsupported.example/article'});
  assert.match(w.document.getElementById('reader-state').textContent,/対応対象外/);
  await w.MyNewsReader.open({...item,id:'trend',kind:'search_trend',url:'https://www.google.com/search?q=example'});
  assert.equal(w.document.getElementById('reader-format').textContent,'検索キーワード'); assert.equal(count,0);
  dom.window.close();
});
test('a page reload can read a persisted body without the helper or another download', async () => {
  const indexedDB=new IDBFactory();
  const first=appWindow(indexedDB),w=first.window; await tick();
  const article={status:'ready',title:TITLE,url:URL,blocks:[{type:'paragraph',text:paragraphs[0]}],chars:paragraphs[0].length,fetchedAt:'2026-11-15T00:00:00Z'};
  w.postMessage=data=>{if(data.type==='read')queueMicrotask(()=>send(w,{type:'result',requestId:data.requestId,article}));};
  send(w,{type:'ready'}); await w.MyNewsReader.open(item); await tick(); first.window.close();
  const second=appWindow(indexedDB); await tick();
  await second.window.MyNewsReader.open(item); await tick();
  assert.match(second.window.document.getElementById('reader-state').textContent,/端末の保存データ/);
  assert.equal(second.window.document.getElementById('reader-body').textContent,paragraphs[0]);
  second.window.close();
});
test('expired persisted bodies are not shown as current cached content', async () => {
  const indexedDB=new IDBFactory();
  const open=indexedDB.open('mynews-private-reader-v1',1);
  open.onupgradeneeded=()=>open.result.createObjectStore('articles',{keyPath:'id'});
  const db=await new Promise(resolve=>open.onsuccess=()=>resolve(open.result));
  await new Promise(resolve=>{const tx=db.transaction('articles','readwrite');tx.objectStore('articles').put({id:item.id,url:item.url,savedAt:Date.now()-8*86400000,article:{status:'ready',blocks:[{type:'paragraph',text:'expired'}]}});tx.oncomplete=resolve;});
  db.close();
  const app=appWindow(indexedDB); await tick(); await app.window.MyNewsReader.open(item); await tick();
  assert.match(app.window.document.getElementById('reader-format').textContent,/本文未取得/);
  app.window.close();
});
