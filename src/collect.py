"""MyNews v0.2: free, source-aware topic and headline collector.

No LLM is used. Headlines/snippets are metadata provided by their respective sources,
not independently verified facts or AI summaries. Individual source failures are nonfatal.
"""
from __future__ import annotations

import hashlib
import html
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

from src.sources import BASEBALL_MEDIA, BSKY_SEARCHES, configured_feeds

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'site' / 'data' / 'news.json'
USER_AGENT = 'MyNewsPersonalReader/0.2 (personal noncommercial headline reader)'
MAX_ITEMS = 1800
MAX_CATEGORY_ITEMS = 600
MAX_AGE_HOURS = 96
STOP_TITLES = {'スポーツ', 'エンタメ', '芸能', '速報', 'ニュース', '漫画', 'アニメ'}
KEYWORDS = {
    '野球': ('野球', 'ヤクルト', 'スワローズ', 'npb', 'mlb', 'ドジャース', 'メジャー', '大谷', '投手', '捕手'),
    '漫画': ('漫画', 'マンガ', 'アニメ', 'コミック', 'ジャンプ', 'マガポケ', 'マンガワン'),
    'IT': ('セキュリティ', '脆弱性', 'クラウド', 'linux', 'windows', 'ネットワーク', '障害', 'github', 'it'),
    'AI': ('ai', '人工知能', '生成ai', 'gpt', 'gemini', 'claude', 'openai', 'anthropic', 'llm'),
    '政治': ('政治', '内閣', '国会', '選挙', '首相', '政党', '法案', '議員', '政府'),
    '経済': ('経済', '物価', '税制', '増税', '為替', '日銀', '賃金', '金利', '株価'),
    '国際': ('外交', '国際', '戦争', '紛争', '国連', '大統領', '中国', '米国'),
    '社会': ('社会', '地震', '台風', '災害', '事故', '事件', '警報', '感染', '防災'),
}
IMPORTANT = ('地震', '津波', '避難', '警報', '緊急', '災害', '停電', '重大', '選挙', '法改正', '金利', '税制')


def iso_now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def parse_timestamp(value, fallback=None):
    if not value:
        return fallback or iso_now()
    try:
        ts = parsedate_to_datetime(str(value))
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        return ts.astimezone(timezone.utc).isoformat(timespec='seconds')
    except (TypeError, ValueError, OverflowError):
        try:
            return datetime.fromisoformat(str(value).replace('Z', '+00:00')).astimezone(timezone.utc).isoformat(timespec='seconds')
        except ValueError:
            return fallback or iso_now()


def strip_html(raw):
    raw = re.sub(r'<[^>]+>', ' ', raw or '')
    return re.sub(r'\s+', ' ', html.unescape(raw)).strip()


def elem_text(el, name):
    child = el.find(name)
    if child is None:
        child = next((node for node in el if node.tag.rsplit('}', 1)[-1] == name.rsplit('}', 1)[-1]), None)
    return ''.join(child.itertext()).strip() if child is not None else ''


def stable_id(url):
    return hashlib.sha256(url.encode('utf-8')).hexdigest()[:20]


def http_get(url, json_expected=False):
    request = urllib.request.Request(url, headers={
        'User-Agent': USER_AGENT,
        'Accept': 'application/json' if json_expected else 'application/rss+xml, application/atom+xml, text/xml, */*',
    })
    with urllib.request.urlopen(request, timeout=17) as response:
        return response.read(1_700_000)


def keyword_matches(title, word):
    if word.isascii():
        return bool(re.search(r'(?<![a-z0-9])' + re.escape(word) + r'(?![a-z0-9])', title))
    return word in title


