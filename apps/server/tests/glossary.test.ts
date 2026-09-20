/**
 * 家族词表测试 —— 收录长辈的方言/习惯用词，转写时自动替换并保留原始说法。
 *
 * 覆盖：
 * - applyGlossary 的替换语义（全量命中、最长优先、不链式反应）
 * - 词表 CRUD 与权限边界（含跨空间删除拦截）
 * - 保存转写时自动替换、原始说法与替换明细落库、后续人工修订不冲掉原文
 */
import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { applyGlossary } from '@froa/shared';
import { createApp } from '../src/app';
import { prisma } from '../src/db/client';

const app = createApp();

interface Session {
  token: string;
  userId: string;
}

async function register(tag: string): Promise<Session> {
  const email = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@glossary.test`;
  const response = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'froa12345', displayName: tag })
    .expect(201);
  return {
    token: response.body.data.tokens.accessToken as string,
    userId: response.body.data.user.id as string,
  };
}

const auth = (session: Session) => ({ Authorization: `Bearer ${session.token}` });

function fakeWav(): Buffer {
  const sampleRate = 8000;
  const dataSize = sampleRate * 2;
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

afterAll(async () => {
  await prisma.$disconnect();
});

describe('applyGlossary 替换语义', () => {
  it('命中所有出现位置并统计处数', () => {
    const result = applyGlossary('洋柿子切块，洋柿子炒蛋', [
      { term: '洋柿子', replacement: '番茄' },
    ]);
    expect(result.text).toBe('番茄切块，番茄炒蛋');
    expect(result.replacements).toEqual([{ term: '洋柿子', replacement: '番茄', count: 2 }]);
  });

  it('同一位置最长优先："一点点"不会被"一点"拆开', () => {
    const result = applyGlossary('放一点点糖，再放一点盐', [
      { term: '一点', replacement: '少许' },
      { term: '一点点', replacement: '微量' },
    ]);
    expect(result.text).toBe('放微量糖，再放少许盐');
  });

  it('单趟替换：替换出来的新文本不会被再次替换（不链式反应）', () => {
    const result = applyGlossary('洋柿子和西红柿都放点', [
      { term: '洋柿子', replacement: '西红柿' },
      { term: '西红柿', replacement: '番茄' },
    ]);
    // 原文的"洋柿子"只变成"西红柿"，不会被链式替换成"番茄"
    expect(result.text).toBe('西红柿和番茄都放点');
  });

  it('无命中 / 空输入时原样返回', () => {
    expect(applyGlossary('大火收汁', [{ term: '洋柿子', replacement: '番茄' }])).toEqual({
      text: '大火收汁',
      replacements: [],
    });
    expect(applyGlossary('', [{ term: '洋柿子', replacement: '番茄' }])).toEqual({
      text: '',
      replacements: [],
    });
    expect(applyGlossary('洋柿子', [])).toEqual({ text: '洋柿子', replacements: [] });
  });

  it('原说法与统一用词相同的词条会被忽略', () => {
    const result = applyGlossary('放番茄', [{ term: '番茄', replacement: '番茄' }]);
    expect(result.text).toBe('放番茄');
    expect(result.replacements).toEqual([]);
  });
});

describe('家族词表：收录与权限', () => {
  it('收录、列出、重复收录视为更新', async () => {
    const owner = await register('glossary-owner');
    const ws = await request(app)
      .post('/api/workspaces')
      .set(auth(owner))
      .send({ name: '词表测试家' })
      .expect(201);
    const workspaceId = ws.body.data.id as string;

    const created = await request(app)
      .post(`/api/workspaces/${workspaceId}/glossary`)
      .set(auth(owner))
      .send({ term: '洋柿子', replacement: '番茄', note: '外婆老家的叫法' })
      .expect(201);
    expect(created.body.data.term).toBe('洋柿子');
    expect(created.body.data.replacement).toBe('番茄');

    // 同一个原说法重复收录 → 更新统一用词，而不是产生重复词条
    const updated = await request(app)
      .post(`/api/workspaces/${workspaceId}/glossary`)
      .set(auth(owner))
      .send({ term: '洋柿子', replacement: '西红柿' })
      .expect(201);
    expect(updated.body.data.id).toBe(created.body.data.id);
    expect(updated.body.data.replacement).toBe('西红柿');

    const list = await request(app)
      .get(`/api/workspaces/${workspaceId}/glossary`)
      .set(auth(owner))
      .expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].replacement).toBe('西红柿');
  });

  it('原说法与统一用词相同会被拒绝', async () => {
    const owner = await register('glossary-same');
    const ws = await request(app)
      .post('/api/workspaces')
      .set(auth(owner))
      .send({ name: '词表校验家' })
      .expect(201);

    await request(app)
      .post(`/api/workspaces/${ws.body.data.id}/glossary`)
      .set(auth(owner))
      .send({ term: '番茄', replacement: '番茄' })
      .expect(400);
  });

  it('旁观者不能收录，贡献者能收录但不能删除，删除要整理者', async () => {
    const owner = await register('glossary-admin');
    const member = await register('glossary-member');
    const ws = await request(app)
      .post('/api/workspaces')
      .set(auth(owner))
      .send({ name: '词表权限家' })
      .expect(201);
    const workspaceId = ws.body.data.id as string;

    // 邀请加入默认是贡献者
    await request(app)
      .post('/api/workspaces/join')
      .set(auth(member))
      .send({ inviteCode: ws.body.data.inviteCode })
      .expect(201);

    // 贡献者可以收录
    const created = await request(app)
      .post(`/api/workspaces/${workspaceId}/glossary`)
      .set(auth(member))
      .send({ term: '芫荽', replacement: '香菜' })
      .expect(201);
    const termId = created.body.data.id as string;

    // 贡献者不能删除
    await request(app)
      .delete(`/api/workspaces/${workspaceId}/glossary/${termId}`)
      .set(auth(member))
      .expect(403);

    // 降级为旁观者后连收录也不行
    await request(app)
      .patch(`/api/workspaces/${workspaceId}/members/${member.userId}`)
      .set(auth(owner))
      .send({ role: 'viewer' })
      .expect(200);
    await request(app)
      .post(`/api/workspaces/${workspaceId}/glossary`)
      .set(auth(member))
      .send({ term: '瓢羹', replacement: '勺子' })
      .expect(403);
    // 旁观者仍可以查看词表（转写核对要用）
    await request(app).get(`/api/workspaces/${workspaceId}/glossary`).set(auth(member)).expect(200);

    // 整理者（这里用所有者）可以删除
    await request(app)
      .delete(`/api/workspaces/${workspaceId}/glossary/${termId}`)
      .set(auth(owner))
      .expect(200);
    const list = await request(app)
      .get(`/api/workspaces/${workspaceId}/glossary`)
      .set(auth(owner))
      .expect(200);
    expect(list.body.data).toHaveLength(0);
  });

  it('不能凭 id 删掉别的家庭空间的词条', async () => {
    const ownerA = await register('glossary-a');
    const ownerB = await register('glossary-b');
    const wsA = await request(app)
      .post('/api/workspaces')
      .set(auth(ownerA))
      .send({ name: 'A 家' })
      .expect(201);
    const wsB = await request(app)
      .post('/api/workspaces')
      .set(auth(ownerB))
      .send({ name: 'B 家' })
      .expect(201);

    const termB = await request(app)
      .post(`/api/workspaces/${wsB.body.data.id}/glossary`)
      .set(auth(ownerB))
      .send({ term: '地瓜', replacement: '红薯' })
      .expect(201);

    // A 家的整理者拿着 B 家词条的 id，在 A 家空间里发起删除 → 必须 404
    await request(app)
      .delete(`/api/workspaces/${wsA.body.data.id}/glossary/${termB.body.data.id}`)
      .set(auth(ownerA))
      .expect(404);

    // B 家的词条还在
    const list = await request(app)
      .get(`/api/workspaces/${wsB.body.data.id}/glossary`)
      .set(auth(ownerB))
      .expect(200);
    expect(list.body.data).toHaveLength(1);
  });
});

describe('家族词表：转写时自动替换并保留原始说法', () => {
  async function setupRecipeWithGlossary() {
    const owner = await register('glossary-asr');
    const ws = await request(app)
      .post('/api/workspaces')
      .set(auth(owner))
      .send({ name: '转写替换家' })
      .expect(201);
    const workspaceId = ws.body.data.id as string;

    const recipe = await request(app)
      .post('/api/recipes')
      .set(auth(owner))
      .send({ workspaceId, title: '番茄炒蛋' })
      .expect(201);

    const audio = await request(app)
      .post('/api/audio')
      .set(auth(owner))
      .field('recipeId', recipe.body.data.id)
      .field('kind', 'recipe_voice')
      .field('durationMs', '1000')
      .attach('file', fakeWav(), { filename: 'v.wav', contentType: 'audio/wav' })
      .expect(201);

    await request(app)
      .post(`/api/workspaces/${workspaceId}/glossary`)
      .set(auth(owner))
      .send({ term: '洋柿子', replacement: '番茄' })
      .expect(201);
    await request(app)
      .post(`/api/workspaces/${workspaceId}/glossary`)
      .set(auth(owner))
      .send({ term: '瓢羹', replacement: '勺子' })
      .expect(201);

    return { owner, workspaceId, recipeId: recipe.body.data.id as string, audioId: audio.body.data.id as string };
  }

  it('保存转写时自动替换，原始说法与替换明细落库', async () => {
    const { owner, audioId } = await setupRecipeWithGlossary();

    const saved = await request(app)
      .patch(`/api/audio/${audioId}/transcript`)
      .set(auth(owner))
      .send({ transcript: '洋柿子切块，加两瓢羹糖，洋柿子炒到出沙' })
      .expect(200);

    // 正文被规范化
    expect(saved.body.data.audio.transcript).toBe('番茄切块，加两勺子糖，番茄炒到出沙');
    // 原始说法完整保留
    expect(saved.body.data.audio.transcriptRaw).toBe('洋柿子切块，加两瓢羹糖，洋柿子炒到出沙');
    // 替换明细可供人工核对
    expect(saved.body.data.audio.transcriptReplacements).toEqual(
      expect.arrayContaining([
        { term: '洋柿子', replacement: '番茄', count: 2 },
        { term: '瓢羹', replacement: '勺子', count: 1 },
      ]),
    );
    expect(saved.body.data.appliedReplacements).toHaveLength(2);

    // 详情接口也能拿到原始说法（供之后随时核对）
    const detail = await request(app).get(`/api/audio/${audioId}`).set(auth(owner)).expect(200);
    expect(detail.body.data.transcriptRaw).toContain('洋柿子');
  });

  it('之后的人工修订不会冲掉已保存的原始说法', async () => {
    const { owner, audioId } = await setupRecipeWithGlossary();

    await request(app)
      .patch(`/api/audio/${audioId}/transcript`)
      .set(auth(owner))
      .send({ transcript: '洋柿子切块下锅' })
      .expect(200);

    // 对规范化后的文本做人工修订（不再包含原说法）
    const revised = await request(app)
      .patch(`/api/audio/${audioId}/transcript`)
      .set(auth(owner))
      .send({ transcript: '番茄切块下锅，先炒蛋' })
      .expect(200);

    expect(revised.body.data.audio.transcript).toBe('番茄切块下锅，先炒蛋');
    expect(revised.body.data.appliedReplacements).toEqual([]);
    // 原始说法仍然是第一次录入的那句，没有被冲掉
    expect(revised.body.data.audio.transcriptRaw).toBe('洋柿子切块下锅');
  });

  it('词表更新后，新的转写按新词表替换', async () => {
    const { owner, workspaceId, audioId } = await setupRecipeWithGlossary();

    // 全家决定"洋柿子"统一写作"西红柿"而不是"番茄"
    await request(app)
      .post(`/api/workspaces/${workspaceId}/glossary`)
      .set(auth(owner))
      .send({ term: '洋柿子', replacement: '西红柿' })
      .expect(201);

    const saved = await request(app)
      .patch(`/api/audio/${audioId}/transcript`)
      .set(auth(owner))
      .send({ transcript: '洋柿子炖牛腩' })
      .expect(200);

    expect(saved.body.data.audio.transcript).toBe('西红柿炖牛腩');
    expect(saved.body.data.audio.transcriptRaw).toBe('洋柿子炖牛腩');
  });

  it('manual 驱动下重新转写不会动已有人工转写', async () => {
    const { owner, audioId } = await setupRecipeWithGlossary();

    await request(app)
      .patch(`/api/audio/${audioId}/transcript`)
      .set(auth(owner))
      .send({ transcript: '洋柿子切块' })
      .expect(200);

    const result = await request(app)
      .post(`/api/audio/${audioId}/transcribe`)
      .set(auth(owner))
      .expect(200);

    expect(result.body.data.needsManualInput).toBe(true);
    expect(result.body.data.appliedReplacements).toEqual([]);
    expect(result.body.data.audio.transcript).toBe('番茄切块');
    expect(result.body.data.audio.transcriptRaw).toBe('洋柿子切块');
  });

  it('词表是空间级的：别的家庭空间的词不会替换到我的转写里', async () => {
    const { owner, audioId } = await setupRecipeWithGlossary();
    const outsider = await register('glossary-outsider');
    const wsB = await request(app)
      .post('/api/workspaces')
      .set(auth(outsider))
      .send({ name: '别人家' })
      .expect(201);
    await request(app)
      .post(`/api/workspaces/${wsB.body.data.id}/glossary`)
      .set(auth(outsider))
      .send({ term: '切块', replacement: '切丁' })
      .expect(201);

    const saved = await request(app)
      .patch(`/api/audio/${audioId}/transcript`)
      .set(auth(owner))
      .send({ transcript: '洋柿子切块' })
      .expect(200);

    // 只有本空间的"洋柿子→番茄"生效，别人家的"切块→切丁"不生效
    expect(saved.body.data.audio.transcript).toBe('番茄切块');
  });
});
