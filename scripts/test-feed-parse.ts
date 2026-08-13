/**
 * フィードの判定とパースを検査する。
 *
 * ここが静かに壊れると症状が出にくい。RSSと判定されなかったフィードは
 * HTMLとして雑にタグ剥がしされ、**記事は0件にならずそれっぽい本文がLLMに渡る**ので、
 * 紙面を見ても「そのソースだけ採用実績が無い」としか見えない。
 * 実際 e-Gov のパブリックコメント（RSS 1.0）はこれで丸ごと漏れていた。
 *
 *   npm run test:feed-parse
 */
import { isRss, parseRss } from '../src/tools/webFetchTool.js';

let failed = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) return;
  console.error(`✗ ${label}${detail ? `: ${detail}` : ''}`);
  failed++;
}

// ── isRss: RSS 1.0（RDF）は名前空間宣言が長く、<channel> が先頭200字の外に出る
const RDF_HEAD =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" ' +
  'xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
  'xmlns:content="http://purl.org/rss/1.0/modules/content/" xml:lang="ja">\n';

check('RDFの<channel>が200字を超える位置にある（前提の確認）', RDF_HEAD.length > 200, `${RDF_HEAD.length}字`);
check('RSS 1.0（RDF）をフィードと判定する', isRss(`${RDF_HEAD}<channel rdf:about="x"></channel></rdf:RDF>`));
check('RSS 2.0 を判定する', isRss('<?xml version="1.0"?>\n<rss version="2.0"><channel></channel></rss>'));
check('Atom を判定する', isRss('<feed xmlns="http://www.w3.org/2005/Atom"></feed>'));
check('先頭に空白があっても判定する', isRss('\n\n  <rss version="2.0"></rss>'));

// HTMLの<head>にRSS自動検出リンクがあっても、HTMLはフィードにしない
check(
  'RSS自動検出リンクを持つHTMLはフィードにしない',
  !isRss(
    '<!DOCTYPE html>\n<html><head><link rel="alternate" type="application/rss+xml" href="/feed">' +
      '<title>ニュース</title></head><body></body></html>'
  )
);
check('DOCTYPE無しのHTMLもフィードにしない', !isRss('<html><head><feed></feed></head></html>'));
check('ただのテキストはフィードにしない', isRss('取得に失敗しました') === false);

// ── parseRss: RSS 1.0 は日付が <dc:date>。ここを見ないと全件「日付不明＝最新扱い」になる
const rdf =
  `${RDF_HEAD}<channel rdf:about="https://example.jp/"><title>一覧</title></channel>\n` +
  '<item rdf:about="https://example.jp/new">' +
  '<title>新しい案件</title><link>https://example.jp/new</link>' +
  '<dc:date>2026-08-13T09:01:21+09:00</dc:date>' +
  '<description>意見募集について</description></item>\n' +
  '<item rdf:about="https://example.jp/old">' +
  '<title>古い案件</title><link>https://example.jp/old</link>' +
  '<dc:date>2026-07-01T09:00:00+09:00</dc:date></item>\n' +
  '</rdf:RDF>';

const all = parseRss(rdf);
check('RDFから記事を取り出す', all.metas.length === 2, String(all.metas.length));
check('RDFのURLを取る', all.metas[0]?.url === 'https://example.jp/new', all.metas[0]?.url);
check('dc:date を公開日時として取る', all.metas[0]?.pubDate === '2026-08-13T09:01:21+09:00', all.metas[0]?.pubDate);
check('本文にURL行が入る', all.text.includes('URL: https://example.jp/new'));

// <items><rdf:Seq><rdf:li> は目次であって記事ではない。<item> として拾ってはいけない
const withSeq = parseRss(
  `${RDF_HEAD}<channel rdf:about="x"><items><rdf:Seq>` +
    '<rdf:li rdf:resource="https://example.jp/new" /></rdf:Seq></items></channel>' +
    '<item rdf:about="https://example.jp/new"><title>本体</title>' +
    '<link>https://example.jp/new</link></item></rdf:RDF>'
);
check('rdf:Seq の目次を記事として数えない', withSeq.metas.length === 1, String(withSeq.metas.length));

// dc:date が効いていれば古い記事を切れる
const since = parseRss(rdf, { sinceDate: new Date('2026-08-11T00:00:00+09:00') });
check('dc:date で古い記事を除外する', since.metas.length === 1, String(since.metas.length));
check('残るのは新しいほう', since.metas[0]?.url === 'https://example.jp/new', since.metas[0]?.url);

// 既存の RSS 2.0 / Atom の経路を壊していないこと
const rss2 = parseRss(
  '<rss version="2.0"><channel><item><title>記事A</title>' +
    '<link>https://example.com/a</link><pubDate>Wed, 12 Aug 2026 14:01:59 +0000</pubDate>' +
    '<source url="https://pc.watch.impress.co.jp">PC Watch</source></item></channel></rss>'
);
check('RSS 2.0 の pubDate を取る', rss2.metas[0]?.pubDate === 'Wed, 12 Aug 2026 14:01:59 +0000', rss2.metas[0]?.pubDate);
check('<source url> を取る', rss2.metas[0]?.sourceUrl === 'https://pc.watch.impress.co.jp', rss2.metas[0]?.sourceUrl);
check('<source> の表示名を取る', rss2.metas[0]?.sourceName === 'PC Watch', rss2.metas[0]?.sourceName);

const atom = parseRss(
  '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>記事B</title>' +
    '<link href="https://example.com/b"/><published>2026-08-12T16:14:36Z</published></entry></feed>'
);
check('Atom の link href を取る', atom.metas[0]?.url === 'https://example.com/b', atom.metas[0]?.url);
check('Atom の published を取る', atom.metas[0]?.pubDate === '2026-08-12T16:14:36Z', atom.metas[0]?.pubDate);

// 配信済みURLの除外が引き続き効くこと
const excluded = parseRss(rdf, { excludeUrls: new Set(['https://example.jp/new']) });
check('配信済みURLを除外する', excluded.metas.length === 1, String(excluded.metas.length));

if (failed > 0) {
  console.error(`\n${failed}件 失敗`);
  process.exit(1);
}
console.log('✓ フィード判定（RDF/HTML）とパース（dc:date・source・除外）すべて期待どおり');
