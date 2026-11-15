const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {JSDOM} = require('jsdom');
const ROOT = path.resolve(__dirname, '..');
const feed = (ids, hour = 0) => ({updated_at:`2026-11-15T${String(hour).padStart(2,'0')}:00:00Z`,items:ids.map(id=>({id,title:`確認用記事 ${id}`,url:`https://www.daily.co.jp/baseball/${id}.shtml`,category:'野球',source:'動作確認用',kind:'news',published_at:`2026-11-15T${String(hour).padStart(2,'0')}:00:00Z`})),failed_sources:[],source_status:[]});
const settle = () => new Promise(resolve => setImmediate(resolve));
function app() {
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT,'site/index.html'),'utf8'),{url:'https://tyr-ui.github.io/mynews-free/',runScripts:'outside-only'});
  const w=dom.window,d=w.document;
  let now=1000000,hidden=false,online=true,interval,current=feed(['a']),cache=false,fail=false,hold=null;
  const calls=[];
  w.Date.now=()=>now;
  Object.defineProperty(d,'hidden',{get:()=>hidden});
  Object.defineProperty(w.navigator,'onLine',{get:()=>online});
  w.setInterval=callback=>{interval=callback;return 1;};
  w.MyNewsReader={schedule(){},isCached(){return false;},open(){d.getElementById('reader-dialog').setAttribute('open','');}};
  w.fetch=async(url,options)=>{
    calls.push({url,options});
    if(hold) await hold;
    if(fail) throw new Error('network');
    return {ok:true,headers:{get:()=>cache?'offline':null},json:async()=>current};
  };
  w.eval(fs.readFileSync(path.join(ROOT,'site/app.js'),'utf8'));
  return {dom,w,d,calls,close:()=>w.close(),poll:()=>interval(),advance:ms=>{now+=ms;},data:value=>{current=value;},hidden:value=>{hidden=value;},cache:value=>{cache=value;},fail:value=>{fail=value;},hold:value=>{hold=value;},online:value=>{online=value;w.dispatchEvent(new w.Event(value?'online':'offline'));},resume:()=>d.dispatchEvent(new w.Event('visibilitychange'))};
}

test('opening and manual refresh check public data without triggering collection',async t=>{
  const a=app();t.after(a.close);await settle();
  assert.equal(a.d.querySelectorAll('.card').length,1);
  assert.equal(a.calls[0].url,'./data/news.json');
  assert.equal(a.calls[0].options.cache,'no-cache');
  a.data(feed(['a','b'],1));a.d.getElementById('refresh').click();await settle();
  assert.equal(a.d.querySelectorAll('.card').length,2);
  assert.match(a.d.getElementById('last-updated').textContent,/収集完了/);
  assert.ok(a.calls.every(call=>call.url==='./data/news.json'));
  assert.match(a.d.getElementById('collect-now').href,/github.com\/tyr-ui\/mynews-free\/actions\/workflows\/update.yml$/);
});

test('unchanged automatic checks preserve rendered cards and skip hidden tabs',async t=>{
  const a=app();t.after(a.close);await settle();
  const card=a.d.querySelector('.card');
  a.poll();await settle();assert.equal(a.d.querySelector('.card'),card);
  a.hidden(true);a.poll();await settle();assert.equal(a.calls.length,2);
});

test('automatic new data stays pending during reading and preserves filters on apply',async t=>{
  const a=app();t.after(a.close);await settle();
  a.d.querySelector('[data-category="野球"]').click();
  a.d.querySelector('.headline-button').click();
  const card=a.d.querySelector('.card');
  a.data(feed(['a','b'],1));a.poll();await settle();
  assert.equal(a.d.querySelector('.card'),card);
  assert.ok(a.d.getElementById('reader-dialog').open);
  assert.match(a.d.getElementById('apply-news').textContent,/新着1件/);
  a.d.getElementById('reader-dialog').removeAttribute('open');
  a.data(feed(['older'],0));a.d.getElementById('refresh').click();await settle();
  assert.match(a.d.getElementById('load-status').textContent,/より新しい公開データ/);
  a.d.getElementById('apply-news').click();
  assert.equal(a.d.querySelectorAll('.card').length,2);
  assert.equal(a.d.querySelector('[data-category="野球"]').getAttribute('aria-pressed'),'true');
  assert.ok(a.d.getElementById('apply-news').hidden);
});

test('returning checks are throttled and also support restored mobile pages',async t=>{
  const a=app();t.after(a.close);await settle();
  a.resume();await settle();assert.equal(a.calls.length,1);
  a.advance(61000);a.resume();await settle();assert.equal(a.calls.length,2);
  a.resume();await settle();assert.equal(a.calls.length,2);
  a.advance(61000);const event=new a.w.Event('pageshow');Object.defineProperty(event,'persisted',{value:true});a.w.dispatchEvent(event);await settle();
  assert.equal(a.calls.length,3);
});

test('offline cache and request failures do not claim a successful latest check',async t=>{
  const a=app();t.after(a.close);await settle();
  const card=a.d.querySelector('.card');
  a.cache(true);a.poll();await settle();
  assert.match(a.d.getElementById('load-status').textContent,/最新情報の確認は未完了/);
  assert.equal(a.d.querySelector('.card'),card);
  a.cache(false);a.fail(true);a.poll();await settle();
  assert.match(a.d.getElementById('load-status').textContent,/確認できませんでした/);
  assert.equal(a.d.querySelector('.card'),card);
  assert.equal(a.d.getElementById('refresh').disabled,false);
  a.fail(false);a.online(false);a.poll();await settle();assert.equal(a.calls.length,3);
  a.online(true);await settle();assert.equal(a.calls.length,4);
});

test('older deployments cannot replace newer displayed articles',async t=>{
  const a=app();t.after(a.close);await settle();
  a.data(feed(['newer'],2));a.d.getElementById('refresh').click();await settle();
  a.data(feed(['older'],1));a.d.getElementById('refresh').click();await settle();
  assert.match(a.d.querySelector('.headline-button').textContent,/newer/);
  assert.match(a.d.getElementById('load-status').textContent,/反映待ち/);
});

test('overlapping return events share one request',async t=>{
  const a=app();t.after(a.close);await settle();let release;
  a.hold(new Promise(resolve=>{release=resolve;}));
  a.poll();a.online(true);a.advance(61000);a.resume();
  assert.equal(a.calls.length,2);
  release();await settle();assert.equal(a.d.getElementById('refresh').disabled,false);
});

test('service worker explicitly identifies an offline news fallback',async()=>{
  let listener;
  const cached=new Response(JSON.stringify(feed(['cached'])),{headers:{'Content-Type':'application/json'}});
  const context={URL,Request,Response,Headers,Promise,location:{origin:'https://tyr-ui.github.io'},fetch:async()=>{throw new Error('offline');},caches:{match:async()=>cached},self:{registration:{scope:'https://tyr-ui.github.io/mynews-free/'},addEventListener:(name,callback)=>{if(name==='fetch')listener=callback;}}};
  vm.runInNewContext(fs.readFileSync(path.join(ROOT,'site/sw.js'),'utf8'),context);
  let result;
  listener({request:new Request('https://tyr-ui.github.io/mynews-free/data/news.json'),respondWith:promise=>{result=promise;}});
  const response=await result;
  assert.equal(response.headers.get('X-MyNews-Cache'),'offline');
  assert.equal((await response.json()).items[0].id,'cached');
});
