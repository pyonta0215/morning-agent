/** JST の日付まわり。フェーズを跨いで同じ日付の解釈をするために1か所にまとめる */

/** JST の YYYY-MM-DD */
export function getJSTIsoDate(date: Date): string {
  return date.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

/** JST の日付を YYYY/MM/DD(曜) 形式で返す */
export function formatDateJST(date: Date): string {
  const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
  const iso = getJSTIsoDate(date);
  const [year, month, day] = iso.split('-');
  const jstNoon = new Date(`${iso}T12:00:00+09:00`);
  return `${year}/${month}/${day}(${weekdays[jstNoon.getDay()]})`;
}

/** 2026-08-13 → 2026年8月13日（木） */
export function formatIsoJP(iso: string): string {
  const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
  const w = weekdays[new Date(`${iso}T12:00:00+09:00`).getDay()];
  return `${iso.slice(0, 4)}年${Number(iso.slice(5, 7))}月${Number(iso.slice(8, 10))}日（${w}）`;
}
