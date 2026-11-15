"""MyNews v0.1: free, source-aware topic and headline collector.

No LLM is used. Headlines/snippets are metadata provided by their respective sources,
not independently verified facts or AI summaries. Individual source failures are nonfatal.
"""
from __future__ import annotations

import calendar
import hashlib
import html
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'site' / 'data' / 'news.json'
JST = timezone(timedelta(hours=9))
USER_AGENT = 'MyNewsPersonalReader/0.1 (personal noncommercial RSS reader)'
MAX_ITEMS = 350
MAX_AGE_HOURS = 96
RSS_JP = 'https://news.google.com/rss'

# These are coverage/discovery queries, NOT a claim that the stories are trending on X.
NEWS_SEARCHES = [
    ('野球', 'プロ野球 ヤクルト 移籍 契約 けが 報道'),
    ('野球', 'NPB プロ野球 話題 選手'),
    ('野球', 'MLB メジャーリーグ 大谷 日本人選手 移籍'),
    ('漫画', '漫画 アニメ SNS 話題 炎上 考察'),
    ('漫画', '漫画 アニメ 人気 話題'),
    ('IT', 'サイバー攻撃 脆弱性 IT セキュリティ'),
    ('IT', 'インフラエンジニア クラウド ネットワーク 技術'),
    ('AI', '生成AI ChatGPT Claude Gemini 新モデル'),
    ('AI', '人工知能 AI 新サービス 技術'),
    ('政治', '政治 国会 政府 選挙 政策'),
    ('経済', '日本 経済 税金 物価 賃金 円相場'),
    ('国際', '世界 国際情勢 外交 紛争'),
    ('社会', '社会 事件 法改正 生活 防災'),
    ('社会', '地震 台風 気象庁 警報 災害'),
]
BSKY_SEARCHES = [
    ('野球', 'ヤクルト'), ('野球', 'プロ野球'), ('野球', 'MLB'),
    ('漫画', '漫画'), ('漫画', 'アニメ'),
    ('IT', 'セキュリティ'), ('AI', '生成AI'),
    ('政治', '政治'), ('社会', 'ニュース')
]
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


