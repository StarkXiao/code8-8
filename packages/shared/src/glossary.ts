/**
 * 家族词表：长辈的方言与习惯用词 → 全家统一用词。
 *
 * 转写（自动 ASR 或人工录入保存）时按词表自动替换；
 * 替换前的原文与命中明细会单独保留在音频记录上，供人工核对。
 * 本函数同时被服务端与前端引用，替换规则只有这一处实现。
 */

export interface GlossaryTermLike {
  /** 长辈的原说法，例如"洋柿子" */
  term: string;
  /** 统一后的用词，例如"番茄" */
  replacement: string;
}

export interface GlossaryReplacement {
  term: string;
  replacement: string;
  /** 本次文本里被替换掉的处数 */
  count: number;
}

export interface GlossaryApplyResult {
  /** 替换后的文本 */
  text: string;
  /** 命中明细：哪些词被换成了什么、各几处（供人工核对） */
  replacements: GlossaryReplacement[];
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 把文本里出现的词表原说法替换成统一用词。
 *
 * 语义约定：
 * - 单趟替换：只扫描原文，替换出来的新文本不会被再次替换
 *   （"洋柿子→西红柿、西红柿→番茄"不会链式反应，只命中原文里真正出现的说法）；
 * - 同一位置最长优先："一点点"先于"一点"命中，不会被拆成两半；
 * - 命中所有出现位置，并统计每条的替换处数。
 */
export function applyGlossary(text: string, terms: GlossaryTermLike[]): GlossaryApplyResult {
  if (!text) return { text, replacements: [] };

  // 同一原说法只保留第一条（数据库已按空间唯一约束，这里是防御性去重）
  const usable: GlossaryTermLike[] = [];
  const seen = new Set<string>();
  for (const item of terms) {
    const term = item.term?.trim();
    const replacement = item.replacement?.trim();
    if (!term || !replacement || term === replacement || seen.has(term)) continue;
    seen.add(term);
    usable.push({ term, replacement });
  }
  if (!usable.length) return { text, replacements: [] };

  // 交替匹配时排在前面的分支优先命中，因此按长度降序排列即"同一位置最长优先"
  usable.sort((a, b) => b.term.length - a.term.length);
  const pattern = new RegExp(usable.map((item) => escapeRegExp(item.term)).join('|'), 'g');
  const replacementByTerm = new Map(usable.map((item) => [item.term, item.replacement]));

  const counts = new Map<string, number>();
  const replaced = text.replace(pattern, (matched) => {
    counts.set(matched, (counts.get(matched) ?? 0) + 1);
    return replacementByTerm.get(matched) ?? matched;
  });

  const replacements: GlossaryReplacement[] = usable
    .filter((item) => counts.has(item.term))
    .map((item) => ({ term: item.term, replacement: item.replacement, count: counts.get(item.term) ?? 0 }));

  return { text: replaced, replacements };
}
