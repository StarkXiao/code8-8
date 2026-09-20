import fs from 'node:fs';
import { Router } from 'express';
import {
  audioQuerySchema,
  createClipSchema,
  isAllowedAudioMime,
  reviewReplacement,
  reviewReplacementSchema,
  updateTranscriptSchema,
  uploadAudioFieldsSchema,
  type TranscriptReplacement,
} from '@froa/shared';
import { prisma } from '../db/client';
import { ApiError, notFound } from '../lib/errors';
import { asyncHandler, created, send } from '../lib/http';
import { newId, sha256 } from '../lib/ids';
import { parseJson, stringifyJson } from '../lib/json';
import { logger } from '../lib/logger';
import { requireAuth } from '../middleware/auth';
import { audioUpload, translateUploadError } from '../middleware/upload';
import { queryOf, validateBody, validateQuery } from '../middleware/validate';
import { env } from '../config/env';
import {
  assertAudioRole,
  assertClipRole,
  assertRecipeRole,
  getMembership,
} from '../services/access';
import { logActivity } from '../services/activity';
import { applyWorkspaceGlossary, bumpUsageCounts } from '../services/glossary';
import { buildAudioKey, extensionForMime, storage } from '../services/storage';
import { transcriptionProvider } from '../services/transcription';
import { toAudioDto, toClipDto } from '../services/serialize';
import { emitToWorkspace } from '../realtime/hub';

export const audioRouter: Router = Router();

audioRouter.use(requireAuth);

/* ------------------------------------------------------------------ */
/* 上传                                                                */
/* ------------------------------------------------------------------ */

/**
 * 上传音频。
 *
 * 关键点：
 * - 波形峰值由浏览器端用 Web Audio API 预计算后随表单一起提交，
 *   服务端直接入库，因此不依赖服务端 ffmpeg；
 * - 落盘时计算 SHA-256，之后可用于完整性校验；
 * - 音频只增不删，删除是软删除（保留证据链）。
 */
audioRouter.post(
  '/audio',
  (req, res, next) => {
    audioUpload.single('file')(req, res, (error: unknown) => {
      const translated = translateUploadError(error);
      if (translated) return next(translated);
      if (error) return next(error);
      return next();
    });
  },
  validateBody(uploadAudioFieldsSchema),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new ApiError('VALIDATION_FAILED', '缺少上传文件字段 file');

    const { recipeId, kind, durationMs, peaks } = req.body as {
      recipeId: string;
      kind: string;
      durationMs: number;
      peaks: number[] | null;
    };

    const access = await assertRecipeRole(req.auth!.userId, recipeId, 'contributor');
    if (!isAllowedAudioMime(req.file.mimetype)) {
      throw new ApiError('UPLOAD_TYPE_NOT_ALLOWED', `不支持的音频格式：${req.file.mimetype}`);
    }

    const audioId = newId();
    const key = buildAudioKey(access.workspaceId, audioId, extensionForMime(req.file.mimetype));
    await storage().put(key, req.file.buffer);

    const audio = await prisma.audioAttachment.create({
      data: {
        id: audioId,
        workspaceId: access.workspaceId,
        recipeId,
        ownerId: req.auth!.userId,
        kind,
        storagePath: key,
        mimeType: req.file.mimetype,
        sizeBytes: req.file.size,
        durationMs,
        peaks: peaks ? stringifyJson(peaks) : null,
        sha256: sha256(req.file.buffer),
        transcriptStatus: 'none',
      },
    });

    await logActivity({
      workspaceId: access.workspaceId,
      actorId: req.auth!.userId,
      action: 'audio.upload',
      entityType: 'audio_attachment',
      entityId: audio.id,
      after: { kind, sizeBytes: audio.sizeBytes, durationMs },
    });

    emitToWorkspace(access.workspaceId, 'audio:created', { recipeId, audioId: audio.id, kind });
    created(res, toAudioDto(audio));
  }),
);

/* ------------------------------------------------------------------ */
/* 列表与元数据                                                        */
/* ------------------------------------------------------------------ */

