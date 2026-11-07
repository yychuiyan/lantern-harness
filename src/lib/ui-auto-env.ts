/**
 * 项目环境配置（Playwright）：读写项目里的 `.env` / `.env.<ENV>`。
 *
 * 服务端 `lh-plugins/uiauto-env.mjs` 负责解析与打码，这里只做类型与接口封装，
 * 外加两条纯函数（环境名清洗、任务命令与所选环境的冲突判断）供界面即时反馈。
 */
import { UI_AUTO_API, type UiAutoProject } from './ui-auto';

export interface EnvEntry {
  key: string;
  /** 密钥字段恒为空串（服务端不打码明文下发） */
  value: string;
  hasValue: boolean;
  secret: boolean;
  /** 是否平台契约 key（ENV / BASE_URL / ALLOW_PROD），其余 key 的说明归项目模板 */
  platform: boolean;
  /** 文件里这个 KEY 上面的注释块：界面用它还原用户自己的分节（如 `SIP 自动应答（UDP）`） */
  comment?: string;
  /** 分节注释（与上一个变量之间隔了空行）：显示成小节标题 */
  section?: string;
}

/** 平台约定的变量（ENV / BASE_URL / ALLOW_PROD）：界面常驻，不依赖模板 */
export interface EnvKeyMeta {
  key: string;
  label: string;
  hint?: string;
  secret?: boolean;
  readOnly?: boolean;
}

/** `.env.example` 里的一个字段 */
export interface EnvSchemaKey {
  key: string;
  /** 分组里只有一个 key 时，分组标题直接当字段名 */
  label: string;
  hint: string;
  /** 模板里的非空值：界面当 placeholder，不写进文件 */
  placeholder: string;
  /** 模板里是注释状态（`# KEY=...`）：标成可选，填了才写进环境文件 */
  optional?: boolean;
}

/** `.env.example` 里的一段（`# 标题` + 空行隔开） */
export interface EnvSchemaBlock {
  title: string;
  keys: EnvSchemaKey[];
}

/** 项目自己的字段 schema（来源 `.env.example`） */
export interface EnvSchema {
  /** 实际读的模板文件名；空串 = 项目还没有模板 */
  source: string;
  blocks: EnvSchemaBlock[];
  keys: string[];
}

/** 跨环境已有的 key：`{ SIP_HOST: ['test', 'prod'] }` */
export interface EnvKeyMatrix {
  keyEnvs: Record<string, string[]>;
  envKeys: Record<string, string[]>;
}

export interface EnvFileOption {
  /** 空串表示共用的 `.env` */
  env: string;
  file: string;
}

export interface ProjectEnvMeta {
  /** 当前选中的环境名；空串 = `.env` */
  env: string;
  file: string;
  exists: boolean;
  entries: EnvEntry[];
  /** 文件原文：面板按文本编辑，注释与空行原样保留 */
  text: string;
  platformKeys: EnvKeyMeta[];
  schema: EnvSchema;
  /** 当 schema 用的模板文件（`.env.example`） */
  example: { file: string; exists: boolean; text: string };
  /** 其它环境里已经配过的 key（只读 key 名，不读值） */
  crossEnv: EnvKeyMatrix;
  envs: EnvFileOption[];
  /** `.auth/` 下已有的登录态文件 */
  authFiles: string[];
  /** 只有 Playwright 支持 */
  supported: boolean;
  hasConvention: boolean;
  defaultEnv: string;
  error: string;
}

export interface EnvValidationItem {
  key: string;
  message: string;
}

export interface EnvValidation {
  errors: EnvValidationItem[];
  warnings: EnvValidationItem[];
}

export interface ClearAuthResult {
  removed: string[];
  authFiles: string[];
}

/** 模板文件（`.env.example`）原文 */
export interface EnvTemplateFile {
  file: string;
  exists: boolean;
  text: string;
}

export interface DeleteEnvResult {
  /** 被删掉的文件名，例如 `.env.prod` */
  removed: string;
  envs: EnvFileOption[];
  /** 删的正好是默认环境时带回更新后的项目记录 */
  project?: UiAutoProject;
  error: string;
}

