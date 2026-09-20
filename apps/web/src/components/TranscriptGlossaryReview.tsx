import { useState } from 'react';
import { App as AntApp, Button, Divider, Space, Tag, Typography } from 'antd';
import { ArrowRightOutlined, UndoOutlined, CheckOutlined, EyeOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  REPLACEMENT_STATUS_LABELS,
  type AudioAttachmentDto,
  type TranscriptReplacement,
} from '@froa/shared';
import { audioApi } from '../api/endpoints';
import { errorMessage } from '../api/client';

interface Props {
  audio: AudioAttachmentDto;
  /** 核对后把最新文本同步回父组件的文本框 */
  onReviewed: (audio: AudioAttachmentDto) => void;
}

const STATUS_COLOR: Record<TranscriptReplacement['status'], string> = {
  pending: 'processing',
  accepted: 'success',
  reverted: 'default',
};

/**
 * 家族词表替换核对条。
 *
 * 自动转写/人工成稿后，每处用词替换都会列在这里：
 * - 待核对：文本里是标准说法，可"还原成原话"；
 * - 已还原：文本里保留方言，可"改回标准说法"；
 * - 已确认：人工核对通过。
 * 顶部随时能展开"原始说法"对照 —— 原文永久保留，是核对的依据。
 */
export function TranscriptGlossaryReview({ audio, onReviewed }: Props) {
  const queryClient = useQueryClient();
  const { message } = AntApp.useApp();
  const [showRaw, setShowRaw] = useState(false);

  const reviewMutation = useMutation({
    mutationFn: (variables: { start: number; end: number; action: 'accept' | 'revert' }) =>
      audioApi.reviewReplacement(audio.id, { start: variables.start, end: variables.end }, variables.action),
    onSuccess: (updated) => {
      onReviewed(updated);
      void queryClient.invalidateQueries({ queryKey: ['audio', audio.recipeId] });
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const replacements = audio.replacements ?? [];
  if (!audio.transcriptRaw || replacements.length === 0) return null;

  const pending = replacements.filter((replacement) => replacement.status === 'pending').length;

  return (
    <div className="froa-glossary-review">
      <Divider style={{ margin: '8px 0' }} />
      <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
        <Space>
          <Tag color={pending > 0 ? 'warning' : 'success'}>
            家族词表替换 {replacements.length} 处
          </Tag>
          {pending > 0 ? (
            <Typography.Text type="warning">还有 {pending} 处等你核对</Typography.Text>
          ) : (
            <Typography.Text type="success">已全部核对</Typography.Text>
          )}
        </Space>
        <Button size="small" icon={<EyeOutlined />} onClick={() => setShowRaw((value) => !value)}>
          {showRaw ? '收起原始说法' : '查看原始说法'}
        </Button>
      </Space>

      {showRaw && (
        <Typography.Paragraph
          type="secondary"
          style={{
            marginTop: 8,
            marginBottom: 8,
            padding: '8px 12px',
            background: 'var(--froa-raw-bg, #fafafa)',
            borderRadius: 6,
            whiteSpace: 'pre-wrap',
          }}
        >
          {audio.transcriptRaw}
        </Typography.Paragraph>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
        {replacements.map((replacement) => {
          const key = `${replacement.start}-${replacement.end}`;
          const reverted = replacement.status === 'reverted';
          return (
            <Space key={key} wrap className="froa-glossary-item">
              <Tag color={STATUS_COLOR[replacement.status]}>
                {REPLACEMENT_STATUS_LABELS[replacement.status]}
              </Tag>
              <span style={{ textDecoration: reverted ? 'none' : 'line-through', color: reverted ? undefined : '#999' }}>
                {replacement.dialect}
              </span>
              {!reverted && (
                <>
                  <ArrowRightOutlined style={{ color: '#bbb' }} />
                  <strong>{replacement.standard}</strong>
                </>
              )}
              {reverted ? (
                <Button
                  size="small"
                  icon={<CheckOutlined />}
                  loading={reviewMutation.isPending}
                  onClick={() =>
                    reviewMutation.mutate({ start: replacement.start, end: replacement.end, action: 'accept' })
                  }
                >
                  改回标准说法
                </Button>
              ) : (
                <Button
                  size="small"
                  icon={<UndoOutlined />}
                  loading={reviewMutation.isPending}
                  onClick={() =>
                    reviewMutation.mutate({ start: replacement.start, end: replacement.end, action: 'revert' })
                  }
                >
                  还原成原话
                </Button>
              )}
            </Space>
          );
        })}
      </div>
    </div>
  );
}
