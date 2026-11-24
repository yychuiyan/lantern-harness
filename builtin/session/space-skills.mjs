/** 空间技能注册与迁移。旧提示词路径保留为兼容别名，canonical 正文只维护一份。 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveContentRoot, spaceLocalFile } from './space-layout.mjs';
import { validateSkillOutput } from './skill-validation.mjs';
const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
const catalog = {
  '默认提示词.md': [
    'foundation',
    '空间基础规则',
    '',
    'foundation',
    '选定空间并加载基础规则；在此基础上按需使用任务技能。',
  ],
  '需求分析提示词.md': [
    'requirements',
    '需求分析',
    'reqAnalysis',
    'analysis',
    '读取需求原文→提取来源条目→拆解用户故事→调用既有覆盖检查→列出待确认项。',
  ],
  '原文结构提示词.md': [
    'outline',
    '原文结构提取',
    'reqAnalysis',
    'analysis',
    '读取原文→保留标题顺序和稳定来源标识→校验节点重复及缺失→输出结构。',
  ],
  '用户故事审查提示词.md': [
    'story-review',
    '用户故事审查',
    'storyReview',
    'analysis',
    '先做既有确定性覆盖检查→分析场景遗漏→预览修复建议→重新校验。',
  ],
  '测试点生成提示词.md': [
    'test-points',
    '测试点设计',
    'testPoints',
    'analysis',
    '读取用户故事和来源→生成五维测试点→分配P0–P3→核对引用→使用既有导出。',
  ],
  '功能测试用例提示词.md': [
    'functional-cases',
    '功能用例设计',
    'caseGen',
    'cases',
    '读取需求、测试点和当前模板→生成用例→校验表头、编号、来源→预览后按原入口保存。',
  ],
  '功能测试用例提示词_按需求合并场景.md': [
    'functional-cases',
    '功能用例设计',
    'caseGen',
    'cases',
    '按需求分组→合并兼容场景→保留异常与未覆盖说明→校验模板、引用与编号。',
  ],
  '接口测试用例提示词.md': [
    'api-cases',
    '接口用例设计',
    'caseGen',
    'cases',
    '读取接口契约→设计鉴权、参数与异常断言→核对模板和契约引用；不自动请求目标系统。',
  ],
  '性能测试用例提示词.md': [
    'performance-cases',
    '性能用例设计',
    'caseGen',
    'cases',
    '读取实际目标与环境→设计负载和指标→核对单位及阈值来源；缺失项列待确认，不直接压测。',
  ],
  '自动化测试用例提示词.md': [
    'automation-cases',
    '自动化用例设计',
    'caseGen',
    'cases',
    '读取需求与模板→判断可自动化范围→设计步骤断言→核对覆盖与来源。',
  ],
  '自动化执行提示词.md': [
    'automation-run',
    '自动化生成与执行',
    'uiAuto',
    'automation',
    '读取项目环境→通过既有探索器规划与取证→生成代码→检查→按原权限执行→归档报告。',
  ],
  'Playwright提示词.md': [
    'automation-run',
    '自动化生成与执行',
    'uiAuto',
    'automation',
    '旧版变体：保留原文与绑定，使用既有自动化执行器；不得自动替换其他变体。',
  ],
  '自动化项目提示词.md': [
    'automation-project',
    '自动化项目创建',
    'uiAuto',
    'automation',
    '读取技术栈→体检现有骨架→补配置→预览差异→按既有授权创建及检查环境。',
  ],
  '用例质量评审提示词.md': [
    'case-review',
    '用例质量评审',
    'caseReview',
    'review',
    '解析已有用例→逐条评审→核对评分范围及统计分母→分级→输出建议和既有报告。',
  ],
  '场景遗漏补全提示词.md': [
    'case-gaps',
    '用例场景补全',
    'caseBlindspot',
    'review',
    '读取需求与已有用例→识别缺口→去重→预览→按既有备份机制补写→校验表头和来源。',
  ],
  '用例执行提示词.md': [
    'case-execution',
    '用例执行',
    'caseExecution',
    'execution',
    '读取单条用例→检查登录和环境→按步骤操作浏览器→观察实际结果→截图取证→给出通过/不通过/阻塞/跳过；不自动写文件或建缺陷。',
  ],
  '功能测试报告提示词.md': [
    'test-report',
    '测试报告整理',
    'testReports',
    'report',
    '读取真实功能执行记录与模板→汇总统计→检查数量和章节→补缺段；不得虚构执行结果。',
  ],
  '接口测试报告提示词.md': [
    'test-report',
    '测试报告整理',
    'testReports',
    'report',
    '读取接口执行记录→汇总实际统计→核对失败事实→保留模板章节并整理报告。',
  ],
  '性能测试报告提示词.md': [
    'test-report',
    '测试报告整理',
    'testReports',
    'report',
    '读取真实压测结果→核对单位、分位数和阈值→检查统计→生成结论；数据不足列缺项。',
  ],
  '工作汇报提示词.md': [
    'work-report',
    '工作汇报',
    'reports',
    'report',
    '指定周期→读取既有本期工作数据→沿用区间和基线口径→生成汇报→按原规则落盘。',
  ],
  '业务地图识别提示词.md': [
    'business-map',
    '业务地图识别',
    'businessMap',
    'analysis',
    '选择单个、多个或全量→既有后台只读采集→分批分析→验证证据→低风险草稿或待审核。',
  ],
};
export const SPACE_SKILL_CATALOG = catalog;
const root = (space) => resolveContentRoot(space, '技能管理').abs;
const prompts = (space) => resolveContentRoot(space, '提示词管理').abs;
const indexFile = (space) => path.join(root(space), 'index.json');
const RULE_RESOURCE = 'references/business-rules.md';
const LEGACY_RULE_RESOURCE = 'prompts/instructions.md';
const LEGACY_MANIFEST = 'skill.json';
function readIndex(space) {
  const file = indexFile(space);
  if (!fs.existsSync(file)) return { version: 1, revision: 0, skills: [] };
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function atomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}
function saveIndex(space, index) {
  index.revision++;
  atomic(indexFile(space), JSON.stringify(index, null, 2) + '\n');
}
/**
 * 旧索引把插件绑定写成单个 owner。v2 改为 pluginRefs；owner 只保留兼容投影。
 * 返回是否发生了结构升级，供迁移流程决定是否落盘。
 */
