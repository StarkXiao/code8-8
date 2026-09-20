import { useParams } from 'react-router-dom';
import { App as AntApp, Button, Form, Input, Popconfirm, Spin, Table, Tag, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { workspaceApi } from '../../api/endpoints';
import { errorMessage } from '../../api/client';

/**
 * 家族词表 —— 收录长辈的方言与习惯用词。
 *
 * 转写（自动 ASR 或人工录入保存）时，"原说法"会被自动替换成"统一用词"；
 * 替换前的原文与替换明细会保留在音频记录里，录音工作台可以对照核对。
 */
export function GlossaryPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const queryClient = useQueryClient();
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<{ term: string; replacement: string; note?: string }>();

  const workspace = useQuery({
    queryKey: ['workspace', workspaceId],
    queryFn: () => workspaceApi.get(workspaceId!),
    enabled: Boolean(workspaceId),
  });

  const glossary = useQuery({
    queryKey: ['glossary', workspaceId],
    queryFn: () => workspaceApi.glossary(workspaceId!),
    enabled: Boolean(workspaceId),
  });

  const addMutation = useMutation({
    mutationFn: (values: { term: string; replacement: string; note?: string }) =>
      workspaceApi.addGlossaryTerm(workspaceId!, values),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['glossary', workspaceId] });
      form.resetFields();
      message.success('词条已收录，之后的转写会自动按它替换');
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const removeMutation = useMutation({
    mutationFn: (termId: string) => workspaceApi.removeGlossaryTerm(workspaceId!, termId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['glossary', workspaceId] });
      message.success('词条已移除');
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  if (glossary.isLoading) {
    return <Spin size="large" />;
  }

  // 与参照物登记同一套权限：贡献者可以收录，删除需要整理者及以上
  const canEdit = workspace.data ? ['owner', 'editor'].includes(workspace.data.role) : false;
  const canAdd = workspace.data ? workspace.data.role !== 'viewer' : false;

  return (
    <div className="froa-stack">
      <div className="froa-page-title">
        <div>
          <h1>家族词表</h1>
          <div className="froa-hint">
            把长辈的方言与习惯用词收录进来。转写时会自动替换成统一用词，
            替换前的原始说法会保留在录音工作台里，供人工核对。
          </div>
        </div>
      </div>

      <div className="froa-card">
        <h3 className="froa-card-title">收录词条</h3>
        <Typography.Paragraph type="secondary">
          例如外婆说"洋柿子"，全家统一写作"番茄"。同一个原说法重复收录会覆盖旧的统一用词。
        </Typography.Paragraph>

        <Form
          form={form}
          layout="inline"
          onFinish={(values) => addMutation.mutate(values)}
          style={{ marginBottom: '1rem', rowGap: 8 }}
        >
          <Form.Item label="原说法" name="term" rules={[{ required: true, message: '必填' }]}>
            <Input placeholder="洋柿子" style={{ width: 160 }} />
          </Form.Item>
          <Form.Item label="统一为" name="replacement" rules={[{ required: true, message: '必填' }]}>
            <Input placeholder="番茄" style={{ width: 160 }} />
          </Form.Item>
          <Form.Item label="备注" name="note">
            <Input placeholder="外婆老家的叫法" style={{ width: 200 }} />
          </Form.Item>
          <Form.Item>
            <Button
              type="primary"
              htmlType="submit"
              icon={<PlusOutlined />}
              loading={addMutation.isPending}
              disabled={!canAdd}
            >
              收录
            </Button>
          </Form.Item>
        </Form>

        <Table
          rowKey="id"
          size="small"
          dataSource={glossary.data ?? []}
          pagination={false}
          locale={{ emptyText: '还没有收录词条。先问问长辈有哪些"只有咱家这么说"的词。' }}
          columns={[
            {
              title: '原说法',
              dataIndex: 'term',
              render: (value: string) => <Tag color="orange">{value}</Tag>,
            },
            {
              title: '统一为',
              dataIndex: 'replacement',
              render: (value: string) => <Tag color="green">{value}</Tag>,
            },
            { title: '备注', dataIndex: 'note' },
            {
              title: '',
              render: (_, record) =>
                canEdit ? (
                  <Popconfirm
                    title="确定移除该词条？"
                    description="移除后新的转写不再自动替换它；已保留的原始说法不受影响。"
                    onConfirm={() => removeMutation.mutate(record.id)}
                    okText="移除"
                    cancelText="取消"
                  >
                    <Button danger type="text" size="small">
                      移除
                    </Button>
                  </Popconfirm>
                ) : null,
            },
          ]}
        />
      </div>
    </div>
  );
}
