/**
 * XMind Zen 格式打包：content.json + metadata + manifest → .xmind（zip）。
 * 测试点 / 需求原文导出共用，避免两处复制 JSZip 样板与视觉样式。
 */
import { APP_VERSION } from './app-version';

/** 向右逻辑图（根在左、分支向右） */
export const XMIND_LOGIC_RIGHT = 'org.xmind.ui.logic.right';

const XMIND_SHAPE_ROUNDED = 'org.xmind.topicShape.roundedRect';
/** 逻辑图骨架折线：竖脊 + 横线接到各子项 */
export const XMIND_LINE_ELBOW = 'org.xmind.branchConnection.elbow';
const XMIND_LINE = '#94a3b8';
const XMIND_BORDER = '#d0d5dd';
export const XMIND_INK = '#1c3d5a';

/** 整本 workbook 内节点 id 唯一；中文 key 靠 hash，避免撞成同一个 dim-* */
export function xmindTopicId(prefix: string, key: string): string {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const h = (hash >>> 0).toString(36);
  const clean = key.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
  return clean ? `${prefix}-${clean}-${h}` : `${prefix}-${h}`;
}

/** 圆角矩形 + 折线连线（与原文结构 / 测试点导出同一套） */
export function xmindTopicStyle(
  fill: string,
  color: string,
): { id: string; properties: Record<string, string> } {
  return {
    id: xmindTopicId('st', `${XMIND_SHAPE_ROUNDED}-${fill}-${color}`),
    properties: {
      'shape-class': XMIND_SHAPE_ROUNDED,
      'line-class': XMIND_LINE_ELBOW,
      'line-color': XMIND_LINE,
      'line-width': '1',
      'svg:fill': fill,
      'fo:color': color,
      'border-line-color': XMIND_BORDER,
      'border-line-width': '1',
    },
  };
}

export const XMIND_STYLE_ROOT = xmindTopicStyle('#1c3d5a', '#ffffff');
export const XMIND_STYLE_GROUP = xmindTopicStyle('#3370ff', '#ffffff');
export const XMIND_STYLE_TOPIC = xmindTopicStyle('#ffffff', XMIND_INK);

/** 向右逻辑图主题：中心深蓝、一级蓝、更深层级白底不强制边框 */
export function xmindLogicTheme(): Record<string, unknown> {
  const level = (fill: string, color: string) => ({
    properties: {
      'shape-class': XMIND_SHAPE_ROUNDED,
      'line-class': XMIND_LINE_ELBOW,
      'line-color': XMIND_LINE,
      'line-width': '1',
      'svg:fill': fill,
      'fo:color': color,
      'border-line-color': XMIND_BORDER,
      'border-line-width': '1',
    },
  });
  return {
    centralTopic: level('#1c3d5a', '#ffffff'),
    mainTopic: level('#3370ff', '#ffffff'),
    subTopic: {
      properties: {
        'line-class': XMIND_LINE_ELBOW,
        'svg:fill': '#ffffff',
        'fo:color': XMIND_INK,
        'line-color': XMIND_LINE,
        'line-width': '1',
      },
    },
    map: { properties: { 'svg:fill': '#ffffff', 'line-color': XMIND_LINE } },
  };
}

/** 按 content 数组打成浏览器可下载的 .xmind Blob */
export async function packXMindBlob(content: unknown[]): Promise<Blob> {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  zip.file('content.json', JSON.stringify(content));
  const sheets = Array.isArray(content) ? content : [];
  const activeSheetId =
    (sheets[0] && typeof sheets[0] === 'object' && (sheets[0] as { id?: string }).id) || 'sheet-1';
  zip.file(
    'metadata.json',
    JSON.stringify({
      creator: { name: 'Lantern Harness', version: APP_VERSION },
      activeSheetId,
    }),
  );
  zip.file(
    'manifest.json',
    JSON.stringify({ 'file-entries': { 'content.json': {}, 'metadata.json': {} } }),
  );
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}

export function downloadBlobFile(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