function normalizeEntry(entry) {
  const refs = Array.isArray(entry.pluginRefs)
    ? [...new Set(entry.pluginRefs.map(String).filter(Boolean))]
    : entry.owner
      ? [String(entry.owner)]
      : [];
  const source =
    entry.source ||
    (refs.length
      ? 'bundled'
      : entry.migrated
        ? 'prompt'
        : entry.kind === 'custom'
          ? 'custom'
          : 'bundled');
  const system =
    typeof entry.system === 'boolean'
      ? entry.system
      : Boolean(refs.length || entry.kind === 'foundation');
  const mandatory = refs.length > 0 || entry.kind === 'foundation';
  const enabled = mandatory ? true : entry.enabled !== false;
  const owner = entry.owner || refs[0] || '';
  const info = catalog[path.basename(entry.legacyPath || '')];
  const description =
    info && entry.description?.includes('与对应业务入口共用当前空间的规则')
      ? describeSkill(info)
      : entry.description;
  const changed =
    owner !== entry.owner ||
    JSON.stringify(refs) !== JSON.stringify(entry.pluginRefs) ||
    source !== entry.source ||
    system !== entry.system ||
    enabled !== entry.enabled ||
    description !== entry.description;
  Object.assign(entry, { owner, pluginRefs: refs, source, system, enabled, description });
  return changed;
}
function mustStayEnabled(entry) {
  return (
    entry.kind === 'foundation' || (Array.isArray(entry.pluginRefs) && entry.pluginRefs.length > 0)
  );
}
function fail(message, statusCode = 400) {
  throw Object.assign(new Error(message), { statusCode });
}
function inside(base, relative) {
  const dest = path.resolve(base, relative);
  if (!dest.startsWith(path.resolve(base) + path.sep)) fail('资源路径越界');
  // 不跟随技能资源或根目录中的符号链接。
  for (let p = dest; p !== path.dirname(p); p = path.dirname(p)) {
    if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) fail('技能路径不允许符号链接');
    if (p === path.resolve(base)) break;
  }
  return dest;
}
function entryDir(space, id) {
  if (!/^[a-z0-9-]+$/.test(id)) fail('技能 ID 无效');
  return inside(root(space), id);
}
function bodyFile(space, entry) {
  return inside(entryDir(space, entry.id), RULE_RESOURCE);
}
function skillFile(space, entry) {
  return inside(entryDir(space, entry.id), 'SKILL.md');
}
function removeLegacyManifest(space, entry) {
  const file = inside(entryDir(space, entry.id), LEGACY_MANIFEST);
  try {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      return true;
    }
  } catch {
    // 旧清单只是缓存；删不掉不阻断标准格式读取。
  }
  return false;
}
function instructions(entry) {
  return `---\nname: ${entry.id}\ndescription: ${JSON.stringify(entry.description)}\n---\n\n# ${entry.name}\n\n## 适用范围\n${entry.description}\n\n## 流程\n${entry.workflow}\n\n## 输入与输出\n使用本轮实际材料与选定模板；缺少材料时列出缺项。按原业务入口的结构输出，保存与执行沿用原权限。\n\n## 指令\n读取 [业务规则](references/business-rules.md)，保留当前变体的业务口径。\n\n## 校验\n${entry.kind === 'foundation' ? '作为当前空间基础规则常驻加载，不额外执行任务。' : '可调用 skill_validate 检查输出结构、模板列、编号、来源、枚举与统计。实际业务执行使用已关联的插件入口；加载技能本身不会执行脚本或写入数据。'}\n`;
}
function describeSkill(info) {
  return info[4].replaceAll('→', '；');
}
function makeEntry(relative) {
  const name = path.basename(relative),
    info = catalog[name];
  const id = (info?.[0] ?? 'custom') + '-' + hash(relative).slice(0, 10);
  const pluginRefs = info?.[2] ? [info[2]] : [];
  return {
    id,
    group: info?.[0] ?? id,
    name: info?.[1] ?? name.replace(/\.md$/i, ''),
    variant: name.replace(/\.md$/i, ''),
    legacyPath: relative,
    owner: info?.[2] ?? '',
    pluginRefs,
    source: info ? 'bundled' : 'prompt',
    system: Boolean(pluginRefs.length || info?.[0] === 'foundation'),
    kind: info?.[3] ?? 'custom',
    description: info
      ? describeSkill(info)
      : '用户维护的独立能力包；按正文和流程执行，不自动推断工具权限。',
    workflow: info?.[4] ?? '读取本轮输入→按业务规则分析→检查缺项和输出→按用户授权使用工具。',
    enabled: true,
    version: 1,
    updatedAt: new Date().toISOString(),
  };
}
function walk(base, relative = '') {
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, { withFileTypes: true }).flatMap((item) => {
    const rel = relative ? `${relative}/${item.name}` : item.name;
    if (item.isSymbolicLink() || item.name.startsWith('.')) return [];
    return item.isDirectory()
      ? walk(path.join(base, item.name), rel)
      : item.isFile() && /\.md$/i.test(item.name)
        ? [rel]
        : [];
  });
}

