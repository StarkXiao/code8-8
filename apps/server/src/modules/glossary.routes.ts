import { Router } from 'express';
import {
  applyGlossary,
  glossaryEntrySchema,
  previewGlossarySchema,
  updateGlossaryEntrySchema,
} from '@froa/shared';
import { prisma } from '../db/client';
import { ApiError, notFound } from '../lib/errors';
import { asyncHandler, created, send } from '../lib/http';
import { newId } from '../lib/ids';
import { requireAuth } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { assertWorkspaceRole } from '../services/access';
import { logActivity } from '../services/activity';
import { toGlossaryEntryDto } from '../services/serialize';

/**
 * 家族词表：收录长辈常用的方言与习惯用词。
 *
 * - 列表：空间成员都能看（转写核对时要用）；
 * - 新增/改：贡献者及以上（录音、整理的家人都在持续补充词表）；
 * - 删除：整理者及以上，与参照物登记保持一致；
 * - 同一方言原文在一个空间只有一条，重复登记走更新（upsert）。
 */
export const glossaryRouter: Router = Router();

glossaryRouter.use(requireAuth);

glossaryRouter.get(
  '/workspaces/:workspaceId/glossary',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params;
    await assertWorkspaceRole(req.auth!.userId, workspaceId!, 'viewer');

    const entries = await prisma.glossaryEntry.findMany({
      where: { workspaceId: workspaceId! },
      orderBy: [{ enabled: 'desc' }, { usageCount: 'desc' }, { createdAt: 'asc' }],
    });
    send(res, entries.map(toGlossaryEntryDto));
  }),
);

/** 套用词表前先预览：不落库，返回替换后的文本和每处命中，供前端高亮确认 */
glossaryRouter.post(
  '/workspaces/:workspaceId/glossary/preview',
  validateBody(previewGlossarySchema),
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params;
    await assertWorkspaceRole(req.auth!.userId, workspaceId!, 'viewer');
    const { text } = req.body as { text: string };

    const entries = await prisma.glossaryEntry.findMany({
      where: { workspaceId: workspaceId!, enabled: true },
      select: { id: true, dialect: true, standard: true },
    });
    const result = applyGlossary(text, entries);
    send(res, {
      text: result.text,
      replacements: result.replacements.map((replacement) => ({
        ...replacement,
        entryId: entries.find((entry) => entry.dialect === replacement.dialect)?.id ?? '',
      })),
      count: result.replacements.length,
    });
  }),
);

glossaryRouter.post(
  '/workspaces/:workspaceId/glossary',
  validateBody(glossaryEntrySchema),
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params;
    await assertWorkspaceRole(req.auth!.userId, workspaceId!, 'contributor');
    const { dialect, standard, type, note, enabled } = req.body as {
      dialect: string;
      standard: string;
      type?: 'dialect' | 'habit';
      note?: string | null;
      enabled?: boolean;
    };

    // 同一方言原文只留一条：重复登记视为更新这条词，而不是再建一条
    const existing = await prisma.glossaryEntry.findUnique({
      where: { workspaceId_dialect: { workspaceId: workspaceId!, dialect } },
    });

    const entry = existing
      ? await prisma.glossaryEntry.update({
          where: { id: existing.id },
          data: {
            standard,
            type: type ?? existing.type,
            note: note ?? null,
            ...(enabled === undefined ? {} : { enabled }),
          },
        })
      : await prisma.glossaryEntry.create({
          data: {
            id: newId(),
            workspaceId: workspaceId!,
            dialect,
            standard,
            type: type ?? 'dialect',
            note: note ?? null,
            enabled: enabled ?? true,
            createdBy: req.auth!.userId,
          },
        });

    await logActivity({
      workspaceId: workspaceId!,
      actorId: req.auth!.userId,
      action: existing ? 'glossary.update' : 'glossary.create',
      entityType: 'glossary_entry',
      entityId: entry.id,
      after: { dialect: entry.dialect, standard: entry.standard },
    });

    // 重复登记走更新，仍然用 200 即可；新建才 201
    if (existing) send(res, toGlossaryEntryDto(entry));
    else created(res, toGlossaryEntryDto(entry));
  }),
);

glossaryRouter.patch(
  '/workspaces/:workspaceId/glossary/:entryId',
  validateBody(updateGlossaryEntrySchema),
  asyncHandler(async (req, res) => {
    const { workspaceId, entryId } = req.params;
    await assertWorkspaceRole(req.auth!.userId, workspaceId!, 'contributor');

    const owned = await prisma.glossaryEntry.findUnique({
      where: { id: entryId! },
      select: { workspaceId: true, dialect: true },
    });
    if (!owned || owned.workspaceId !== workspaceId) throw notFound('词表条目');

    const body = req.body as {
      dialect?: string;
      standard?: string;
      type?: 'dialect' | 'habit';
      note?: string | null;
      enabled?: boolean;
    };

    // 改方言原文时不能撞上本空间已有的另一条
    if (body.dialect && body.dialect !== owned.dialect) {
      const clash = await prisma.glossaryEntry.findUnique({
        where: { workspaceId_dialect: { workspaceId: workspaceId!, dialect: body.dialect } },
        select: { id: true },
      });
      if (clash && clash.id !== entryId) {
        throw new ApiError('EDIT_CONFLICT', '这个原话已经在词表里了');
      }
    }

    const entry = await prisma.glossaryEntry.update({
      where: { id: entryId! },
      data: {
        ...(body.dialect !== undefined ? { dialect: body.dialect } : {}),
        ...(body.standard !== undefined ? { standard: body.standard } : {}),
        ...(body.type !== undefined ? { type: body.type } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.note !== undefined ? { note: body.note } : {}),
      },
    });

    await logActivity({
      workspaceId: workspaceId!,
      actorId: req.auth!.userId,
      action: 'glossary.update',
      entityType: 'glossary_entry',
      entityId: entry.id,
    });

    send(res, toGlossaryEntryDto(entry));
  }),
);

glossaryRouter.delete(
  '/workspaces/:workspaceId/glossary/:entryId',
  asyncHandler(async (req, res) => {
    const { workspaceId, entryId } = req.params;
    await assertWorkspaceRole(req.auth!.userId, workspaceId!, 'editor');

    // 与删参照物同样的防护：确认这条词属于本空间，不能凭 id 删别人家的词
    const owned = await prisma.glossaryEntry.findUnique({
      where: { id: entryId! },
      select: { workspaceId: true },
    });
    if (!owned || owned.workspaceId !== workspaceId) throw notFound('词表条目');

    await prisma.glossaryEntry.delete({ where: { id: entryId! } });

    await logActivity({
      workspaceId: workspaceId!,
      actorId: req.auth!.userId,
      action: 'glossary.delete',
      entityType: 'glossary_entry',
      entityId: entryId!,
    });

    send(res, { removed: entryId });
  }),
);
