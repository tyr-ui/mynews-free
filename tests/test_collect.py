import unittest
import sys
import urllib.error
import urllib.parse
from pathlib import Path
from datetime import datetime, timedelta, timezone
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.collect import rss_items, bsky_items, merge_with_previous, score_article, categorize, collect_all, MAX_CATEGORY_ITEMS
from src.sources import configured_feeds, feed

RSS = b'''<?xml version="1.0"?><rss><channel>
<item><title>Test tech news</title><link>https://example.org/one</link>
<description>&lt;b&gt;source summary&lt;/b&gt;</description>
<pubDate>Sun, 15 Nov 2026 00:00:00 GMT</pubDate></item>
</channel></rss>'''

class TestCollectors(unittest.TestCase):
    def test_rss_metadata(self):
        entries = rss_items(RSS, 'fixture', 'news', category='IT')
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]['category'], 'IT')
        self.assertEqual(entries[0]['excerpt'], 'source summary')
        self.assertTrue(entries[0]['url'].startswith('https://'))

    def test_bsky_post(self):
        post = {'posts': [{'uri': 'at://did:plc:aaa/app.bsky.feed.post/xyz',
            'record': {'text': '新しい生成AIの実装が話題になっているらしい', 'createdAt': '2026-11-15T00:00:00Z'},
            'author': {'handle': 'demo.bsky.social'}, 'likeCount': 20, 'repostCount': 10}]}
        items = bsky_items(post, 'AI')
        self.assertEqual(items[0]['reactions'], 40)
        self.assertEqual(items[0]['kind'], 'social_post')
        self.assertIn('demo.bsky.social', items[0]['url'])

    def test_dedup_and_expiry(self):
        now = datetime(2026, 11, 15, tzinfo=timezone.utc)
        base = {'id': 'abc', 'url': 'https://example.org/one', 'published_at': '2026-11-14T00:00:00+00:00', 'score': 55}
        result = merge_with_previous([dict(base, excerpt='updated', feed_ids=['new'])], [dict(base, feed_ids=['old'])], now=now)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]['excerpt'], 'updated')
        self.assertEqual(result[0]['feed_ids'], ['new', 'old'])

    def test_classifier(self):
        self.assertEqual(categorize('ヤクルトがプロ野球で注目'), '野球')

    def test_score(self):
        item = {'title': '首相が重要法案について発表', 'category': '政治', 'kind': 'news', 'published_at': '2026-11-15T00:00:00+00:00'}
        self.assertTrue(0 <= score_article(item) <= 100)

    def test_hatena_rss_one_namespace(self):
        xml = b'''<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
        <item rdf:about="https://example.org/hatena"><title>Popular link</title><link>https://example.org/hatena</link><description>Headline metadata</description><dc:date>2026-11-15T00:00:00Z</dc:date></item></rdf:RDF>'''
        items = rss_items(xml, 'Hatena', 'popular_link')
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]['published_at'], '2026-11-15T00:00:00+00:00')
        self.assertEqual(items[0]['url'], 'https://example.org/hatena')

    def test_atom_uses_alternate_link(self):
        xml = b'''<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Atom article</title><link rel="self" href="https://example.org/api"/><link rel="alternate" href="https://example.org/article"/><updated>2026-11-15T00:00:00Z</updated></entry></feed>'''
        self.assertEqual(rss_items(xml, 'Atom', 'news')[0]['url'], 'https://example.org/article')

    def test_trends_do_not_collapse_shared_channel_url(self):
        xml = b'''<rss><channel><item><title>Topic A</title><link>https://trends.google.com/trending/rss?geo=JP</link><pubDate>Sun, 15 Nov 2026 00:00:00 GMT</pubDate></item><item><title>Topic B</title><link>https://trends.google.com/trending/rss?geo=JP</link><pubDate>Sun, 15 Nov 2026 00:00:00 GMT</pubDate></item></channel></rss>'''
        items = rss_items(xml, 'Trends', 'search_trend')
        self.assertNotEqual(items[0]['id'], items[1]['id'])
        self.assertEqual(len(merge_with_previous(items, [], now=datetime(2026, 11, 15, tzinfo=timezone.utc))), 2)
        self.assertEqual(urllib.parse.parse_qs(urllib.parse.urlsplit(items[0]['url']).query)['q'], ['Topic A'])

    def test_tracking_dedup_preserves_different_publishers(self):
        now = datetime(2026, 11, 15, tzinfo=timezone.utc)
        base = dict(title='Same story', kind='news', published_at=now.isoformat(), category='野球')
        articles = [dict(base, id='one', url='https://example.org/story?utm_source=google'), dict(base, id='two', url='https://example.org/story'), dict(base, id='three', url='https://other.org/story')]
        self.assertEqual(len(merge_with_previous(articles, [], now=now)), 2)

    def test_expired_and_future_items_are_removed(self):
        now = datetime(2026, 11, 15, tzinfo=timezone.utc)
        def item(key, dt):
            return dict(id=key, title=key, url='https://example.org/' + key, kind='news', published_at=dt.isoformat())
        items = [item('valid', now), item('expired', now - timedelta(hours=97)), item('future', now + timedelta(hours=3))]
        self.assertEqual([entry['id'] for entry in merge_with_previous(items, [], now=now)], ['valid'])

    def test_category_cap_leaves_room_for_civic_news(self):
        now = datetime(2026, 11, 15, tzinfo=timezone.utc)
        articles = [dict(id=str(i), title='野球ニュース', category='野球', kind='news', url=f'https://example.org/{i}', published_at=now.isoformat()) for i in range(MAX_CATEGORY_ITEMS + 2)]
        articles.append(dict(id='politics', title='政策', category='政治', kind='news', url='https://example.org/politics', published_at=now.isoformat()))
        result = merge_with_previous(articles, [], now=now)
        self.assertEqual(sum(item['category'] == '野球' for item in result), MAX_CATEGORY_ITEMS)
        self.assertIn('politics', [item['id'] for item in result])

    def test_source_health_distinguishes_zero_results_from_errors(self):
        def fetch(url):
            if url == 'forbidden':
                raise urllib.error.HTTPError(url, 403, 'Forbidden', {}, None)
            return RSS if url == 'ok' else b'<rss><channel/></rss>'
        specs = [feed(key, key, key) for key in ['ok', 'empty', 'forbidden']]
        items, errors, health = collect_all(fetch=fetch, feeds=specs, social_searches=[])
        self.assertEqual(len(items), 1)
        self.assertEqual([entry['status'] for entry in health], ['ok', 'empty', 'error'])
        self.assertEqual(errors, ['forbidden: HTTP 403'])
        self.assertEqual(items[0]['feed_ids'], ['ok'])

    def test_requested_publishers_have_dedicated_queries(self):
        urls = {entry['publisher']: urllib.parse.parse_qs(urllib.parse.urlsplit(entry['url']).query)['q'][0]
                for entry in configured_feeds() if entry['publisher']}
        for name, domain in [('スポニチ', 'sponichi.co.jp'), ('サンスポ', 'sanspo.com'), ('デイリー', 'daily.co.jp'), ('スポーツ報知', 'hochi.news')]:
            with self.subTest(publisher=name):
                self.assertIn('site:' + domain, urls[name])

    def test_publisher_is_normalized_from_source_domain(self):
        xml = RSS.replace(b'</item>', b'<source url="https://www.sponichi.co.jp">Sponichi Annex</source></item>')
        item = rss_items(xml, 'Google News', 'news')[0]
        self.assertEqual(item['publisher'], 'スポニチ')

    def test_short_english_keywords_do_not_match_inside_words(self):
        self.assertEqual(categorize('Daily train report'), '話題')
        self.assertEqual(categorize('AI新モデルが登場'), 'AI')

    def test_scores_age_on_each_collection(self):
        now = datetime(2026, 11, 15, tzinfo=timezone.utc)
        item = dict(title='野球ニュース', category='野球', kind='news', published_at=now.isoformat())
        self.assertGreater(score_article(item, now=now), score_article(item, now=now + timedelta(hours=48)))

if __name__ == '__main__':
    unittest.main()