/** 把旧入口文案收敛到技能页；不改业务规则本身。 */
function migrateSkillRuleWording(text) {
  return text
    .replaceAll('<!-- 仅供参考：运行时与日常维护以空间「提示词管理」下同名文件为准。 -->\n', '')
    .replace(/^> 插件开启期间不能删除本文件；关闭插件后可以删掉，再次打开会重新生成。\r?\n/gm, '')
    .replace(/^> 这份提示词由(.+?)插件生成并引用(.*)$/gm, '> 由$1插件关联$2')
    .replaceAll(
      '日常增删改请只改本空间「提示词管理」里的本文件。',
      '日常增删改请到本空间「插件仓库 → 技能」维护。',
    )
    .replaceAll('（请在提示词管理中维护：', '（请在关联技能中维护：')
    .replaceAll('提示词管理中', '关联技能中')
    .replaceAll('「提示词管理」', '「插件仓库 → 技能」');
}

/** 旧 `prompts/instructions.md` → 标准 `references/business-rules.md`。 */
function migrateLegacySkillLayout(space, entry) {
  const dir = entryDir(space, entry.id);
  const legacy = inside(dir, LEGACY_RULE_RESOURCE);
  const target = bodyFile(space, entry);
  let changed = false;
  if (!entry.sourceHash && entry.legacyPath) {
    const source = inside(prompts(space), entry.legacyPath);
    try {
      if (fs.existsSync(source)) {
        entry.sourceHash = hash(fs.readFileSync(source, 'utf8'));
        changed = true;
      }
    } catch {
      // 旧原文件缺失不影响标准资源迁移。
    }
  }
  if (fs.existsSync(legacy)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target)) {
      fs.renameSync(legacy, target);
    } else if (hash(fs.readFileSync(legacy, 'utf8')) !== hash(fs.readFileSync(target, 'utf8'))) {
      const backup = spaceLocalFile(space, `skills/migrations/legacy-${entry.id}-${Date.now()}.md`);
      atomic(backup, fs.readFileSync(legacy, 'utf8'));
      fs.unlinkSync(legacy);
    } else {
      fs.unlinkSync(legacy);
    }
    const legacyDir = inside(dir, 'prompts');
    try {
      if (fs.existsSync(legacyDir) && fs.readdirSync(legacyDir).length === 0) {
        fs.rmdirSync(legacyDir);
      }
    } catch {
      // 保留非空旧目录，不影响标准入口。
    }
    changed = true;
  }
  if (!fs.existsSync(target)) {
    atomic(target, '');
  }
  const rules = fs.readFileSync(target, 'utf8');
  const cleanedRules = migrateSkillRuleWording(rules);
  if (cleanedRules !== rules) {
    atomic(target, cleanedRules);
    if (entry.originalHash === hash(rules)) {
      entry.sourceHash ||= entry.originalHash;
      entry.originalHash = hash(cleanedRules);
    }
    changed = true;
  }
  const skillPath = skillFile(space, entry);
  if (!fs.existsSync(skillPath)) {
    atomic(skillPath, instructions(entry));
    changed = true;
  } else {
    const current = fs.readFileSync(skillPath, 'utf8');
    const next = current.replaceAll(LEGACY_RULE_RESOURCE, RULE_RESOURCE);
    if (next !== current) {
      atomic(skillPath, next);
      changed = true;
    }
  }
  if (removeLegacyManifest(space, entry)) changed = true;
  return changed;
}

