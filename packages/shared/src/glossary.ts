import type { GlossaryEntryType, ReplacementStatus } from './enums';
import type { GlossaryApplyResult, TranscriptReplacement } from './types';

/**
 * 家族词表替换引擎。
 *
 * 设计原则（与项目"音频是证据、文字是结论"的约定一致）：
 * - 只做机械替换，替换结果一律是 pending —— 最终用词必须人工核对；
 * - 原始说法永远保留（transcriptRaw），任何一处替换都能一键还原；
 * - 偏移量相对"原始说法"固定，整理者手工改了成稿文本也不会让记录错位；
 * - 这里是纯函数，服务端落库与前端预览共用同一份规则，两侧永不漂移。
 */

export interface GlossaryEntryLike {
  dialect: string;
  standard: string;
  type?: GlossaryEntryType;
  enabled?: boolean;
}

/** 转义正则元字符，用于把方言原文安全地拼进正则 */
function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 把家族词表套用到一段刚转写出来的文本上。
 *
 * 长词优先：避免"王瓜"抢先匹配掉"老王瓜"这类包含关系；
 * 区间不重叠：已经被更长词条覆盖的字符不再参与匹配。
 */
export function applyGlossary(rawText: string, entries: GlossaryEntryLike[]): GlossaryApplyResult {
  const raw = rawText ?? '';
  const active = entries
    .filter((entry) => entry.enabled !== false)
    .map((entry) => ({ dialect: entry.dialect.trim(), standard: entry.standard }))
    .filter((entry) => entry.dialect.length > 0 && entry.standard.length > 0)
    // 去重：同一方言原文只保留一条（词表层本来就有唯一约束，这里再兜一层）
    .filter((entry, index, all) => all.findIndex((other) => other.dialect === entry.dialect) === index)
    .sort((a, b) => b.dialect.length - a.dialect.length);

  if (!raw || !active.length) {
    return { text: raw, raw, replacements: [] };
  }

  // 一次性构造交替正则；长词排在前面，正则的交替分支按顺序优先
  const pattern = new RegExp(active.map((entry) => escapeRegExp(entry.dialect)).join('|'), 'g');

  const replacements: TranscriptReplacement[] = [];
  const occurrenceByDialect = new Map<string, number>();
  let text = '';
  let cursor = 0;

  for (const match of raw.matchAll(pattern)) {
    const matched = match[0];
    const start = match.index ?? 0;
    const end = start + matched.length;
    const entry = active.find((candidate) => candidate.dialect === matched);
    // 理论上不会发生：匹配到的词一定来自某条词表
    if (!entry) continue;

    text += raw.slice(cursor, start);
    text += entry.standard;
    cursor = end;

    const occurrence = occurrenceByDialect.get(matched) ?? 0;
    occurrenceByDialect.set(matched, occurrence + 1);
    replacements.push({
      entryId: '',
      dialect: matched,
      standard: entry.standard,
      start,
      end,
      occurrence,
      status: 'pending',
    });
  }

  text += raw.slice(cursor);

  return { text, raw, replacements };
}

/**
 * 在一段文本上按替换记录重新扫描每处替换的当前位置，用于 UI 高亮。
 *
 * 服务端存的偏移量相对原始说法固定；但成稿可能被人工编辑过，
 * 所以渲染时不信任旧偏移，而是按记录顺序在当前文本里顺序重新定位。
 * reverted 的记录在成稿里是方言原文，其余是标准说法。
 */
export function locateReplacements(
  text: string,
  replacements: TranscriptReplacement[],
): { replacement: TranscriptReplacement; start: number; end: number }[] {
  const source = text ?? '';
  const located: { replacement: TranscriptReplacement; start: number; end: number }[] = [];
  let cursor = 0;

  for (const replacement of replacements) {
    const needle = replacement.status === 'reverted' ? replacement.dialect : replacement.standard;
    const index = source.indexOf(needle, cursor);
    if (index < 0) {
      // 文本被手工删掉了这处词，跳过它，后续匹配仍从当前游标继续
      continue;
    }
    located.push({ replacement, start: index, end: index + needle.length });
    cursor = index + needle.length;
  }

  return located;
}

export interface ReplacementReview {
  /** 审核后的成稿文本 */
  text: string;
  replacements: TranscriptReplacement[];
}

/**
 * 审核单处替换：
 * - accept：保留标准说法（可从 reverted 重新应用回来）；
 * - revert：把标准说法还原成方言原文；
 * 坐标都相对原始说法，因此即使之前还原过、顺序任意，结果依然精确。
 */
export function reviewReplacement(
  text: string,
  raw: string,
  replacements: TranscriptReplacement[],
  target: { start: number; end: number },
  nextStatus: ReplacementStatus,
): ReplacementReview {
  const record = replacements.find(
    (item) => item.start === target.start && item.end === target.end,
  );
  if (!record) {
    throw new Error('找不到这处替换记录');
  }
  if (record.status === nextStatus) {
    return { text, replacements };
  }

  // 当前这处词在"成稿文本"里是什么形态：还原后是方言，否则是标准说法
  const fromString = record.status === 'reverted' ? record.dialect : record.standard;
  // 目标形态
  const toString = nextStatus === 'reverted' ? record.dialect : record.standard;

  // 用原始偏移判断这处在文本中的先后：目标之前的替换按原始坐标决定是否贡献长度差，
  // 从而把"原始坐标"换算成当前成稿里的真实偏移。
  let delta = 0;
  for (const other of [...replacements].sort((a, b) => a.start - b.start)) {
    if (other.start >= record.start) break;
    // 仍处于替换形态的词，成稿里比原文长出（或短了）一截；已还原的没有差值
    if (other.status !== 'reverted') delta += other.standard.length - other.dialect.length;
  }

  const currentStart = record.start - delta;
  const currentEnd = currentStart + fromString.length;

  if (text.slice(currentStart, currentEnd) !== fromString) {
    // 人工编辑恰好改动了这处词所在的位置，无法安全替换 —— 交给人工处理，不做猜测
    throw new Error('这处词所在的文本已被手工修改，请直接在文本框中调整');
  }

  const nextText = text.slice(0, currentStart) + toString + text.slice(currentEnd);
  const nextReplacements = replacements.map((item) =>
    item === record ? { ...item, status: nextStatus } : item,
  );

  return { text: nextText, replacements: nextReplacements };
}