def score_article(item):
    # Personal relevance heuristic, NOT an objectively calibrated probability.
    title = item.get('title', '').casefold()
    category = item.get('category', '社会')
    score = 30
    if item['kind'] == 'search_trend':
        score += 23
    elif item['kind'] == 'popular_link':
        score += 18
    elif item['kind'] == 'social_post':
        # reactions are observable on Bluesky only, not total cross-platform buzz.
        reactions = max(0, int(item.get('reactions') or 0))
        score += min(35, int(reactions ** 0.5 * 2))
    if category in ('政治', '国際', '社会', '経済'):
        score += 5
    if any(word in title for word in IMPORTANT):
        score += 12
    if category in ('野球', '漫画', 'IT', 'AI') and any(word in title for word in KEYWORDS[category]):
        score += 8
    try:
        dt = datetime.fromisoformat(item['published_at'].replace('Z', '+00:00'))
        age_h = max(0, (datetime.now(timezone.utc) - dt).total_seconds() / 3600)
        score += max(0, 16 - int(age_h // 5))
    except (ValueError, TypeError):
        pass
    return min(100, score)


def categorize(title, preferred=None):
    if preferred:
        return preferred
    normalized = title.casefold()
    scores = {cat: sum(1 for k in words if k in normalized) for cat, words in KEYWORDS.items()}
    best = max(scores, key=scores.get)
    return best if scores[best] > 0 else '話題'


def rss_items(xml_bytes, source, kind, category=None, limit=30):
    root = ET.fromstring(xml_bytes)
    result = []
    # RSS 2.0 and Atom supported with stdlib; no full-text scraping.
    nodes = root.findall('.//item')
    if not nodes:
        ns = '{http://www.w3.org/2005/Atom}'
        nodes = root.findall(f'.//{ns}entry')
        is_atom = True
    else:
        is_atom = False
    for node in nodes[:limit]:
        if is_atom:
            ns = '{http://www.w3.org/2005/Atom}'
            title = elem_text(node, f'{ns}title')
            link_node = node.find(f'{ns}link')
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
            publisher = elem_text(node, 'source')
            if publisher:
                source_name = publisher + ' / Google News経由'
            else:
                source_name = source
        else:
            source_name = source
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
        item = {
            'id': stable_id(link), 'title': title, 'url': link,
            'excerpt': strip_html(desc)[:260],
            'category': categorize(title, category), 'source': source_name,
            'kind': kind, 'published_at': parse_timestamp(published),
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


def news_search_url(query):
    q = urllib.parse.urlencode({'q': query + ' when:2d', 'hl': 'ja', 'gl': 'JP', 'ceid': 'JP:ja'})
    return RSS_JP + '/search?' + q


def collect_all(fetch=http_get):
    items, errors = [], []
    feeds = [
        ('Google Trends (日本)', 'search_trend', 'https://trends.google.com/trending/rss?geo=JP', None, 40),
        ('はてな人気エントリー', 'popular_link', 'https://b.hatena.ne.jp/hotentry.rss', None, 40),
        ('Google News 国内主要', 'news', RSS_JP + '?hl=ja&gl=JP&ceid=JP:ja', None, 50),
    ]
    feeds += [(f'Google News / {cat}', 'news', news_search_url(query), cat, 15) for cat, query in NEWS_SEARCHES]
    for name, kind, url, category, limit in feeds:
        try:
            items.extend(rss_items(fetch(url), name, kind, category, limit))
        except (ValueError, ET.ParseError, UnicodeError, OSError, urllib.error.URLError) as exc:
            errors.append(f'{name}: {type(exc).__name__}')
            print('FETCH ERROR:', name, str(exc)[:180])
        time.sleep(.25)
    for category, term in BSKY_SEARCHES:
        url = 'https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?' + urllib.parse.urlencode({
            'q': term, 'sort': 'top', 'limit': 35, 'lang': 'ja'
        })
        try:
            payload = json.loads(fetch(url, json_expected=True))
            items.extend(bsky_items(payload, category))
        except (ValueError, UnicodeError, OSError, urllib.error.URLError) as exc:
            errors.append(f'Bluesky / {term}: {type(exc).__name__}')
            print('FETCH ERROR: Bluesky', term, str(exc)[:180])
        time.sleep(.3)
    return items, errors


def merge_with_previous(new_items, old_items, now=None):
    now = now or datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=MAX_AGE_HOURS)
    unique = {}
    # Old entries first, newly-fetched entries replace them.
    for item in (old_items or []) + new_items:
        try:
            dt = datetime.fromisoformat(item['published_at'].replace('Z', '+00:00'))
        except (KeyError, ValueError, TypeError):
            continue
        if dt < cutoff or dt > now + timedelta(hours=2):
            continue
        if not str(item.get('url', '')).startswith(('http://', 'https://')):
            continue
        key = item.get('id') or stable_id(item['url'])
        unique[key] = item
    return sorted(unique.values(), key=lambda a: (a.get('score', 0), a['published_at']), reverse=True)[:MAX_ITEMS]


def run():
    old = []
    if OUTPUT.exists():
        try:
            old = json.loads(OUTPUT.read_text(encoding='utf8')).get('items', [])
        except (ValueError, OSError):
            print('Previous data could not be loaded; starting fresh')
    fresh, errors = collect_all()
    items = merge_with_previous(fresh, old)
    # Do not overwrite a functional deployment with empty data if all sources fail.
    if not items:
        raise RuntimeError('All sources failed and no recent entries remain; refusing empty publish.')
    out = {
        'schema_version': 1, 'updated_at': iso_now(),
        'count': len(items), 'fetched_count': len(fresh),
        'failed_sources': errors, 'items': items,
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    temp = OUTPUT.with_suffix('.tmp')
    temp.write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')), encoding='utf8')
    temp.replace(OUTPUT)
    print(f'Wrote {len(items)} entries; fetched {len(fresh)}; failed sources {len(errors)}')


if __name__ == '__main__':
    run()