/** 迁移幂等；保留旧文件作为原始备份。注册表只有在该技能的资源全部落盘后更新。 */
export function migrateSpaceSkills(space) {
  const index = readIndex(space),
    added = [];
  let upgraded = false;
  if (index.version !== 3) {
    index.version = 3;
    upgraded = true;
  }
  for (const entry of index.skills) {
    if (normalizeEntry(entry)) upgraded = true;
    if (migrateLegacySkillLayout(space, entry)) upgraded = true;
    if (entry.migrated == null) {
      entry.migrated = Boolean(entry.legacyPath);
      upgraded = true;
    }
  }
  if (upgraded) saveIndex(space, index);
  for (const relative of walk(prompts(space))) {
    if (index.skills.some((x) => x.legacyPath === relative)) continue;
    const entry = makeEntry(relative),
      sourceContent = fs.readFileSync(inside(prompts(space), relative), 'utf8'),
      content = migrateSkillRuleWording(sourceContent);
    entry.sourceHash = hash(sourceContent);
    entry.originalHash = hash(content);
    entry.migrated = true;
    const dest = bodyFile(space, entry);
    // 上次中断留下的正文必须与原文一致；不得覆盖未知修改。
    if (fs.existsSync(dest) && hash(fs.readFileSync(dest, 'utf8')) !== entry.originalHash)
      fail(`迁移冲突：${relative}`, 409);
    atomic(dest, content);
    atomic(skillFile(space, entry), instructions(entry));
    if (entry.kind !== 'foundation') {
      const validator = fs.readFileSync(new URL('./skill-validation.mjs', import.meta.url), 'utf8');
      atomic(
        inside(entryDir(space, entry.id), 'scripts/validate.mjs'),
        validator +
          `\nif (process.argv[1] && (await import('node:fs')).realpathSync((await import('node:url')).fileURLToPath(import.meta.url)) === (await import('node:fs')).realpathSync(process.argv[1])) {\n const input = JSON.parse((await import('node:fs')).readFileSync(0,'utf8')); const result=validateSkillOutput(input); console.log(JSON.stringify(result,null,2)); process.exitCode=result.ok?0:1;\n}\n`,
      );
    }
    index.skills.push(entry);
    saveIndex(space, index);
    added.push(entry.id);
  }
  return { added, count: index.skills.length };
}
export function migratedPromptPath(space, name) {
  const entry = readIndex(space).skills.find((x) => x.legacyPath === name);
  return entry ? bodyFile(space, entry) : null;
}
function pluginEnabled(space, id) {
  const read = (name) => {
    try {
      return JSON.parse(fs.readFileSync(spaceLocalFile(space, name), 'utf8')).plugins ?? {};
    } catch {
      return {};
    }
  };
  const defaults = read('app.defaults.json'),
    config = read('app.config.json');
  return (config[id] ?? defaults[id]) === true;
}
export function listSpaceSkills(space) {
  return readIndex(space).skills.map((entry) => {
    normalizeEntry(entry);
    return {
      ...entry,
      scope: 'space',
      key: `space:${entry.id}`,
      path: skillFile(space, entry),
      active: entry.enabled,
      pluginActive: entry.pluginRefs.some((id) => pluginEnabled(space, id)),
      foundation: entry.kind === 'foundation',
    };
  });
}
export function getSpaceSkill(space, id) {
  const entry = readIndex(space).skills.find((x) => x.id === String(id).replace(/^space:/, ''));
  if (!entry) fail('技能不存在', 404);
  normalizeEntry(entry);
  const content = fs.readFileSync(bodyFile(space, entry), 'utf8');
  const workflow = fs.readFileSync(skillFile(space, entry), 'utf8');
  return {
    ...entry,
    content,
    instructions: workflow,
    hash: hash(content + '\0' + workflow),
    resources: fs
      .readdirSync(entryDir(space, entry.id), { recursive: true })
      .filter((x) => fs.statSync(inside(entryDir(space, entry.id), x)).isFile())
      .map(String),
  };
}
export function updateSpaceSkill(space, id, patch) {
  const index = readIndex(space),
    entry = index.skills.find((x) => x.id === id);
  if (!entry) fail('技能不存在', 404);
  normalizeEntry(entry);
  const current = getSpaceSkill(space, id);
  if (patch.hash !== current.hash) fail('技能已修改，请重新加载', 409);
  if (patch.enabled === false && mustStayEnabled(entry))
    fail(entry.kind === 'foundation' ? '空间基础规则不可停用' : '已关联业务的技能不可停用');
  const content = patch.content ?? current.content,
    workflow = patch.instructions ?? current.instructions;
  if (
    typeof content !== 'string' ||
    typeof workflow !== 'string' ||
    Buffer.byteLength(content + workflow) > 1024 * 1024
  )
    fail('技能正文无效或超过1MB');
  const history = spaceLocalFile(space, `skills/history/${id}/${entry.version}.json`);
  atomic(history, JSON.stringify(current, null, 2));
  atomic(bodyFile(space, entry), content);
  atomic(skillFile(space, entry), workflow);
  entry.enabled = patch.enabled ?? entry.enabled;
  entry.version++;
  entry.updatedAt = new Date().toISOString();
  saveIndex(space, index);
  return getSpaceSkill(space, id);
}
export function createSpaceSkill(space, name, content) {
  if (typeof name !== 'string' || !name.trim() || name.length > 120 || /[/\\\0]/.test(name))
    fail('技能名称无效');
  if (typeof content !== 'string' || !content.trim() || Buffer.byteLength(content) > 1024 * 1024)
    fail('请填写技能指令，最多1MB');
  const index = readIndex(space),
    entry = makeEntry(`${name.trim()}.md`);
  entry.id = 'custom-' + crypto.randomBytes(8).toString('hex');
  entry.group = entry.id;
  entry.legacyPath = `${name.trim()}.md`;
  if (
    fs.existsSync(inside(prompts(space), entry.legacyPath)) ||
    index.skills.some((x) => x.legacyPath === entry.legacyPath)
  )
    entry.legacyPath = `${name.trim()}-${entry.id.slice(-8)}.md`;
  entry.originalHash = hash(content);
  entry.migrated = false;
  entry.source = 'custom';
  entry.system = false;
  entry.pluginRefs = [];
  entry.owner = '';
  atomic(inside(prompts(space), entry.legacyPath), content);
  entry.name = name.trim();
  entry.variant = name.trim();
  entry.description = '用户维护的独立能力包；按正文和流程执行，不自动推断工具权限。';
  atomic(bodyFile(space, entry), content);
  atomic(skillFile(space, entry), instructions(entry));
  removeLegacyManifest(space, entry);
  index.skills.push(entry);
  saveIndex(space, index);
  return getSpaceSkill(space, entry.id);
}