def score_article(item, now=None):
    # Personal relevance heuristic, NOT an objectively calibrated probability.
    title = item.get('title', '').casefold()
    category = item.get('category', '社会')
    score = 30
    if item.get('kind') == 'search_trend':
        score += 23
    elif item.get('kind') == 'popular_link':
        score += 18
    elif item.get('kind') == 'social_post':
        # reactions are observable on Bluesky only, not total cross-platform buzz.
        reactions = max(0, int(item.get('reactions') or 0))
        score += min(35, int(reactions ** 0.5 * 2))
    if category in ('政治', '国際', '社会', '経済'):
        score += 5
    if any(word in title for word in IMPORTANT):
        score += 12
    if category in ('野球', '漫画', 'IT', 'AI') and any(keyword_matches(title, word) for word in KEYWORDS[category]):
        score += 8
    try:
        dt = datetime.fromisoformat(item['published_at'].replace('Z', '+00:00'))
        age_h = max(0, ((now or datetime.now(timezone.utc)) - dt).total_seconds() / 3600)
        score += max(0, 16 - int(age_h // 5))
    except (ValueError, TypeError):
        pass
    return min(100, score)


def categorize(title, preferred=None):
    if preferred:
        return preferred
    normalized = title.casefold()
    scores = {cat: sum(1 for k in words if keyword_matches(normalized, k)) for cat, words in KEYWORDS.items()}
    best = max(scores, key=scores.get)
    return best if scores[best] > 0 else '話題'


def publisher_name(name, domain='', fallback=None):
    host = urllib.parse.urlsplit(domain).hostname or domain
    for key, label, media_host, query in BASEBALL_MEDIA:
        if host == media_host or host.endswith('.' + media_host):
            return label
    aliases = {'Sponichi': 'スポニチ', 'スポニチ': 'スポニチ', 'サンスポ': 'サンスポ',
               'デイリー': 'デイリー', '報知': 'スポーツ報知', '日刊スポーツ': '日刊スポーツ',
               '産経': '産経新聞', 'Full-Count': 'Full-Count', 'BASEBALL KING': 'BASEBALL KING'}
    for alias, label in aliases.items():
        if alias.casefold() in name.casefold():
            return label
    return name or fallback or '配信元不明'


def rss_items(xml_bytes, source, kind, category=None, limit=30, publisher=None, feed_id=None):
    root = ET.fromstring(xml_bytes)
    result = []
    # Hatena uses namespace-qualified RSS 1.0 (RDF), alongside RSS 2.0/Atom.
    nodes = [node for node in root.iter() if node.tag.rsplit('}', 1)[-1] in ('item', 'entry')]
    for node in nodes[:limit]:
        is_atom = node.tag.rsplit('}', 1)[-1] == 'entry'
        if is_atom:
            ns = '{http://www.w3.org/2005/Atom}'
            title = elem_text(node, f'{ns}title')
            links = node.findall(f'{ns}link')
            link_node = next((link for link in links if link.attrib.get('rel', 'alternate') == 'alternate'), None)
            link = (link_node.attrib.get('href', '') if link_node is not None else '')
            desc = elem_text(node, f'{ns}summary') or elem_text(node, f'{ns}content')
            published = elem_text(node, f'{ns}published') or elem_text(node, f'{ns}updated')
        else:
            title = elem_text(node, 'title')
            link = elem_text(node, 'link')
            desc = elem_text(node, 'description')
            published = elem_text(node, 'pubDate') or elem_text(node, '{http://purl.org/dc/elements/1.1/}date')
        title = strip_html(title)[:200]
        link = link.strip()
        if not title or title in STOP_TITLES or not link.startswith(('https://', 'http://')):
            continue
        extra = {}
        if kind == 'news':
            # Google News RSS exposes original publisher as <source>.
            source_node = node.find('source')
            media = publisher_name(elem_text(node, 'source'), source_node.attrib.get('url', '') if source_node is not None else '', publisher)
            if media != '配信元不明':
                source_name = media + ' / Google News経由'
            else:
                source_name = source
        else:
            source_name = source
            media = publisher or source
        if kind == 'search_trend':
            traffic = elem_text(node, '{https://trends.google.com/trending/rss}approx_traffic')
            # Known Google Trends RSS namespace variant; if absent leave blank.
            if not traffic:
                for child in node:
                    if child.tag.lower().endswith('approx_traffic'):
                        traffic = (child.text or '').strip()
            if traffic:
                extra['search_volume_label'] = traffic
            # Trending RSS headline is the keyword, not a reported event.
            desc = 'Google検索の急上昇キーワード。出来事の内容・真偽を示すものではありません。'
            # Trending feeds share a channel URL; a URL-only ID collapsed all keywords into one.
            link = 'https://www.google.com/search?' + urllib.parse.urlencode({'q': title})
        item = {
            'id': stable_id(link), 'title': title, 'url': link,
            'excerpt': strip_html(desc)[:260],
            'category': categorize(title, category), 'source': source_name,
            'kind': kind, 'published_at': parse_timestamp(published),
            'publisher': media, 'feed_ids': [feed_id] if feed_id else [],
            **extra,
        }
        item['score'] = score_article(item)
        result.append(item)
    return result


def bsky_items(payload, category):
    result = []
    for post in payload.get('posts', [])[:35]:
        record = post.get('record', {})
        text = strip_html(record.get('text', '')).replace('\u0000', '')
        author = post.get('author', {})
        handle = author.get('handle', '')
        uri = post.get('uri', '')
        rkey = uri.rsplit('/', 1)[-1] if '/' in uri else ''
        if not text or not handle or not rkey or len(text) < 10:
            continue
        url = f'https://bsky.app/profile/{urllib.parse.quote(handle)}/post/{urllib.parse.quote(rkey)}'
        reactions = int(post.get('likeCount') or 0) + 2 * int(post.get('repostCount') or 0)
        item = {
            'id': stable_id(uri), 'title': text[:110] + ('…' if len(text) > 110 else ''),
            'url': url, 'excerpt': text[:260], 'category': category,
            'source': 'Bluesky / @' + handle, 'kind': 'social_post',
            'reactions': reactions,
            'published_at': parse_timestamp(record.get('createdAt') or post.get('indexedAt')),
        }
        item['score'] = score_article(item)
        result.append(item)
    return result


def error_label(exc):
    return f'HTTP {exc.code}' if isinstance(exc, urllib.error.HTTPError) else type(exc).__name__


def collect_all(fetch=http_get, feeds=None, social_searches=None):
    items, errors, statuses = [], [], []
    feeds = configured_feeds() if feeds is None else feeds
    social_searches = BSKY_SEARCHES if social_searches is None else social_searches

    def fetch_feed(spec):
        status = {'id': spec['id'], 'name': spec['name'], 'category': spec['category'], 'kind': spec['kind'], 'fetched_count': 0}
        try:
            entries = rss_items(fetch(spec['url']), spec['name'], spec['kind'], spec['category'], spec['limit'], spec['publisher'], spec['id'])
            status.update(status='ok' if entries else 'empty', fetched_count=len(entries))
            print(f'FETCH: {spec["name"]}: {len(entries)} entries')
            return entries, status
        except (ValueError, ET.ParseError, UnicodeError, OSError, urllib.error.URLError) as exc:
            status.update(status='error', error=error_label(exc))
            print('FETCH ERROR:', spec['name'], str(exc)[:180])
            return [], status

    with ThreadPoolExecutor(max_workers=4) as executor:
        for entries, status in executor.map(fetch_feed, feeds):
            items.extend(entries)
            statuses.append(status)
            if status['status'] == 'error':
                errors.append(status['name'] + ': ' + status['error'])
    for category, term in social_searches:
        key = 'bsky-' + term
        status = dict(id=key, name='Bluesky / ' + term, category=category, kind='social_post', fetched_count=0)
        url = 'https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?' + urllib.parse.urlencode({
            'q': term, 'sort': 'top', 'limit': 35, 'lang': 'ja'
        })
        try:
            payload = json.loads(fetch(url, json_expected=True))
            entries = bsky_items(payload, category)
            for entry in entries:
                entry['feed_ids'] = [key]
                entry['publisher'] = 'Bluesky'
            items.extend(entries)
            status.update(status='ok' if entries else 'empty', fetched_count=len(entries))
        except (ValueError, UnicodeError, OSError, urllib.error.URLError) as exc:
            status.update(status='error', error=error_label(exc))
            errors.append(f'Bluesky / {term}: {error_label(exc)}')
            print('FETCH ERROR: Bluesky', term, str(exc)[:180])
        statuses.append(status)
        time.sleep(.3)
    return items, errors, statuses


def dedup_key(item):
    if item.get('kind') == 'search_trend':
        return 'trend:' + item['title'].casefold()
    parts = urllib.parse.urlsplit(item.get('url', ''))
    query = urllib.parse.urlencode([(k, v) for k, v in urllib.parse.parse_qsl(parts.query)
                                   if not k.startswith('utm_') and k not in ('oc', 'fbclid', 'gclid')])
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, query, ''))


