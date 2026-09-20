import { describe, expect, it } from 'vitest';
import { applyGlossary, locateReplacements, reviewReplacement } from '@froa/shared';
import type { TranscriptReplacement } from '@froa/shared';

describe('家族词表替换引擎', () => {
  const entries = [
    { dialect: '洋柿子', standard: '西红柿' },
    { dialect: '大料', standard: '八角' },
    { dialect: '窝锅', standard: '盖上锅盖焖' },
    // 包含关系：长词必须优先，且区间不重叠
    { dialect: '柿子', standard: '柿子（水果）' },
  ];

  it('把方言替换成标准说法，并逐处记录偏移（偏移相对原始说法）', () => {
    const result = applyGlossary('先把洋柿子切块，再放两颗大料', entries);

    expect(result.text).toBe('先把西红柿切块，再放两颗八角');
    expect(result.raw).toBe('先把洋柿子切块，再放两颗大料');
    expect(result.replacements).toHaveLength(2);

    const [first, second] = result.replacements;
    expect(first!.dialect).toBe('洋柿子');
    expect(first!.standard).toBe('西红柿');
    expect(result.raw.slice(first!.start, first!.end)).toBe('洋柿子');
    expect(second!.dialect).toBe('大料');
    expect(second!.occurrence).toBe(0);
  });

  it('长词优先，且已经被长词覆盖的字符不会再被短词命中', () => {
    // "洋柿子"包含"柿子"，只能替换成"西红柿"一次，不能在结果里再冒出"西红柿子（水果）"
    const result = applyGlossary('洋柿子', entries);
    expect(result.text).toBe('西红柿');
    expect(result.replacements).toHaveLength(1);
  });

  it('同一词条出现多次时分别记录 occurrence', () => {
    const result = applyGlossary('大料、大料、还是大料', entries);
    expect(result.text).toBe('八角、八角、还是八角');
    expect(result.replacements.map((r) => r.occurrence)).toEqual([0, 1, 2]);
    expect(result.replacements.every((r) => r.status === 'pending')).toBe(true);
  });

  it('全部替换结果都是待核对，不自动替任何一处下"已确认"的结论', () => {
    const result = applyGlossary('窝锅十分钟', entries);
    expect(result.replacements.every((r) => r.status === 'pending')).toBe(true);
  });

  it('enabled=false 的词条不参与替换；空文本安全返回', () => {
    expect(applyGlossary('洋柿子', [{ dialect: '洋柿子', standard: '西红柿', enabled: false }]).text).toBe(
      '洋柿子',
    );
    expect(applyGlossary('', entries)).toEqual({ text: '', raw: '', replacements: [] });
  });

  it('标准说法比方言长、比方言短两种情况都能正确处理', () => {
    const long = applyGlossary('窝锅', entries);
    expect(long.text).toBe('盖上锅盖焖');

    const short = applyGlossary('放两个大料', [{ dialect: '大料', standard: '茴' }]);
    expect(short.text).toBe('放两个茴');
  });
});

describe('替换核对（确认 / 还原）', () => {
  const entries = [
    { dialect: '洋柿子', standard: '西红柿' },
    { dialect: '大料', standard: '八角' },
  ];

  it('还原：把标准说法精确改回方言原文，即使标准说法长度不同', () => {
    const applied = applyGlossary('洋柿子切块，加大料', entries);
    const [tomato, aniseed] = applied.replacements;

    // 先还原第二处（大料→八角变长了），验证它前面的长度差被正确换算
    const revertedAniseed = reviewReplacement(
      applied.text,
      applied.raw,
      applied.replacements,
      { start: aniseed!.start, end: aniseed!.end },
      'reverted',
    );
    expect(revertedAniseed.text).toBe('西红柿切块，加大料');

    // 再还原第一处，文本应完整回到原文
    const fullyReverted = reviewReplacement(
      revertedAniseed.text,
      applied.raw,
      revertedAniseed.replacements,
      { start: tomato!.start, end: tomato!.end },
      'reverted',
    );
    expect(fullyReverted.text).toBe('洋柿子切块，加大料');
    expect(fullyReverted.replacements.map((r) => r.status)).toEqual(['reverted', 'reverted']);
  });

  it('重新应用：已还原的词可以再改回标准说法', () => {
    const applied = applyGlossary('放两个大料', entries);
    const [record] = applied.replacements;
    const reverted = reviewReplacement(
      applied.text,
      applied.raw,
      applied.replacements,
      { start: record!.start, end: record!.end },
      'reverted',
    );
    expect(reverted.text).toBe('放两个大料');

    const accepted = reviewReplacement(
      reverted.text,
      applied.raw,
      reverted.replacements,
      { start: record!.start, end: record!.end },
      'accepted',
    );
    expect(accepted.text).toBe('放两个八角');
    expect(accepted.replacements[0]!.status).toBe('accepted');
  });

  it('多次出现的同一方言，只还原指定的那一处', () => {
    const applied = applyGlossary('大料、大料', entries);
    const [first, second] = applied.replacements;
    const result = reviewReplacement(
      applied.text,
      applied.raw,
      applied.replacements,
      { start: second!.start, end: second!.end },
      'reverted',
    );
    expect(result.text).toBe('八角、大料');
    expect(result.replacements[0]!.status).toBe('pending');
    expect(result.replacements[1]!.status).toBe('reverted');
  });

  it('locateReplacements 按记录顺序在当前成稿里定位，用于高亮', () => {
    const applied = applyGlossary('洋柿子切块，加大料', entries);
    const located = locateReplacements(applied.text, applied.replacements);
    expect(located).toHaveLength(2);
    expect(applied.text.slice(located[0]!.start, located[0]!.end)).toBe('西红柿');
    expect(applied.text.slice(located[1]!.start, located[1]!.end)).toBe('八角');
  });
});