/**
 * 确保插件内置技能存在；未修改过的旧种子随代码升级，用户修改保持不动。
 * `originalHash` 表示该技能当前正文对应的最近一次内置种子。
 */
export function ensureSpaceSkillSeed(space, name, content, owner = '') {
  const rel = String(name ?? '')
    .trim()
    .endsWith('.md')
    ? String(name).trim()
    : `${String(name ?? '').trim()}.md`;
  if (!rel || rel.includes('/') || rel.includes('\\') || !String(content ?? '').trim()) {
    fail('技能种子名称或正文无效');
  }
  migrateSpaceSkills(space);
  const index = readIndex(space);
  let entry = index.skills.find((item) => item.legacyPath === rel);
  const seededHash = hash(content);
  if (!entry) {
    entry = makeEntry(rel);
    if (owner) {
      entry.pluginRefs = [...new Set([...(entry.pluginRefs || []), owner])];
      entry.owner = entry.pluginRefs[0] || owner;
      entry.source = 'bundled';
      entry.system = true;
    }
    entry.originalHash = seededHash;
    atomic(bodyFile(space, entry), content);
    atomic(skillFile(space, entry), instructions(entry));
    if (entry.kind !== 'foundation') {
      const validator = fs.readFileSync(new URL('./skill-validation.mjs', import.meta.url), 'utf8');
      atomic(
        inside(entryDir(space, entry.id), 'scripts/validate.mjs'),
        validator +
          `\nif (process.argv[1] && (await import('node:fs')).realpathSync((await import('node:url')).fileURLToPath(import.meta.url)) === (await import('node:fs')).realpathSync(process.argv[1])) {\n const input = JSON.parse((await import('node:fs')).readFileSync(0,'utf8')); const result=validateSkillOutput(input); console.log(JSON.stringify(result,null,2)); process.exitCode=result.ok?0:1;\n}\n`,
      );
    }
    index.skills.push(entry);
    saveIndex(space, index);
    return { created: true, updated: false, version: entry.version, legacyPath: rel };
  }

  normalizeEntry(entry);
  const current = fs.readFileSync(bodyFile(space, entry), 'utf8');
  const expectedSeedHash = entry.originalHash || hash(current);
  if (hash(current) !== expectedSeedHash) {
    return { created: false, updated: false, version: entry.version, legacyPath: rel };
  }
  if (current === content) {
    return { created: false, updated: false, version: entry.version, legacyPath: rel };
  }
  atomic(bodyFile(space, entry), content);
  atomic(skillFile(space, entry), instructions(entry));
  entry.originalHash = seededHash;
  entry.version++;
  entry.updatedAt = new Date().toISOString();
  saveIndex(space, index);
  return { created: false, updated: true, version: entry.version, legacyPath: rel };
}
export function restoreSpaceSkill(space, id, version, expectedHash) {
  getSpaceSkill(space, id);
  if (!Number.isInteger(version) || version < 1) fail('版本无效');
  const previous = JSON.parse(
    fs.readFileSync(spaceLocalFile(space, `skills/history/${id}/${version}.json`), 'utf8'),
  );
  return updateSpaceSkill(space, id, {
    content: previous.content,
    instructions: previous.instructions,
    hash: expectedHash,
  });
}
export function loadSpaceSkill(space, key) {
  const entry = listSpaceSkills(space).find((x) => x.key === key || x.id === key);
  if (!entry) return null;
  if (!entry.active && !entry.foundation) return { ok: false, error: '技能未启用或关联插件已关闭' };
  const skill = getSpaceSkill(space, entry.id),
    text = skill.instructions + '\n\n## 当前变体业务规则\n' + skill.content;
  const buf = Buffer.from(text),
    truncated = buf.length > 65_536;
  return {
    ok: true,
    id: entry.key,
    name: entry.name,
    path: entry.path,
    text: buf.subarray(0, 65_536).toString(),
    bytes: buf.length,
    truncated,
    version: entry.version,
    hash: skill.hash,
  };
}
export function syncPluginSkills(space, owner, enabled) {
  migrateSpaceSkills(space);
  return listSpaceSkills(space);
}

