/**
 * AI 工作台「用例生成」插件：会话级配置（面板确认后生效，发送时注入）。
 */
import type { CaseOutputFormat, CaseType } from './case-sessions';

/**
 * 需求来源：
 * - doc：需求文档库里的原始文档
 * - stories：需求分析拆出的用户故事（实时读，不落盘）
 */
export type CaseGenReqSource =
  { kind: 'doc'; path: string } | { kind: 'stories'; docId: string; storyIds: string[] };

export interface CaseGenPluginConfig {
  /** 当前会话是否启用（确认后为 true） */
  active: boolean;
  caseType: CaseType;
  outputFormat: CaseOutputFormat;
  /** 需求文档（doc 来源；与 reqSource 同步，兼容旧会话） */
  reqPath?: string;
  /** 需求来源；旧会话只有 reqPath 时按需求文档理解 */
  reqSource?: CaseGenReqSource;
  /** 需求名称提示（文档名 / 分析记录标题） */
  docTitle?: string;
  /** 需求正文或用户故事 Markdown，确认时缓存，发送时直接拼进提示词 */
  reqBlock?: string;
  templateId?: string;
  templateTitle?: string;
  promptPath?: string;
  /** 引用知识库相对路径（knowledge/ 下） */
  knowledgePaths?: string[];
  /** 确认时缓存，发送时不必再读盘 */
  templateHeaders: string[];
  templateBody: string;
  promptBody: string;
  confirmedAt: number;
  /** 本会话最近一次生成入库的用例文件相对路径 */
  linkedCasePath?: string;
}

/** 旧会话兜底：只有 reqPath 时按需求文档来源 */
export function caseGenReqSource(cfg: CaseGenPluginConfig): CaseGenReqSource | undefined {
  if (cfg.reqSource) return cfg.reqSource;
  return cfg.reqPath ? { kind: 'doc', path: cfg.reqPath } : undefined;
}

export function caseGenConfigLabel(cfg: CaseGenPluginConfig): string {
  const parts = [
    cfg.templateTitle || cfg.templateId?.split('/').pop() || '默认模板',
    cfg.outputFormat.toUpperCase(),
  ];
  const source = caseGenReqSource(cfg);
  if (source?.kind === 'stories') {
    parts.push(`${cfg.docTitle || '用户故事'} · ${source.storyIds.length} 条故事`);
  } else if (source?.kind === 'doc') {
    parts.push(source.path.split('/').pop() || source.path);
  }
  return parts.join(' · ');
}
