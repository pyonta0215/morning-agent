/**
 * 記事の同一性まわり（#1）。
 *
 * ## IDは `articleId()`（正規化URLのSHA-256先頭16桁）のまま変えない
 *
 * issue #1 は当初「Google News由来は `<guid>` をIDにする」と書いていたが、その後
 * ストーリー台帳（`stories/index.json`）が動きはじめ、**152本のストーリーが
 * 正規化URL由来のIDで記事を参照している**。ID体系を変えると台帳との対応が切れる。
 * 台帳は復元できない資産なので、IDは動かさず `guid` は参照用に併記するだけにする。
 *
 * ## 実URL解決は現時点で動かない（2026-08-13 実測）
 *
 * `news.google.com/_/DotsSplashUi/data/batchexecute` に `Fbv4je`/`garturlreq` を
 * POST する手順は、封筒の形を変えて何通り試してもエラー（`[5]`）が返る。
 * 記事HTML（約590KB）にも実URLは含まれていない。非公式エンドポイントなので壊れたと見る。
 *
 * 代わりに **RSS の `<source url>` と `<source>` の表示名**を使う。実測で 100/100 件に入っており、
 * ドメインだけでなく「PC Watch」のような発行元名まで取れるので、当初案より表示は良くなる。
 * クリック先が Google News 経由のままである点だけが残る不利。
 */
// IDの定義は台帳側に1つだけ置く（2か所にあると必ずずれる）
import { articleId } from './storyLedger.js';

export { articleId };

export function isGoogleNewsUrl(url: string): boolean {
  return /^https?:\/\/news\.google\.com\/rss\/articles\//.test(url);
}

/**
 * Google News の記事URLから `<guid>` を取り出す。
 * `link` から `?oc=5` を落とした部分が `<guid>` と一致するので、URLだけあれば復元できる。
 */
export function googleNewsGuid(url: string): string | undefined {
  return url.match(/\/rss\/articles\/([^?#]+)/)?.[1];
}

export function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

/**
 * Google News の RSS タイトルは末尾に ` - 発行元` が付く。
 * 過去のアーカイブには `<source>` が残っていないので、そこから発行元を拾うのに使う。
 *
 * 見出し自体にハイフンを含むことがあるので**最後の区切りだけ**を見る。
 * 発行元は短いはずなので、長すぎるものは見出しの一部と見なして採らない。
 */
export function publisherFromRssTitle(title: string): string | undefined {
  const i = title.lastIndexOf(' - ');
  if (i < 0) return undefined;
  const tail = title.slice(i + 3).trim();
  if (tail.length === 0 || tail.length > 24) return undefined;
  return tail;
}

/** enriched/<date>-<edition>.json の1件 */
export interface ArticleIdentity {
  /** 台帳と同じキー */
  id: string;
  url: string;
  /** Google News の安定ID。直fetch由来には無い */
  guid?: string;
  /** 記事の公開日時（ISO）。無ければ undefined */
  publishedAt?: string;
  /**
   * publishedAt の由来。`rss` は記事の公開日時そのもの、
   * `delivered` は取れなかったので紙面に載った日で代用したもの。
   * 推測値を実測値と同じ顔で並べないために必ず持たせる
   */
  publishedAtSource?: 'rss' | 'delivered';
  /** 「PC Watch」のような発行元の表示名 */
  sourceName?: string;
  sourceDomain?: string;
  /** 発行元をどこから取ったか。rss=<source>要素 / rss-title=見出し末尾 / url=URLのホスト */
  sourceFrom: 'rss' | 'rss-title' | 'url' | 'unknown';
}

/**
 * 記事1件ぶんの同一性情報を組み立てる。
 *
 * 発行元は `<source>` → 見出し末尾 → URLのホスト の順に落とす。
 * Google News のURLはホストが news.google.com なので、それを発行元として採らない。
 */
export function buildIdentity(args: {
  url: string;
  /** RSS の `<source url>` */
  sourceUrl?: string;
  /** RSS の `<source>` のテキスト */
  sourceName?: string;
  /** RSS の `<pubDate>` */
  pubDate?: string;
  /** RSS の見出し（Google News は末尾に発行元が付く） */
  rssTitle?: string;
  /** publishedAt が取れないときに代用する日付（紙面に載った日） */
  fallbackDate?: string;
}): ArticleIdentity {
  const { url, sourceUrl, pubDate, rssTitle, fallbackDate } = args;

  let sourceName = args.sourceName?.trim() || undefined;
  let sourceDomain = sourceUrl ? hostOf(sourceUrl) : undefined;
  let sourceFrom: ArticleIdentity['sourceFrom'] = 'unknown';

  if (sourceDomain || sourceName) {
    sourceFrom = 'rss';
  } else if (isGoogleNewsUrl(url)) {
    const fromTitle = rssTitle ? publisherFromRssTitle(rssTitle) : undefined;
    if (fromTitle) {
      sourceName = fromTitle;
      // 「blog.google」のようにそのままドメインのこともある
      sourceDomain = /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(fromTitle) ? fromTitle : undefined;
      sourceFrom = 'rss-title';
    }
  } else {
    sourceDomain = hostOf(url);
    sourceName = sourceDomain;
    sourceFrom = sourceDomain ? 'url' : 'unknown';
  }

  const parsed = pubDate ? new Date(pubDate) : null;
  const publishedAt =
    parsed && !Number.isNaN(parsed.getTime())
      ? parsed.toISOString()
      : fallbackDate
        ? new Date(`${fallbackDate}T00:00:00+09:00`).toISOString()
        : undefined;

  return {
    id: articleId(url),
    url,
    guid: googleNewsGuid(url),
    publishedAt,
    publishedAtSource: publishedAt
      ? parsed && !Number.isNaN(parsed.getTime())
        ? 'rss'
        : 'delivered'
      : undefined,
    sourceName,
    sourceDomain,
    sourceFrom,
  };
}
