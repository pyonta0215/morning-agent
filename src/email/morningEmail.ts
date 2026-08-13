/**
 * 朝刊メールの組み立て。**LLMを呼ばない。**
 *
 * サイトができたので、メールとサイトで同じものを2か所に置く意味が無くなった。
 * メールは「昨日から何が動いたか」だけを伝え、記事の要約は紙面に置く（#11）。
 *
 *   今日の一言      前日に自分が書いたメモ（#13。無い日は出さない）
 *   動いた話題      台帳の差分。新規 / 続報 / 終了
 *   きょうの見出し  その日の全記事の見出しだけ
 *   紙面へのリンク
 *
 * 見出しを残しているのは、紙面を開かない日に取りこぼさないため。
 *
 * 以前あった「今日の注目」（LLMが3件選んでコメントを付ける）は外した。
 * 「動いた話題」がその役割を引き取っており、これで**LLM呼び出しは収集の集約と
 * ストーリー割当の2本で打ち止め**という設計上の性質が実際に守られる。
 */
import type { WebItem } from '../agents/webAgent.js';
import type { MovedStory } from '../utils/storyMetrics.js';
import { formatDateJST, formatIsoJP } from '../utils/date.js';

export interface MorningEmailInput {
  isoDate: string;
  /** 通算の号数（観測日数） */
  issueNumber: number;
  byTopic: Record<string, WebItem[]>;
  /** topic id → 表示名 */
  topicLabel: (topicId: string) => string;
  moved: MovedStory[];
  /** 前日のメモ。無ければ null */
  note: { isoDate: string; body: string } | null;
  paperUrl: string;
}

export interface BuiltEmail {
  subject: string;
  htmlBody: string;
  textBody: string;
}

const KIND_LABEL: Record<MovedStory['kind'], string> = {
  new: '新規',
  continued: '続報',
  ended: '終了',
};

export function buildMorningEmail(input: MorningEmailInput): BuiltEmail {
  const headlines = Object.entries(input.byTopic).flatMap(([topic, items]) =>
    [...items]
      .sort((a, b) => b.score - a.score)
      .map((i) => ({ topic: input.topicLabel(topic), title: i.title, url: i.url }))
  );

  const counts = {
    new: input.moved.filter((m) => m.kind === 'new').length,
    continued: input.moved.filter((m) => m.kind === 'continued').length,
    ended: input.moved.filter((m) => m.kind === 'ended').length,
  };

  // 件名は開かずに中身が分かる形にする。動きが無い日はそう言う
  const subject =
    input.moved.length > 0
      ? `[朝刊エージェント便] ${formatDateJST(new Date(`${input.isoDate}T12:00:00+09:00`))} 新規${counts.new}・続報${counts.continued}・終了${counts.ended}`
      : `[朝刊エージェント便] ${formatDateJST(new Date(`${input.isoDate}T12:00:00+09:00`))} 見出し${headlines.length}件`;

  return {
    subject,
    htmlBody: buildHtml(input, headlines, counts),
    textBody: buildText(input, headlines, counts),
  };
}

type Headline = { topic: string; title: string; url: string };
type Counts = { new: number; continued: number; ended: number };