audioRouter.get(
  '/audio',
  validateQuery(audioQuerySchema),
  asyncHandler(async (req, res) => {
    // 一定要用校验后的值：includeDeleted 在 query string 里是字符串，
    // 直接读 req.query 会把 "false" 当成真值
    const { recipeId, kind, transcriptStatus, includeDeleted } = queryOf(req, audioQuerySchema);

    // 没指定食谱时，必须把范围限制在"我参与的空间"内。
    // 否则同一条接口会把所有家庭的音频都吐出来（跨空间泄漏）。
    let scopedWorkspaceIds: string[] | null = null;
    if (recipeId) {
      await assertRecipeRole(req.auth!.userId, recipeId, 'viewer');
    } else {
      const memberships = await prisma.workspaceMember.findMany({
        where: { userId: req.auth!.userId },
        select: { workspaceId: true },
      });
      scopedWorkspaceIds = memberships.map((member) => member.workspaceId);
      if (!scopedWorkspaceIds.length) {
        send(res, []);
        return;
      }
    }

    const audios = await prisma.audioAttachment.findMany({
      where: {
        ...(recipeId
          ? { recipeId }
          : { workspaceId: { in: scopedWorkspaceIds ?? [] } }),
        ...(kind ? { kind } : {}),
        ...(transcriptStatus ? { transcriptStatus } : {}),
        ...(includeDeleted ? {} : { deletedAt: null }),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    send(res, audios.map(toAudioDto));
  }),
);

audioRouter.get(
  '/audio/:audioId',
  asyncHandler(async (req, res) => {
    const { audioId } = req.params;
    await assertAudioRole(req.auth!.userId, audioId!, 'viewer');

    const audio = await prisma.audioAttachment.findUnique({ where: { id: audioId! } });
    if (!audio) throw new ApiError('AUDIO_NOT_FOUND');
    send(res, toAudioDto(audio));
  }),
);

/* ------------------------------------------------------------------ */
/* 流式播放（支持 Range，长音频可拖动定位）                            */
/* ------------------------------------------------------------------ */

audioRouter.get(
  '/audio/:audioId/stream',
  asyncHandler(async (req, res) => {
    const { audioId } = req.params;
    await assertAudioRole(req.auth!.userId, audioId!, 'viewer');

    const audio = await prisma.audioAttachment.findUnique({ where: { id: audioId! } });
    if (!audio) throw new ApiError('AUDIO_NOT_FOUND');

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.type(audio.mimeType);

    const absolute = storage().absolutePath(audio.storagePath);
    if (absolute && fs.existsSync(absolute)) {
      res.sendFile(absolute, (error) => {
        if (error && !res.headersSent) {
          logger.warn({ err: error, audioId }, '音频流发送失败');
          res.status(500).end();
        }
      });
      return;
    }

    // 远端存储回退：整段读入后发送（无 Range 优化）
    try {
      const buffer = await storage().read(audio.storagePath);
      res.send(buffer);
    } catch {
      throw new ApiError('AUDIO_NOT_FOUND', '音频文件已丢失，请从备份恢复');
    }
  }),
);

/* ------------------------------------------------------------------ */
/* 转写                                                                */
/* ------------------------------------------------------------------ */

audioRouter.post(
  '/audio/:audioId/transcribe',
  asyncHandler(async (req, res) => {
    const { audioId } = req.params;
    const access = await assertAudioRole(req.auth!.userId, audioId!, 'contributor');

    const audio = await prisma.audioAttachment.findUnique({ where: { id: audioId! } });
    if (!audio) throw new ApiError('AUDIO_NOT_FOUND');

    await prisma.audioAttachment.update({
      where: { id: audio.id },
      data: { transcriptStatus: 'pending' },
    });

    const provider = transcriptionProvider();
    const absolutePath = storage().absolutePath(audio.storagePath);

    try {
      const result = absolutePath
        ? await provider.transcribe({ path: absolutePath, mimeType: audio.mimeType })
        : { text: '', segments: [], empty: true };

      let transcriptText = result.empty ? audio.transcript : result.text;
      let transcriptRaw = audio.transcriptRaw;
      let replacements: TranscriptReplacement[] = parseJson<TranscriptReplacement[]>(
        audio.replacements,
        [],
      );

      // 转写出稿时自动套用家族词表；原始说法存进 transcriptRaw 供人工核对。
      // manual 驱动（等人工录入）或空结果不套；已经套过词表的不重复套。
      if (!result.empty && result.text && !audio.transcriptRaw) {
        const applied = await applyWorkspaceGlossary(access.workspaceId, result.text);
        transcriptText = applied.text;
        transcriptRaw = applied.raw;
        replacements = applied.replacements;
        if (applied.replacements.length) {
          await bumpUsageCounts(
            access.workspaceId,
            applied.replacements.map((replacement) => replacement.entryId),
          );
        }
      }

      const updated = await prisma.audioAttachment.update({
        where: { id: audio.id },
        data: {
          transcript: transcriptText,
          transcriptRaw,
          replacements: stringifyJson(replacements),
          transcriptStatus: 'done',
        },
      });

      send(res, {
        audio: toAudioDto(updated),
        provider: provider.name,
        segments: result.segments,
        needsManualInput: result.empty,
        replacementCount: replacements.length,
        hint: result.empty
          ? '当前转写驱动为 manual：请在上方文本框中人工录入这段口述'
          : replacements.length
            ? `已自动转写，并用家族词表替换了 ${replacements.length} 处用词，请逐条核对（原始说法已保留）。`
            : undefined,
      });
    } catch (error) {
      await prisma.audioAttachment.update({
        where: { id: audio.id },
        data: { transcriptStatus: 'failed' },
      });
      throw error;
    }
  }),
);

audioRouter.patch(
  '/audio/:audioId/transcript',
  validateBody(updateTranscriptSchema),
  asyncHandler(async (req, res) => {
    const { audioId } = req.params;
    const access = await assertAudioRole(req.auth!.userId, audioId!, 'contributor');

    const { transcript, transcriptStatus, applyGlossary: applyGlossaryNow } = req.body as {
      transcript: string;
      transcriptStatus?: string;
      applyGlossary?: boolean;
    };

    const before = await prisma.audioAttachment.findUnique({ where: { id: audioId! } });
    if (!before) throw new ApiError('AUDIO_NOT_FOUND');

    // 只有"第一次成稿"（还没留过原始说法）时才允许套用词表；
    // 之后每次保存都是人工编辑，绝不重新替换，否则会冲掉核对结果。
    if (applyGlossaryNow && !before.transcriptRaw && transcript.trim()) {
      const applied = await applyWorkspaceGlossary(access.workspaceId, transcript);
      if (applied.replacements.length) {
        await bumpUsageCounts(
          access.workspaceId,
          applied.replacements.map((replacement) => replacement.entryId),
        );
      }
      const updated = await prisma.audioAttachment.update({
        where: { id: audioId! },
        data: {
          transcript: applied.text,
          transcriptRaw: applied.raw,
          replacements: stringifyJson(applied.replacements),
          transcriptStatus: transcriptStatus ?? 'done',
        },
      });
      // 与普通保存保持同一种响应形状：直接返回音频 DTO（替换记录在其 replacements 字段里）
      send(res, toAudioDto(updated));
      return;
    }

    const audio = await prisma.audioAttachment.update({
      where: { id: audioId! },
      data: { transcript, transcriptStatus: transcriptStatus ?? 'done' },
    });
    // 与原约定一致：直接返回音频 DTO
    send(res, toAudioDto(audio));
  }),
);

/**
 * 对一条转写上的某一处词表替换做人工核对：
 * action=revert 还原成方言原文，action=accept 保留/重新应用标准说法。
 * 坐标相对"原始说法"固定，服务端用同一份共享函数精确改写文本，不靠前端传整段。
 */
audioRouter.post(
  '/audio/:audioId/replacements/review',
  validateBody(reviewReplacementSchema),
  asyncHandler(async (req, res) => {
    const { audioId } = req.params;
    await assertAudioRole(req.auth!.userId, audioId!, 'contributor');
    const { start, end, action } = req.body as {
      start: number;
      end: number;
      action: 'accept' | 'revert';
    };

    const audio = await prisma.audioAttachment.findUnique({ where: { id: audioId! } });
    if (!audio) throw new ApiError('AUDIO_NOT_FOUND');
    if (!audio.transcriptRaw) {
      throw new ApiError('VALIDATION_FAILED', '这条转写没有套用词表，没有可核对的替换');
    }

    const replacements = parseJson<TranscriptReplacement[]>(audio.replacements, []);
    try {
      const reviewed = reviewReplacement(
        audio.transcript ?? '',
        audio.transcriptRaw,
        replacements,
        { start, end },
        action === 'revert' ? 'reverted' : 'accepted',
      );

      const updated = await prisma.audioAttachment.update({
        where: { id: audioId! },
        data: {
          transcript: reviewed.text,
          replacements: stringifyJson(reviewed.replacements),
        },
      });
      send(res, toAudioDto(updated));
    } catch (error) {
      throw new ApiError(
        'VALIDATION_FAILED',
        error instanceof Error ? error.message : '无法核对这处替换，请直接在文本框中修改',
      );
    }
  }),
);

/* ------------------------------------------------------------------ */
/* 音频片段                                                            */
/* ------------------------------------------------------------------ */

audioRouter.post(
  '/audio/:audioId/clips',
  validateBody(createClipSchema),
  asyncHandler(async (req, res) => {
    const { audioId } = req.params;
    const access = await assertAudioRole(req.auth!.userId, audioId!, 'contributor');

    const audio = await prisma.audioAttachment.findUnique({ where: { id: audioId! } });
    if (!audio) throw new ApiError('AUDIO_NOT_FOUND');

    const { startMs, endMs, label } = req.body as {
      startMs: number;
      endMs: number;
      label?: string | null;
    };

    if (endMs <= startMs) {
      throw new ApiError('VALIDATION_FAILED', '片段的结束时间必须大于开始时间');
    }
    if (audio.durationMs > 0 && endMs > audio.durationMs + 500) {
      throw new ApiError('VALIDATION_FAILED', '片段超出了音频长度');
    }

    const clip = await prisma.audioClip.create({
      data: {
        id: newId(),
        audioAttachmentId: audio.id,
        startMs,
        endMs,
        label: label ?? null,
        createdBy: req.auth!.userId,
      },
    });

    await logActivity({
      workspaceId: access.workspaceId,
      actorId: req.auth!.userId,
      action: 'audio.clip.create',
      entityType: 'audio_clip',
      entityId: clip.id,
      after: { startMs, endMs, label: clip.label },
    });

    created(res, toClipDto(clip));
  }),
);

audioRouter.get(
  '/clips/:clipId',
  asyncHandler(async (req, res) => {
    const { clipId } = req.params;
    await assertClipRole(req.auth!.userId, clipId!, 'viewer');

    const clip = await prisma.audioClip.findUnique({
      where: { id: clipId! },
      include: { audio: true },
    });
    if (!clip) throw notFound('音频片段');

    send(res, { ...toClipDto(clip), audio: toAudioDto(clip.audio) });
  }),
);

/* ------------------------------------------------------------------ */
/* 软删除                                                              */
/* ------------------------------------------------------------------ */

audioRouter.delete(
  '/audio/:audioId',
  asyncHandler(async (req, res) => {
    const { audioId } = req.params;
    const access = await assertAudioRole(req.auth!.userId, audioId!, 'contributor');
    const membership = await getMembership(req.auth!.userId, access.workspaceId);

    // 录制者本人可删；整理者及以上可删任意音频
    if (access.ownerId !== req.auth!.userId && membership.role === 'contributor') {
      throw new ApiError('AUTH_FORBIDDEN', '只有录制者本人或整理者可以删除该音频');
    }

    await prisma.audioAttachment.update({
      where: { id: audioId! },
      data: { deletedAt: new Date() },
    });

    await logActivity({
      workspaceId: access.workspaceId,
      actorId: req.auth!.userId,
      action: 'audio.softDelete',
      entityType: 'audio_attachment',
      entityId: audioId!,
    });

    send(res, {
      removed: audioId,
      softDeleted: true,
      // 说清楚语义：只是从语音列表里隐藏，文件与证据链都还在
      retainedAsEvidence: true,
      message: '音频已从语音列表移除，但文件仍保留：引用它的结论依然可以回放原声。',
      maxUploadMb: env.maxUploadMb,
    });
  }),
);
