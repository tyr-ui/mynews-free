"""Free headline discovery feeds. No article-body scraping or paid APIs."""
import urllib.parse

RSS_JP = 'https://news.google.com/rss'

# A publisher-specific search is discovery through Google News, not a full archive.
BASEBALL_MEDIA = [
    ('sponichi', 'スポニチ', 'sponichi.co.jp', 'site:sponichi.co.jp/baseball/'),
    ('sanspo', 'サンスポ', 'sanspo.com', 'site:sanspo.com (野球 OR ヤクルト OR MLB)'),
    ('daily', 'デイリー', 'daily.co.jp', 'site:daily.co.jp (野球 OR 阪神 OR ヤクルト OR MLB)'),
    ('hochi', 'スポーツ報知', 'hochi.news', 'site:hochi.news (野球 OR 巨人 OR ヤクルト OR MLB)'),
    ('nikkan', '日刊スポーツ', 'nikkansports.com', '(site:nikkansports.com/baseball/ OR site:nikkansports.com/mlb/)'),
    ('sankei', '産経新聞', 'sankei.com', 'site:sankei.com (野球 OR ヤクルト OR MLB)'),
    ('fullcount', 'Full-Count', 'full-count.jp', 'site:full-count.jp'),
    ('baseballking', 'BASEBALL KING', 'baseballking.jp', 'site:baseballking.jp'),
]

# OR is intentional: the old space-separated lists excluded too many headlines.
NEWS_SEARCHES = [
    ('yakult', '野球', 'ヤクルト OR スワローズ'),
    ('npb', '野球', 'プロ野球 OR NPB'),
    ('mlb', '野球', 'MLB OR メジャーリーグ'),
    ('manga-buzz', '漫画', '(漫画 OR アニメ) (SNS OR 話題 OR 考察 OR 炎上) -最新話 -連載開始'),
    ('security', 'IT', 'サイバー攻撃 OR 脆弱性 OR 情報漏えい'),
    ('infrastructure', 'IT', '(クラウド OR ネットワーク OR Linux) (技術 OR 障害)'),
    ('generative-ai', 'AI', '生成AI OR ChatGPT OR Claude OR Gemini'),
    ('ai-services', 'AI', '(人工知能 OR AI) (新モデル OR 新サービス OR 技術)'),
    ('politics', '政治', '政治 OR 国会 OR 選挙 OR 政策'),
    ('economy', '経済', '物価 OR 税制 OR 賃金 OR 日銀 OR 為替'),
    ('world', '国際', '国際情勢 OR 外交 OR 紛争'),
    ('society', '社会', '社会 OR 法改正 OR 事件'),
    ('disaster', '社会', '地震 OR 台風 OR 警報 OR 防災'),
]

BSKY_SEARCHES = [
    ('野球', 'ヤクルト'), ('野球', 'プロ野球'), ('野球', 'MLB'),
    ('漫画', '漫画'), ('漫画', 'アニメ'), ('IT', 'セキュリティ'),
    ('AI', '生成AI'), ('政治', '政治'), ('社会', 'ニュース'),
]


def news_search_url(query):
    return RSS_JP + '/search?' + urllib.parse.urlencode({
        'q': query + ' when:3d', 'hl': 'ja', 'gl': 'JP', 'ceid': 'JP:ja',
    })


def feed(key, name, url, category=None, kind='news', limit=60, publisher=None):
    return dict(id=key, name=name, url=url, category=category, kind=kind,
                limit=limit, publisher=publisher)


def configured_feeds():
    result = [
        feed('trends', 'Google Trends（日本）', 'https://trends.google.com/trending/rss?geo=JP', kind='search_trend', limit=40),
        feed('hatena', 'はてな人気エントリー', 'https://b.hatena.ne.jp/hotentry.rss', kind='popular_link', limit=60),
        feed('headlines', 'Google News 国内主要', RSS_JP + '?hl=ja&gl=JP&ceid=JP:ja', limit=70),
    ]
    result += [feed(key, f'Google News / {category} / {key}', news_search_url(query), category)
               for key, category, query in NEWS_SEARCHES]
    result += [feed('media-' + key, name + ' / 野球', news_search_url(query), '野球', limit=80, publisher=name)
               for key, name, domain, query in BASEBALL_MEDIA]
    return result
