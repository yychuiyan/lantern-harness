import { memo } from 'react';
import { renderMarkdown } from '../../lib/markdown-client';

/**
 * 单条消息的 Markdown 渲染。
 *
 * 用 memo 包住是关键：流式时只有最后一条的 content 变，历史消息的 content
 * 字符串不变，React 会直接跳过整个子树的重渲染 —— 连 marked 解析都不会跑。
 * 不用 memo 时每次 token 都要把整榜历史消息重新解析一遍，主线程被吃满，
 * 表现就是「卡一阵、再一大坨文字跳出来」。
 */
export const MarkdownBody = memo(function MarkdownBody({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return <div className={className} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
});
