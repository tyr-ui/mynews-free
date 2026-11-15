import unittest
import sys
from pathlib import Path
from datetime import datetime, timezone
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.collect import rss_items, bsky_items, merge_with_previous, score_article, categorize

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
        result = merge_with_previous([dict(base, score=67)], [base], now=now)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]['score'], 67)

    def test_classifier(self):
        self.assertEqual(categorize('ヤクルトがプロ野球で注目'), '野球')

    def test_score(self):
        item = {'title': '首相が重要法案について発表', 'category': '政治', 'kind': 'news', 'published_at': '2026-11-15T00:00:00+00:00'}
        self.assertTrue(0 <= score_article(item) <= 100)

if __name__ == '__main__':
    unittest.main()