/** 一个技能（同一 group）统一启停；内容版本不变，插件关系也不被改写。 */
export function setSpaceSkillGroupEnabled(space, group, enabled) {
  migrateSpaceSkills(space);
  const index = readIndex(space),
    entries = index.skills.filter((x) => x.group === group);
  if (!entries.length) fail('技能不存在', 404);
  for (const entry of entries) normalizeEntry(entry);
  if (enabled === false && entries.some((entry) => mustStayEnabled(entry)))
    fail(
      entries.some((entry) => entry.kind === 'foundation')
        ? '空间基础规则不可停用'
        : '已关联业务的技能不可停用',
    );
  for (const entry of entries) {
    entry.enabled = enabled === true;
    entry.updatedAt = new Date().toISOString();
  }
  saveIndex(space, index);
  return listSpaceSkills(space);
}
export function validateSpaceSkill(space, id, input) {
  getSpaceSkill(space, id);
  return validateSkillOutput(input);
}
export function skillHistory(space, id) {
  getSpaceSkill(space, id);
  const dir = spaceLocalFile(space, `skills/history/${id}`);
  return fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((x) => /^\d+\.json$/.test(x))
        .map((x) => Number(x.slice(0, -5)))
        .sort((a, b) => b - a)
    : [];
}
export function skillFingerprintForPrompt(space, name) {
  const entry = readIndex(space).skills.find((x) => x.legacyPath === name);
  return entry
    ? { skillId: entry.id, version: entry.version, hash: getSpaceSkill(space, entry.id).hash }
    : null;
}

