"""Bundle the Safari helper so installation needs one file and no remote requires."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HEADER = '''// ==UserScript==
// @name         MyNews Private Reader
// @namespace    https://tyr-ui.github.io/mynews-free/
// @version      0.3.0
// @description  MyNews内で公開記事の本文を読み、本文を端末内にだけ保存します。
// @match        https://tyr-ui.github.io/mynews-free/*
// @run-at       document-end
// @inject-into  content
// @noframes
// @grant        GM.xmlHttpRequest
// ==/UserScript==
'''


def build():
    parts = ['site/vendor/readability-0.6.0.js', 'site/reader-core.js', 'src/reader-bridge.js']
    script = HEADER + '\n(function () {\n' + '\n;\n'.join((ROOT / path).read_text() for path in parts) + '\n})();\n'
    (ROOT / 'site/mynews-reader.user.js').write_text(script)


if __name__ == '__main__':
    build()
