import { useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  App as AntApp,
  Button,
  Form,
  Input,
  Popconfirm,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { ArrowRightOutlined, DeleteOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  GLOSSARY_ENTRY_TYPE_LABELS,
  GLOSSARY_ENTRY_TYPES,
  type GlossaryEntryDto,
  type GlossaryEntryType,
} from '@froa/shared';
import { glossaryApi } from '../../api/endpoints';
import { errorMessage } from '../../api/client';
import { useAuthStore } from '../../store/auth';

/**
 * 家族词表：把长辈嘴里的方言/习惯用词登记成标准说法。
 * 转写成稿时自动替换；每条替换都会保留原始说法，可在录音工作台逐条核对。
 */
export function GlossaryPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const queryClient = useQueryClient();
  const { message } = AntApp.useApp();
  const me = useAuthStore((s) => s.user);
  const [form] = Form.useForm<{
    dialect: string;
    standard: string;
    type: GlossaryEntryType;
    note?: string;
  }>();

  const workspaceEntries = useQuery({
    queryKey: ['glossary', workspaceId],
    queryFn: () => glossaryApi.list(workspaceId!),
    enabled: Boolean(workspaceId),
  });

  // 新增/重复登记（同一原话走更新）
  const upsertMutation = useMutation({
    mutationFn: (values: { dialect: string; standard: string; type: GlossaryEntryType; note?: string }) =>
      glossaryApi.create(workspaceId!, values),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['glossary', workspaceId] });
      form.resetFields();
      message.success(`已收录「${variables.dialect}」→「${variables.standard}」`);
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ entryId, enabled }: { entryId: string; enabled: boolean }) =>
      glossaryApi.update(workspaceId!, entryId, { enabled }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['glossary', workspaceId] });
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const removeMutation = useMutation({
    mutationFn: (entryId: string) => glossaryApi.remove(workspaceId!, entryId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['glossary', workspaceId] });
      message.success('已从词表删除（历史转写保留的原始说法不受影响）');
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  if (workspaceEntries.isLoading) return <Spin size="large" />;

  const entries = workspaceEntries.data ?? [];

  return (
    <div className="froa-stack">
      <div className="froa-page-title">
        <div>
          <h1>家族词表</h1>
          <div className="froa-hint">
            收录长辈常用的方言与习惯用词。转写成稿时会自动替换成标准说法，同时保留原始说法供人工核对 ——
            替换不是改写历史，每一处都能还原。
          </div>
        </div>
      </div>

      <div className="froa-card">
        <h3 className="froa-card-title">收录一个用词</h3>
        <Typography.Paragraph type="secondary">
          例如外婆说的「洋柿子」就是「西红柿」，「大料」就是「八角」。登记后，以后转写里出现这些词会自动换成标准说法，
          并在录音工作台里标出来等你核对。
        </Typography.Paragraph>

        <Form
          form={form}
          layout="inline"
          initialValues={{ type: 'dialect' }}
          onFinish={(values) => upsertMutation.mutate(values)}
          style={{ marginBottom: '1rem', rowGap: 8 }}
        >
          <Form.Item
            label="长辈原话"
            name="dialect"
            rules={[{ required: true, message: '必填' }, { max: 32 }]}
          >
            <Input placeholder="洋柿子" style={{ width: 160 }} />
          </Form.Item>
          <Form.Item
            label="标准说法"
            name="standard"
            rules={[{ required: true, message: '必填' }, { max: 32 }]}
          >
            <Input placeholder="西红柿" style={{ width: 200 }} />
          </Form.Item>
          <Form.Item label="类型" name="type" rules={[{ required: true }]}>
            <Select
              style={{ width: 120 }}
              options={GLOSSARY_ENTRY_TYPES.map((type) => ({
                value: type,
                label: GLOSSARY_ENTRY_TYPE_LABELS[type],
              }))}
            />
          </Form.Item>
          <Form.Item label="备注" name="note">
            <Input placeholder="外婆一直这么叫" style={{ width: 180 }} />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={upsertMutation.isPending}>
              收录
            </Button>
          </Form.Item>
        </Form>

        <Table
          rowKey="id"
          size="small"
          dataSource={entries}
          locale={{ emptyText: '还没有收录任何用词。长辈说的、你一下没听懂的词，都可以先记在这里。' }}
          pagination={false}
          columns={[
            {
              title: '类型',
              dataIndex: 'type',
              width: 90,
              render: (type: GlossaryEntryType) => (
                <Tag color={type === 'dialect' ? 'geekblue' : 'orange'}>
                  {GLOSSARY_ENTRY_TYPE_LABELS[type]}
                </Tag>
              ),
            },
            {
              title: '替换',
              render: (_, record) => (
                <Space>
                  <strong>{record.dialect}</strong>
                  <ArrowRightOutlined style={{ color: '#999' }} />
                  <span>{record.standard}</span>
                </Space>
              ),
            },
            {
              title: '备注',
              dataIndex: 'note',
              width: 200,
              render: (note: string | null) => note ?? <span className="froa-hint">—</span>,
            },
            {
              title: '命中',
              dataIndex: 'usageCount',
              width: 70,
              render: (count: number) =>
                count > 0 ? (
                  <Tooltip title="在转写中被自动替换命中的次数">
                    <Tag>{count} 次</Tag>
                  </Tooltip>
                ) : (
                  <span className="froa-hint">—</span>
                ),
            },
            {
              title: '启用',
              dataIndex: 'enabled',
              width: 70,
              render: (enabled: boolean, record) => (
                <Switch
                  size="small"
                  checked={enabled}
                  onChange={(checked) => toggleMutation.mutate({ entryId: record.id, enabled: checked })}
                />
              ),
            },
            {
              title: '',
              width: 60,
              render: (_, record: GlossaryEntryDto) => (
                <Popconfirm
                  title="删除这条用词？"
                  description="词表删除后不再自动替换；已经转写好的文本和保留的原始说法都不会受影响。"
                  onConfirm={() => removeMutation.mutate(record.id)}
                  okText="删除"
                  cancelText="取消"
                >
                  <Button type="text" size="small" danger icon={<DeleteOutlined />}>
                    删除
                  </Button>
                </Popconfirm>
              ),
            },
          ]}
        />
      </div>

      <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
        当前整理者：{me?.displayName ?? ''}。所有空间成员都能查看词表；贡献者及以上可以收录，整理者及以上可以删除。
      </Typography.Paragraph>
    </div>
  );
}