/** 插件种子或显式重置后同步技能版本；正文已由调用方写入 canonical 资源。 */
export function touchMigratedSkill(space, name) {
  migrateSpaceSkills(space);
  const index = readIndex(space);
  const entry = index.skills.find((x) => x.legacyPath === name);
  if (!entry) return null;
  entry.originalHash = hash(fs.readFileSync(bodyFile(space, entry), 'utf8'));
  entry.version++;
  entry.updatedAt = new Date().toISOString();
  saveIndex(space, index);
  return entry;
}

/** 导入/导出只处理技能资源，不执行导入包脚本。 */
export function exportSpaceSkill(space, id) {
  const skill = getSpaceSkill(space, id),
    base = entryDir(space, id),
    files = {};
  function collect(dir, rel = '') {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (item.isSymbolicLink()) fail('导出资源不允许符号链接');
      const key = rel ? `${rel}/${item.name}` : item.name;
      if (item.isDirectory()) collect(path.join(dir, item.name), key);
      else if (item.isFile() && key !== LEGACY_MANIFEST)
        files[key] = fs.readFileSync(inside(base, key), 'utf8');
    }
  }
  collect(base);
  if (Buffer.byteLength(JSON.stringify(files)) > 2 * 1024 * 1024) fail('导出包超过2MB');
  return { schemaVersion: 1, name: skill.name, files };
}
export function importSpaceSkill(space, bundle) {
  if (bundle?.schemaVersion !== 1 || !bundle.files || typeof bundle.files !== 'object')
    fail('技能包格式无效');
  if (Buffer.byteLength(JSON.stringify(bundle)) > 2 * 1024 * 1024) fail('技能包超过2MB');
  const files = Object.entries(bundle.files);
  if (files.length > 100 || !files.some(([key]) => key === 'SKILL.md'))
    fail('技能包需包含SKILL.md，最多100个资源');
  for (const [key, text] of files)
    if (
      typeof text !== 'string' ||
      key.includes('\\') ||
      key.split('/').some((p) => p === '..' || p === '.' || !p) ||
      path.isAbsolute(key) ||
      !/\.(md|json|mjs|txt|csv)$/i.test(key)
    )
      fail('技能资源路径或格式无效');
  const ruleText =
    bundle.files[RULE_RESOURCE] || bundle.files[LEGACY_RULE_RESOURCE] || bundle.files['SKILL.md'];
  const result = createSpaceSkill(space, bundle.name || '导入技能', ruleText);
  for (const [key, text] of files) {
    if (key === LEGACY_MANIFEST) continue;
    const target = key === LEGACY_RULE_RESOURCE ? RULE_RESOURCE : key;
    atomic(inside(entryDir(space, result.id), target), text);
  }
  return getSpaceSkill(space, result.id);
}
export function rollbackSkillMigration(space) {
  const index = readIndex(space),
    legacy = index.skills.filter((x) => x.migrated);
  for (const entry of legacy) {
    const source = inside(prompts(space), entry.legacyPath);
    const expected = entry.sourceHash || entry.originalHash;
    if (!fs.existsSync(source) || hash(fs.readFileSync(source, 'utf8')) !== expected)
      fail(`原文件发生变动，不能自动回退：${entry.legacyPath}`, 409);
  }
  atomic(
    spaceLocalFile(space, `skills/migrations/rollback-${Date.now()}.json`),
    JSON.stringify(index, null, 2),
  );
  for (const entry of legacy)
    atomic(inside(prompts(space), entry.legacyPath), getSpaceSkill(space, entry.id).content);
  index.skills = index.skills.filter((x) => !x.migrated);
  saveIndex(space, index);
  return { restored: legacy.length };
}