def merge_with_previous(new_items, old_items, now=None):
    now = now or datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=MAX_AGE_HOURS)
    unique = {}
    # Old entries first, newly-fetched entries replace them.
    for item in (old_items or []) + new_items:
        try:
            dt = datetime.fromisoformat(item['published_at'].replace('Z', '+00:00'))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
        except (KeyError, ValueError, TypeError):
            continue
        if dt < cutoff or dt > now + timedelta(hours=2):
            continue
        if not str(item.get('url', '')).startswith(('http://', 'https://')):
            continue
        key = dedup_key(item)
        previous = unique.get(key, {})
        entry = dict(item)
        entry['feed_ids'] = sorted(set(previous.get('feed_ids', [])) | set(item.get('feed_ids', [])))
        if previous and item.get('kind') != 'search_trend':
            entry['id'] = previous['id']
        entry['score'] = score_article(entry, now=now)
        unique[key] = entry
    # Bound history by recency and category so one busy desk cannot crowd out all others.
    result, counts = [], Counter()
    for entry in sorted(unique.values(), key=lambda item: item['published_at'], reverse=True):
        category = entry.get('category', '話題')
        if counts[category] >= MAX_CATEGORY_ITEMS:
            continue
        result.append(entry)
        counts[category] += 1
        if len(result) >= MAX_ITEMS:
            break
    return result


def run(output=OUTPUT):
    old = []
    if output.exists():
        try:
            old = json.loads(output.read_text(encoding='utf8')).get('items', [])
        except (ValueError, OSError):
            print('Previous data could not be loaded; starting fresh')
    fresh, errors, statuses = collect_all()
    items = merge_with_previous(fresh, old)
    # Do not overwrite a functional deployment with empty data if all sources fail.
    if not items:
        raise RuntimeError('All sources failed and no recent entries remain; refusing empty publish.')
    for status in statuses:
        status['retained_count'] = sum(status['id'] in item.get('feed_ids', []) for item in items)
    out = {
        'schema_version': 1, 'updated_at': iso_now(),
        'count': len(items), 'fetched_count': len(fresh),
        'failed_sources': errors, 'items': items,
        'source_status': statuses,
        'category_counts': dict(Counter(item['category'] for item in items)),
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    temp = output.with_suffix('.tmp')
    temp.write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')), encoding='utf8')
    temp.replace(output)
    print(f'Wrote {len(items)} entries; fetched {len(fresh)}; failed sources {len(errors)}')
    return out


if __name__ == '__main__':
    run()
