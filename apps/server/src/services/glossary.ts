import {
  applyGlossary,
  type GlossaryApplyResult,
  type TranscriptReplacement,
} from '@froa/shared';
import { prisma } from '../db/client';

/**
 * 家族词表服务端逻辑。
 *
 * 替换规则本身在共享包（@froa/shared/glossary）里，前端预览、服务端落库是同一份；
 * 这里只负责"从库里取启用词条"和"把替换结果落到转写上"。
 */

/**
 * 把一段刚转写出来的原始文本套用家族词表。
 * 返回的替换记录已补上 entryId，可直接存入 AudioAttachment.replacements。
 */
export async function applyWorkspaceGlossary(
  workspaceId: string,
  rawText: string,
): Promise<GlossaryApplyResult> {
  const entries = await prisma.glossaryEntry.findMany({
    where: { workspaceId, enabled: true },
    select: { id: true, dialect: true, standard: true },
    orderBy: { createdAt: 'asc' },
  });
  const entryIdByDialect = new Map(entries.map((entry) => [entry.dialect, entry.id]));

  const result = applyGlossary(rawText, entries);
  const replacements: TranscriptReplacement[] = result.replacements.map((replacement) => ({
    ...replacement,
    entryId: entryIdByDialect.get(replacement.dialect) ?? '',
  }));

  return { ...result, replacements };
}

/**
 * 一次替换命中后，把相关词条的 usageCount 各 +1（每个词条只计一次，重复出现不重复加）。
 * 用 updateMany + 自增，避免读改写竞争。
 */
export async function bumpUsageCounts(workspaceId: string, entryIds: string[]): Promise<void> {
  const unique = [...new Set(entryIds.filter(Boolean))];
  await Promise.all(
    unique.map((entryId) =>
      prisma.glossaryEntry.updateMany({
        where: { id: entryId, workspaceId },
        data: { usageCount: { increment: 1 } },
      }),
    ),
  );
}