async function envRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${UI_AUTO_API}${path}`, {
    ...init,
    headers:
      init?.body === undefined
        ? undefined
        : { 'Content-Type': 'application/json', ...init?.headers },
  });
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string } & T;
  if (!res.ok || json.ok === false) {
    throw new Error(json.error || `HTTP ${res.status}`);
  }
  return json;
}

export async function fetchProjectEnv(projectId: string, env?: string): Promise<ProjectEnvMeta> {
  const query = new URLSearchParams({ projectId });
  // 空串是合法目标（共用 `.env`）：不传才表示「按项目默认 / 第一个已有环境」
  if (env !== undefined) query.set('env', env);
  return envRequest<ProjectEnvMeta>(`/project/env?${query.toString()}`);
}

/** 环境文件原文（文本编辑用） */
export interface EnvTextFile {
  env: string;
  file: string;
  exists: boolean;
  text: string;
}

export interface SaveEnvTextResult extends EnvTextFile {
  envs: EnvFileOption[];
  authFiles: string[];
  validation: EnvValidation;
  project?: UiAutoProject;
  error: string;
}

/** 读环境文件原文 */
export async function fetchProjectEnvText(projectId: string, env: string): Promise<EnvTextFile> {
  const query = new URLSearchParams({ projectId, env });
  return envRequest<EnvTextFile>(`/project/env/text?${query.toString()}`);
}

/** 按原文写回环境文件（ENV 由服务端按文件名纠正） */
export async function saveProjectEnvText(input: {
  projectId: string;
  env: string;
  text: string;
  makeDefault?: boolean;
}): Promise<SaveEnvTextResult> {
  return envRequest<SaveEnvTextResult>('/project/env/text', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** 读模板文件（`.env.example`）原文：面板里按文本编辑分组与字段说明 */
export async function fetchEnvTemplateFile(
  projectId: string,
  file = '.env.example',
): Promise<EnvTemplateFile> {
  const query = new URLSearchParams({ projectId, file });
  return envRequest<EnvTemplateFile>(`/project/env/file?${query.toString()}`);
}

/** 写回模板文件原文 */
export async function saveEnvTemplateFile(input: {
  projectId: string;
  file?: string;
  text: string;
}): Promise<EnvTemplateFile> {
  return envRequest<EnvTemplateFile>('/project/env/file', {
    method: 'POST',
    body: JSON.stringify({ ...input, file: input.file ?? '.env.example' }),
  });
}

/** 删除一个环境文件（`.env.<ENV>`；`.env` 与模板不允许删） */
export async function deleteProjectEnv(input: {
  projectId: string;
  env: string;
}): Promise<DeleteEnvResult> {
  return envRequest<DeleteEnvResult>('/project/env/delete', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** 清掉 `.auth/*.json`：换环境后旧 cookie 通常已经失效 */
export async function clearProjectAuth(projectId: string): Promise<ClearAuthResult> {
  return envRequest<ClearAuthResult>('/project/env/clear-auth', {
    method: 'POST',
    body: JSON.stringify({ projectId }),
  });
}

/** 环境名口径与服务端一致：小写字母开头，只允许小写字母 / 数字 / `_` / `-`；空串表示 `.env` */
export function sanitizeEnvName(name: string): string {
  const value = String(name ?? '').trim();
  return /^[a-z][a-z0-9_-]{0,19}$/.test(value) ? value : '';
}

export function envFileName(env: string): string {
  const name = sanitizeEnvName(env);
  return name ? `.env.${name}` : '.env';
}

/** 环境显示名：`.env` 显示成 `env`（共用默认），其余显示 `test` / `prod` 这种短名 */
export function envLabel(env: string): string {
  return sanitizeEnvName(env) || 'env';
}

/**
 * 骨架自带的固定环境：`.env`（共用兜底）与 `.env.prod`。
 * 它们属于框架约定，不在面板里给删除入口；只有用户自己新建的 `.env.<ENV>` 才能删。
 */
export function isSkeletonEnv(env: string): boolean {
  const name = sanitizeEnvName(env);
  return name === '' || name === 'prod';
}

/**
 * 任务命令与所选 ENV 冲突：命令里写死了 `ENV=prod`，shell 里后设的值会盖掉面板的选择。
 * 返回提示文案，没冲突返回空串。
 */
export function envTaskMismatch(command: string, envName: string): string {
  const selected = sanitizeEnvName(envName);
  if (!selected) return '';
  const found = new Set<string>();
  const re = /(?:^|[\s;&|(])ENV\s*=\s*([A-Za-z0-9_-]+)/g;
  let matched: RegExpExecArray | null;
  while ((matched = re.exec(String(command ?? '')))) found.add(matched[1].toLowerCase());
  const conflict = [...found].find((name) => name !== selected);
  if (!conflict) return '';
  return `这条任务命令里写死了 ENV=${conflict}，会覆盖面板选的 ENV=${selected}；换一条不带 ENV= 的任务，或把环境选成 ${conflict}。`;
}
