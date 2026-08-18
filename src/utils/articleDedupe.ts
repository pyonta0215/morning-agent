import { normalizeUrl } from './deliveredHistory.js';

/**
 * 正規化URLが同じ記事を1件に畳む。
 *
 * 既定では先に現れた記事を残す。取得経路やスコアなどを比較したい呼び出し元は
 * preferCandidate を渡し、後から現れた記事を採用する条件だけを指定する。
 * 採用位置は初出位置のままなので、同点時の順序も決定的になる。
 */
export function dedupeByNormalizedUrl<T extends { url: string }>(
  items: readonly T[],
  preferCandidate: (candidate: T, current: T) => boolean = () => false
): T[] {
  const unique: T[] = [];
  const indexByUrl = new Map<string, number>();

  for (const item of items) {
    const key = normalizeUrl(item.url);
    const existingIndex = indexByUrl.get(key);
    if (existingIndex === undefined) {
      indexByUrl.set(key, unique.length);
      unique.push(item);
      continue;
    }

    if (preferCandidate(item, unique[existingIndex])) {
      unique[existingIndex] = item;
    }
  }

  return unique;
}
