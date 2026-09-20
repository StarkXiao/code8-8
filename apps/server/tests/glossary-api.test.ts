/**
 * 家族词表集成测试。
 *
 * 覆盖：
 *   收录词条（含重复原话走更新）→ 权限边界 → 人工录入转写套用词表
 *   → 原始说法保留 → 逐处核对（还原 / 改回）→ 词表删除不影响历史转写
 *   → 跨空间越权读写被拒
 *
 * 转写驱动固定为 manual（见 vitest.config.ts），所以走"人工录入 + applyGlossary"这条路径。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { prisma } from '../src/db/client';

const app = createApp();

interface Session {
  token: string;
  userId: string;
}

async function register(email: string, displayName: string): Promise<Session> {
  const response = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'froa12345', displayName })
    .expect(201);
  return {
    token: response.body.data.tokens.accessToken as string,
    userId: response.body.data.user.id as string,
  };
}

const auth = (session: Session) => ({ Authorization: `Bearer ${session.token}` });

function fakeWav(seconds = 1): Buffer {
  const sampleRate = 8000;
  const samples = sampleRate * seconds;
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

describe('家族词表：收录方言 → 转写自动替换 → 人工核对还原', () => {
  let organizer: Session;
  let contributor: Session;
  let outsider: Session;
  let workspaceId = '';
  let otherWorkspaceId = '';
  let recipeId = '';
  let audioId = '';

  beforeAll(async () => {
    organizer = await register(`gl-owner-${Date.now()}@gl.test`, '整理者');
    contributor = await register(`gl-elder-${Date.now()}@gl.test`, '外婆');
    outsider = await register(`gl-out-${Date.now()}@gl.test`, '外人');
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const listEntries = async (session: Session = organizer) => {
    const response = await request(app)
      .get(`/api/workspaces/${workspaceId}/glossary`)
      .set(auth(session))
      .expect(200);
    return response.body.data as {
      id: string;
      dialect: string;
      standard: string;
      type: string;
      usageCount: number;
    }[];
  };

  it('1. 建空间、邀外婆加入、建食谱', async () => {
    const ws = await request(app)
      .post('/api/workspaces')
      .set(auth(organizer))
      .send({ name: '词表测试厨房' })
      .expect(201);
    workspaceId = ws.body.data.id;

    const other = await request(app)
      .post('/api/workspaces')
      .set(auth(outsider))
      .send({ name: '别人家厨房' })
      .expect(201);
    otherWorkspaceId = other.body.data.id;

    await request(app)
      .post('/api/workspaces/join')
      .set(auth(contributor))
      .send({ inviteCode: ws.body.data.inviteCode })
      .expect(201);

    const recipe = await request(app)
      .post('/api/recipes')
      .set(auth(organizer))
      .send({ workspaceId, title: '词表红烧肉' })
      .expect(201);
    recipeId = recipe.body.data.id;
  });

  it('2. 收录方言词：洋柿子→西红柿、大料→八角（贡献者可收录）', async () => {
    const first = await request(app)
      .post(`/api/workspaces/${workspaceId}/glossary`)
      .set(auth(contributor))
      .send({ dialect: '洋柿子', standard: '西红柿', type: 'dialect' })
      .expect(201);
    expect(first.body.data.enabled).toBe(true);
    expect(first.body.data.usageCount).toBe(0);

    await request(app)
      .post(`/api/workspaces/${workspaceId}/glossary`)
      .set(auth(contributor))
      .send({ dialect: '大料', standard: '八角', type: 'habit' })
      .expect(201);

    const entries = await listEntries();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.dialect).sort()).toEqual(['大料', '洋柿子']);
  });

  it('3. 重复登记同一句原话走更新，而不是建第二条', async () => {
    const response = await request(app)
      .post(`/api/workspaces/${workspaceId}/glossary`)
      .set(auth(organizer))
      .send({ dialect: '洋柿子', standard: '番茄', type: 'dialect' })
      .expect(200);
    expect(response.body.data.standard).toBe('番茄');

    const entries = await listEntries();
    expect(entries).toHaveLength(2);

    // 改回西红柿，方便后续断言
    const tomato = entries.find((e) => e.dialect === '洋柿子')!;
    await request(app)
      .patch(`/api/workspaces/${workspaceId}/glossary/${tomato.id}`)
      .set(auth(organizer))
      .send({ standard: '西红柿' })
      .expect(200);
  });

  it('4. 原话和标准说法一样会被拒绝', async () => {
    await request(app)
      .post(`/api/workspaces/${workspaceId}/glossary`)
      .set(auth(organizer))
      .send({ dialect: '食盐', standard: '食盐' })
      .expect(400);
  });

  it('5. 预览接口不落库就能看到替换结果，也不增加命中计数', async () => {
    const response = await request(app)
      .post(`/api/workspaces/${workspaceId}/glossary/preview`)
      .set(auth(contributor))
      .send({ text: '洋柿子炒大料' })
      .expect(200);
    expect(response.body.data.text).toBe('西红柿炒八角');
    expect(response.body.data.count).toBe(2);

    const entries = await listEntries();
    expect(entries.every((e) => e.usageCount === 0)).toBe(true);
  });

  it('6. 非空间成员不能看、不能收录词表', async () => {
    await request(app)
      .get(`/api/workspaces/${workspaceId}/glossary`)
      .set(auth(outsider))
      .expect(403);
    await request(app)
      .post(`/api/workspaces/${workspaceId}/glossary`)
      .set(auth(outsider))
      .send({ dialect: 'x', standard: 'y' })
      .expect(403);
  });

  it('7. 上传音频并人工录入转写，保存时套用词表', async () => {
    const uploaded = await request(app)
      .post('/api/audio')
      .set(auth(contributor))
      .field('recipeId', recipeId)
      .field('kind', 'recipe_voice')
      .field('durationMs', '2000')
      .field('peaks', JSON.stringify([0.2, 0.8]))
      .attach('file', fakeWav(), { filename: 'voice.wav', contentType: 'audio/wav' })
      .expect(201);
    audioId = uploaded.body.data.id;

    const rawDialect = '先把洋柿子切块，放两颗大料，再切点洋柿子';
    const saved = await request(app)
      .patch(`/api/audio/${audioId}/transcript`)
      .set(auth(contributor))
      .send({ transcript: rawDialect, applyGlossary: true })
      .expect(200);

    // 成稿是标准说法
    expect(saved.body.data.transcript).toBe('先把西红柿切块，放两颗八角，再切点西红柿');
    // 原始说法原样保留
    expect(saved.body.data.transcriptRaw).toBe(rawDialect);
    // 三处替换，全部待核对
    const replacements = saved.body.data.replacements as {
      dialect: string;
      status: string;
      occurrence: number;
    }[];
    expect(replacements).toHaveLength(3);
    expect(replacements.every((r) => r.status === 'pending')).toBe(true);
    expect(replacements.filter((r) => r.dialect === '洋柿子').map((r) => r.occurrence)).toEqual([0, 1]);
  });

  it('8. 词条命中计数 +1（同词多次出现只算一次）', async () => {
    const entries = await listEntries();
    for (const entry of entries) {
      expect(entry.usageCount).toBe(1);
    }
  });

  it('9. 第二次保存是人工编辑，不会重复替换、不会冲掉核对结果', async () => {
    // 先还原"大料"那处
    let audio = await request(app).get(`/api/audio/${audioId}`).set(auth(contributor)).expect(200);
    const aniseed = (
      audio.body.data.replacements as { dialect: string; start: number; end: number }[]
    ).find((r) => r.dialect === '大料')!;

    await request(app)
      .post(`/api/audio/${audioId}/replacements/review`)
      .set(auth(contributor))
      .send({ start: aniseed.start, end: aniseed.end, action: 'revert' })
      .expect(200);

    // 普通保存（不带 applyGlossary）：即便文本里含方言，也不会被再替换
    const edited = await request(app)
      .patch(`/api/audio/${audioId}/transcript`)
      .set(auth(contributor))
      .send({ transcript: '先把西红柿切块，放两颗大料，再切点西红柿。' })
      .expect(200);
    expect(edited.body.data.transcript).toContain('大料');
    expect(edited.body.data.transcriptRaw).not.toBeNull();

    // 还原状态依然保留，没有被普通保存冲掉
    audio = await request(app).get(`/api/audio/${audioId}`).set(auth(contributor)).expect(200);
    const still = (audio.body.data.replacements as { dialect: string; status: string }[]).find(
      (r) => r.dialect === '大料',
    )!;
    expect(still.status).toBe('reverted');
  });

  it('10. 已还原的词可以改回标准说法', async () => {
    const audio = await request(app).get(`/api/audio/${audioId}`).set(auth(contributor)).expect(200);
    const aniseed = (
      audio.body.data.replacements as { dialect: string; start: number; end: number; status: string }[]
    ).find((r) => r.dialect === '大料')!;
    expect(aniseed.status).toBe('reverted');

    const reviewed = await request(app)
      .post(`/api/audio/${audioId}/replacements/review`)
      .set(auth(contributor))
      .send({ start: aniseed.start, end: aniseed.end, action: 'accept' })
      .expect(200);
    expect(reviewed.body.data.transcript).toContain('八角');
    expect(reviewed.body.data.transcript).not.toContain('放两颗大料');
    const updatedRecord = (
      reviewed.body.data.replacements as { dialect: string; status: string }[]
    ).find((r) => r.dialect === '大料')!;
    expect(updatedRecord.status).toBe('accepted');
  });

  it('11. 不能凭 id 操作别人家空间词表里的词；贡献者不能删词', async () => {
    const foreign = await request(app)
      .post(`/api/workspaces/${otherWorkspaceId}/glossary`)
      .set(auth(outsider))
      .send({ dialect: '方言', standard: '普通话' })
      .expect(201);
    const foreignId = foreign.body.data.id as string;

    // 路径里的 workspaceId 与词条不属于同一空间 → 404
    await request(app)
      .delete(`/api/workspaces/${workspaceId}/glossary/${foreignId}`)
      .set(auth(organizer))
      .expect(404);

    // 贡献者（外婆）不能删词，需要整理者及以上
    const entries = await listEntries();
    const ownTomato = entries.find((e) => e.dialect === '洋柿子')!;
    await request(app)
      .delete(`/api/workspaces/${workspaceId}/glossary/${ownTomato.id}`)
      .set(auth(contributor))
      .expect(403);
  });

  it('12. 整理者删除词条后，历史转写与保留的原始说法都不受影响', async () => {
    const before = await request(app).get(`/api/audio/${audioId}`).set(auth(organizer)).expect(200);
    expect(before.body.data.transcriptRaw).toContain('洋柿子');

    const entries = await listEntries();
    const tomato = entries.find((e) => e.dialect === '洋柿子')!;
    await request(app)
      .delete(`/api/workspaces/${workspaceId}/glossary/${tomato.id}`)
      .set(auth(organizer))
      .expect(200);

    const after = await request(app).get(`/api/audio/${audioId}`).set(auth(organizer)).expect(200);
    expect(after.body.data.transcriptRaw).toContain('洋柿子');
    // 替换记录仍在（仍可核对），只是词表里不再有这条
    expect(
      (after.body.data.replacements as { dialect: string }[]).some((r) => r.dialect === '洋柿子'),
    ).toBe(true);
  });
});
