/**
 * 本地「添加文件」：按扩展名读取为可发给模型的文本，或标记为图片。
 */
import * as XLSX from 'xlsx';

export const FILE_MAX_BYTES = 10 * 1024 * 1024;
export const FILE_MAX_COUNT = 6;

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
const EXCEL_EXTS = new Set(['xlsx', 'xls', 'xlsm', 'xlsb', 'ods']);
const WORD_EXTS = new Set(['docx']);
/** 直接按文本读取 */
const TEXT_EXTS = new Set([
  'md',
  'markdown',
  'txt',
  'text',
  'json',
  'csv',
  'tsv',
  'yaml',
  'yml',
  'xml',
  'html',
  'htm',
  'log',
  'sql',
  'feature',
  'toml',
  'ini',
  'conf',
  'properties',
  'rst',
  'css',
  'js',
  'ts',
  'tsx',
  'jsx',
  'py',
  'java',
  'go',
  'rs',
  'sh',
  'bash',
  'zsh',
  'env',
  'gitignore',
  'dockerfile',
  'makefile',
  'svg',
]);

export const ATTACH_ACCEPT_EXTS = [
  ...TEXT_EXTS,
  ...IMAGE_EXTS,
  ...EXCEL_EXTS,
  ...WORD_EXTS,
  'doc',
  'pdf',
];

export type ReadFileResult =
  { kind: 'image'; file: File } | { kind: 'text'; name: string; size: number; content: string };

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

async function excelToText(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const chunks: string[] = [`# ${file.name}`, `工作表数：${wb.SheetNames.length}`, ''];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const csv = XLSX.utils.sheet_to_csv(ws);
    chunks.push(`## ${name}`, csv.trim() || '（空表）', '');
  }
  return chunks.join('\n').trim();
}

async function docxToText(file: File): Promise<string> {
  const mammoth = await import('mammoth');
  const buf = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer: buf });
  const body = (result.value ?? '').trim();
  const lines = [`# ${file.name}`, ''];
  if (result.messages?.length) {
    lines.push(
      `（解析备注：${result.messages
        .slice(0, 3)
        .map((m) => m.message)
        .join('；')}）`,
      '',
    );
  }
  lines.push(body || '（未提取到正文）');
  return lines.join('\n');
}

/** 旧版 .doc：走本地服务 `/__tb_attach/text`（word-extractor） */
async function docToText(file: File): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`/__tb_attach/text?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: await file.arrayBuffer(),
    });
  } catch {
    throw new Error(`${file.name}：解析 .doc 需要本地服务（lantern web / pnpm dev）`);
  }
  let json: { ok?: boolean; content?: string; error?: string } = {};
  try {
    json = (await res.json()) as typeof json;
  } catch {
    throw new Error(`${file.name}：本地服务返回异常`);
  }
  if (!res.ok || !json.ok || !json.content) {
    throw new Error(json.error || `${file.name}：无法解析 .doc`);
  }
  return json.content;
}

/** 读取单个本地文件；不支持则抛错 */
export async function readLocalAttachFile(file: File): Promise<ReadFileResult> {
  const ext = extOf(file.name);
  if (!ext) throw new Error(`${file.name}：无法识别扩展名`);
  if (file.size > FILE_MAX_BYTES) {
    throw new Error(`${file.name}：超过 ${Math.round(FILE_MAX_BYTES / 1024 / 1024)} MB`);
  }

  if (IMAGE_EXTS.has(ext) || file.type.startsWith('image/')) {
    return { kind: 'image', file };
  }

  if (EXCEL_EXTS.has(ext)) {
    return { kind: 'text', name: file.name, size: file.size, content: await excelToText(file) };
  }

  if (WORD_EXTS.has(ext)) {
    return { kind: 'text', name: file.name, size: file.size, content: await docxToText(file) };
  }

  if (ext === 'doc') {
    const content = await docToText(file);
    return { kind: 'text', name: file.name, size: file.size, content };
  }

  if (ext === 'pdf') {
    throw new Error(`${file.name}：PDF 暂不解析正文，请转 Markdown/图片后添加`);
  }

  if (TEXT_EXTS.has(ext) || file.type.startsWith('text/') || file.type === 'application/json') {
    return { kind: 'text', name: file.name, size: file.size, content: await file.text() };
  }

  throw new Error(`${file.name}：暂不支持的类型 .${ext}`);
}