function buildHtml(input: MorningEmailInput, headlines: Headline[], counts: Counts): string {
  const memo = input.note
    ? `
  <div class="label">今日の一言</div>
  <div class="memo">
    <div class="who">${esc(input.note.isoDate)} 自分のメモ</div>
    ${esc(input.note.body).replace(/\n/g, '<br>')}
  </div>`
    : '';

  const movedRows =
    input.moved.length > 0
      ? input.moved
          .map(
            (m) => `
    <tr>
      <td class="kind k-${m.kind}"><div>${KIND_LABEL[m.kind]}</div></td>
      <td class="body"><strong>${esc(m.story.title)}</strong><span>${esc(m.note)}</span></td>
    </tr>`
          )
          .join('')
      : `<tr><td colspan="2" class="empty">きょうは動きがありませんでした。</td></tr>`;

  const headlineRows = headlines
    .map(
      (h) => `
    <li><span class="tp">${esc(h.topic)}</span><a href="${esc(h.url)}">${esc(h.title)}</a></li>`
    )
    .join('');

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>朝刊エージェント便</title>
<style>
  body { margin:0; padding:0; background:#efece5; }
  .wrap { max-width:620px; margin:0 auto; background:#fbfaf6; padding:22px 24px 26px;
    color:#14110e; font-family:"Hiragino Kaku Gothic ProN","Yu Gothic",sans-serif;
    line-height:1.75; -webkit-text-size-adjust:100%; }
  .masthead { text-align:center; border-bottom:3px double #14110e; padding-bottom:9px; }
  .name { font-family:"Hiragino Mincho ProN","Yu Mincho",serif; font-size:24px; font-weight:700;
    letter-spacing:.28em; text-indent:.28em; line-height:1.3; }
  .sub { font-size:10px; color:#9b948c; letter-spacing:.3em; margin-top:3px; }
  .colophon { font-size:10.5px; color:#55504a; letter-spacing:.08em; padding:5px 2px;
    border-bottom:1px solid #14110e; }
  .colophon .r { float:right; }
  .label { font-family:"Hiragino Mincho ProN","Yu Mincho",serif; font-size:12px; font-weight:700;
    letter-spacing:.3em; border-bottom:1px solid #14110e; padding-bottom:4px; margin:24px 0 11px; }
  .memo { background:#fdfbf0; border:1px solid #e3d9b4; border-left:3px solid #b8912c;
    padding:11px 13px; font-size:14px; font-family:"Hiragino Mincho ProN","Yu Mincho",serif; }
  .memo .who { font-family:"Hiragino Kaku Gothic ProN",sans-serif; font-size:10px; color:#96751f;
    letter-spacing:.1em; font-weight:700; margin-bottom:4px; }
  table.moved { width:100%; border-collapse:collapse; }
  table.moved td { border-bottom:1px solid #d9d4cb; padding:10px 0; vertical-align:top; }
  td.kind { width:46px; font-size:10.5px; font-weight:700; letter-spacing:.1em; text-align:center;
    padding:10px 11px 10px 0 !important; white-space:nowrap; }
  td.kind div { padding:2px 0; }
  .k-new div { background:#a81a12; color:#fff; }
  .k-continued div { background:#fbfaf6; color:#a81a12; border:1px solid #a81a12; }
  .k-ended div { background:#eae7e0; color:#6d675f; border:1px solid #d9d4cb; }
  td.body strong { display:block; font-family:"Hiragino Mincho ProN","Yu Mincho",serif;
    font-size:15px; font-weight:700; line-height:1.5; }
  td.body span { font-size:11px; color:#9b948c; letter-spacing:.04em; }
  td.empty { font-size:12.5px; color:#9b948c; }
  ul.headlines { list-style:none; margin:0; padding:0; }
  ul.headlines li { padding:6px 0; border-bottom:1px dotted #d9d4cb;
    font-family:"Hiragino Mincho ProN","Yu Mincho",serif; font-size:13.5px; line-height:1.55; }
  ul.headlines .tp { font-family:"Hiragino Kaku Gothic ProN",sans-serif; color:#a81a12;
    font-weight:700; font-size:9.5px; letter-spacing:.1em; margin-right:8px; }
  ul.headlines a { color:#14110e; text-decoration:none; border-bottom:1px solid #cdc7bd; }
  .cta { display:block; text-align:center; background:#14110e; color:#ffffff !important;
    text-decoration:none; padding:13px; font-size:13px; font-weight:700; letter-spacing:.1em; margin-top:24px; }
  .foot { text-align:center; font-size:10px; color:#9b948c; margin-top:12px; }
</style>
</head>
<body>
<div class="wrap">
  <div class="masthead">
    <div class="name">朝刊エージェント便</div>
    <div class="sub">MORNING AGENT</div>
  </div>
  <div class="colophon">${esc(formatIsoJP(input.isoDate))}<span class="r">第${input.issueNumber}号</span></div>
${memo}
  <div class="label">動いた話題　<span style="font-family:sans-serif;font-size:10px;letter-spacing:0;color:#9b948c;font-weight:400">新規${counts.new}・続報${counts.continued}・終了${counts.ended}</span></div>
  <table class="moved">${movedRows}
  </table>

  <div class="label">きょうの見出し　<span style="font-family:sans-serif;font-size:10px;letter-spacing:0;color:#9b948c;font-weight:400">${headlines.length}件</span></div>
  <ul class="headlines">${headlineRows || '<li>本日は新規ニュースなし</li>'}
  </ul>

  <a class="cta" href="${esc(input.paperUrl)}">紙面を開く　→</a>
  <div class="foot">要約と本文リンクは紙面にあります</div>
</div>
</body>
</html>`;
}

function buildText(input: MorningEmailInput, headlines: Headline[], counts: Counts): string {
  const lines: string[] = [`朝刊エージェント便　${formatIsoJP(input.isoDate)}　第${input.issueNumber}号`, ''];

  if (input.note) {
    lines.push(`== 今日の一言（${input.note.isoDate}） ==`, input.note.body, '');
  }

  lines.push(`== 動いた話題（新規${counts.new}・続報${counts.continued}・終了${counts.ended}） ==`);
  if (input.moved.length === 0) {
    lines.push('きょうは動きがありませんでした。');
  } else {
    for (const m of input.moved) {
      lines.push(`[${KIND_LABEL[m.kind]}] ${m.story.title}`);
      lines.push(`       ${m.note}`);
    }
  }
  lines.push('');

  lines.push(`== きょうの見出し（${headlines.length}件） ==`);
  if (headlines.length === 0) lines.push('本日は新規ニュースなし');
  for (const h of headlines) {
    lines.push(`・[${h.topic}] ${h.title}`);
    lines.push(`  ${h.url}`);
  }
  lines.push('');

  lines.push('---', `紙面: ${input.paperUrl}`, '要約と本文リンクは紙面にあります');
  return lines.join('\n');
}

function esc(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
