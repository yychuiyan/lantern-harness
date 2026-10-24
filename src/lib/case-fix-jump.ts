/**
 * 评审里「错误无效 / 待修改」→ 去工作台改：跳到这条用例绑定的会话，没有就新建。
 *
 * 跳转时做三件事：
 * 1. 按用例文件路径找已绑定的工作台会话（`caseGen.linkedCasePath`），找不到新建一个；
 * 2. 把「改哪条、为什么判错、要补什么」写成作曲区的**任务卡**（`composer-task`）：
 *    输入框里只出现一枚短胶囊，点击可展开预览 / 修改，发送时正文一起带上；
 * 3. 复用「在会话中打开」的路径 chip，把用例文件挂到作曲区，模型能直接读到文件。
 */
import type { DocsRoot } from './project-docs';
import {
  createSession,
  flushSessionStore,
  hydrateSessionStore,
  isEphemeralEmptySession,
  loadSessionStore,
  pruneEphemeralSessions,
  type ChatSession,
} from './sessions';
import { hydrateAppConfig, loadAccessLevel } from './settings';
import { dropComposerDraft, readComposerDraft } from './composer-draft';
import { addComposerTask, readComposerTasks } from './composer-task';
import { sessionHandoffKey } from './open-docs-in-session';
import type { BlindspotItem, CaseVerdict } from './case-review';
import { BLINDSPOT_META } from './case-review';

/** 有草稿或任务卡的空会话先留着，别在跳转时误删 */
function sessionHasPendingComposer(id: string): boolean {
  return Boolean(readComposerDraft(id).trim()) || readComposerTasks(id).length > 0;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/**
 * xlsx / xls 是二进制：工作台的文件工具只能读写文本，通常改不了。
 * 这类文件让模型把「改好的整行」按表头贴出来，用户自己粘回去。
 */
export function isSheetCaseFile(file: string): boolean {
  return /\.(xlsx|xlsm|xls)$/i.test(file);
}

/** 按文件类型给「怎么交付改动」的两条说明（编号从 start 开始） */
function deliverByExt(file: string, kind: 'fix' | 'add', start: number): string[] {
  if (isSheetCaseFile(file)) {
    return [
      `${start}. ${
        kind === 'fix'
          ? '这个文件是 xlsx（二进制）：会话里的文件工具一般写不了它。请不要假装写成功，改成把改好的整行按「文件表头顺序」用 markdown 表格贴出来（第一列是原编号），我直接粘回文件。'
          : '这个文件是 xlsx（二进制）：会话里的文件工具一般写不了它。请不要假装写成功，改成把新增的行按「文件表头顺序」用 markdown 表格贴出来（编号按文件规则续），并标明每条应插在哪个归属需求分组的哪一行之后，我按位置粘进文件，不要默认贴到末尾。'
      }`,
      `${start + 1}. 如果确实有 bash / python 能直接改 xlsx，也可以直接改，但改完必须把改动行贴出来让我核对。`,
    ];
  }
  return [
    `${start}. ${
      kind === 'fix'
        ? '改动写回原文件（写之前先备份），写完告诉我改了哪些列、改成什么。'
        : '写回原文件前先备份，写完告诉我加了哪几条、编号是什么。'
    }`,
    `${start + 1}. 如果当前会话没有可用的文件工具，把${
      kind === 'fix' ? '改好的整条用例' : '新行'
    }按文件表头贴给我，我自己粘回去。`,
  ];
}

function findBoundSession(
  store: { sessions: ChatSession[] },
  pathNorm: string,
): ChatSession | undefined {
  return store.sessions.find((s) => {
    const lp = s.caseGen?.linkedCasePath;
    return Boolean(lp && normalizePath(lp) === pathNorm);
  });
}

export interface CaseFixTarget {
  /** 用例文件相对路径（相对 cases/） */
  path: string;
  /** 文件名，用于文案 */
  name?: string;
  verdict: CaseVerdict;
  /** 对照需求标题（有就写进提示，帮模型对上需求） */
  requirementTitle?: string;
}

/** 拼一段可直接发出去的修改要求：只改这一条，带上扣分原因与建议 */
export function caseFixInstruction(target: CaseFixTarget): string {
  const { verdict } = target;
  const file = target.name || target.path.split('/').pop() || target.path;
  const no = verdict.no || '（无编号）';
  const title = verdict.title || '（无标题）';
  const label = verdict.verdict === 'invalid' ? '错误无效' : '待修改';
  const lines: string[] = [];
  lines.push(`帮我改一下用例文件《${file}》里的这一条：${no} ${title}`);
  lines.push('');
  lines.push(`评审结论：${label}（${verdict.score} 分）`);
  if (verdict.hard) lines.push(`硬伤：${verdict.hard}`);
  if (verdict.deductions.length) {
    lines.push('');
    lines.push('扣分项与建议：');
    for (const d of verdict.deductions) {
      lines.push(`- 扣 ${d.points} 分：${d.reason}`);
      if (d.suggestion) lines.push(`  建议：${d.suggestion}`);
    }
  }
  if (target.requirementTitle) {
    lines.push('');
    lines.push(`对照需求：${target.requirementTitle}（对不上时以需求分析的验收标准为准）`);
  }
  lines.push('');
  lines.push('要求：');
  lines.push('1. 先读一遍这个文件，确认表头与已有用例的写法，只改这一条，其它用例一个字都不要动；');
  lines.push(
    '2. 标题、步骤、预期按上面建议补齐，步骤一步一个动作，预期写到可判定的状态 / 文案 / 数值；',
  );
  lines.push(
    '3. 改完后把该条「用例状态」直接标为「待验证」（不要标通过 / 已修改 / 不通过）；没有「用例状态」列就跳过这一步；',
  );
  lines.push(
    '4. 我自己也会在「用例管理」里同时改，改动以文件当前内容为准，别按我给的建议覆盖我后来的手改；',
  );
  lines.push(...deliverByExt(file, 'fix', 5));
  return lines.join('\n');
}

/** 旧版本会把整段要求写进输入框草稿；升级后命中这些开头就当作过期草稿清掉 */
const LEGACY_JUMP_DRAFT_PREFIXES = ['帮我改一下用例文件', '帮我把下面'];

function looksLikeLegacyJumpDraft(text: string): boolean {
  const t = text.trim();
  return t.length > 240 && LEGACY_JUMP_DRAFT_PREFIXES.some((p) => t.startsWith(p));
}

/**
 * 打开工作台并挂上任务卡：优先这条用例文件已绑定的会话，没有就新建。
 * 不改动用户自己写的输入草稿——任务卡与输入框是两回事，正文发送时才拼进去。
 */
async function openInBoundSession(
  path: string,
  name: string | undefined,
  task: { id: string; label: string; detail?: string; body: string },
): Promise<void> {
  const base = import.meta.env.BASE_URL || '/';
  await hydrateSessionStore().catch(() => null);
  await hydrateAppConfig().catch(() => null);
  const pathNorm = normalizePath(path);
  let store = loadSessionStore();

  let chat = findBoundSession(store, pathNorm);
  if (!chat) {
    // 优先复用当前空会话，避免侧栏再堆一个「新对话」
    const active = store.sessions.find((s) => s.id === store.activeId);
    if (active && isEphemeralEmptySession(active) && !active.archived && !active.deleted) {
      chat = active;
    } else {
      const reusable = store.sessions.find(
        (s) => isEphemeralEmptySession(s) && !sessionHasPendingComposer(s.id),
      );
      if (reusable) {
        chat = reusable;
        store = { ...store, activeId: reusable.id };
      } else {
        store = createSession(store, { access: loadAccessLevel() });
        chat = store.sessions.find((s) => s.id === store.activeId);
      }
    }
  }
  if (!chat) throw new Error('无法创建或定位会话');

  // 顺手清掉其它空「新对话」（有草稿 / 任务卡的除外）
  store = pruneEphemeralSessions(store, chat.id, sessionHasPendingComposer);
  if (store.activeId !== chat.id) store = { ...store, activeId: chat.id };
  await flushSessionStore(store);
  chat = store.sessions.find((s) => s.id === chat!.id) ?? chat;

  // 清掉旧版本写进草稿的整段要求，否则点保存前还会顶在输入框里
  if (looksLikeLegacyJumpDraft(readComposerDraft(chat.id))) dropComposerDraft(chat.id);
  // 长要求放进任务卡（胶囊 + 可展开预览），不再整段塞进输入框
  addComposerTask(chat.id, { ...task, at: Date.now() });

  try {
    const seeded = store.sessions.find((s) => s.id === chat!.id) ?? chat;
    sessionStorage.setItem(sessionHandoffKey(chat.id), JSON.stringify({ session: seeded }));
  } catch {
    // private mode 等忽略
  }

  const root: DocsRoot = 'cases';
  const fileName = name || pathNorm.split('/').pop() || pathNorm;
  // 只挂作曲区路径 chip，不带 focusRoot/focusPath：
  // 绑定会话里往往已有该文件的入库卡，focus 会 scrollIntoView 滚到会话中段/开头，
  // 「从工作台写入 / 跳转修改」应停在底部看任务卡，而不是跳回旧卡片。
  const q = new URLSearchParams({
    session: chat.id,
    attachRoot: root,
    attachPath: pathNorm,
    attachName: fileName,
  });
  window.location.href = `${base}workbench/?${q.toString()}`;
}

/** 评审里的「错误无效 / 待修改」→ 去工作台改这一条 */
export async function openCaseFixInChatSession(target: CaseFixTarget): Promise<void> {
  const file = target.name || target.path.split('/').pop() || target.path;
  await openInBoundSession(target.path, target.name, {
    id: `case-fix:${normalizePath(target.path)}:${target.verdict.no || target.verdict.title}`,
    label: `修改用例 ${target.verdict.no || target.verdict.title || file}`,
    detail: `${target.verdict.verdict === 'invalid' ? '错误无效' : '待修改'} · ${file}`,
    body: caseFixInstruction(target),
  });
}

/** 一次改多条时，按这个条数分包：太多条容易漏改、也容易把文件的其它行带坏 */
export const BATCH_FIX_SIZE = 8;

export interface CaseBatchFixTarget {
  path: string;
  name?: string;
  /** 要一起改的用例（带判定与扣分原因） */
  verdicts: readonly CaseVerdict[];
  requirementTitle?: string;
}

/** 拼「批量改这几条」的要求：逐条列证据，要求分包处理并回报编号对照 */
export function caseBatchFixInstruction(target: CaseBatchFixTarget): string {
  const file = target.name || target.path.split('/').pop() || target.path;
  const list = target.verdicts;
  const lines: string[] = [];
  lines.push(
    `帮我改一下用例文件《${file}》里这 ${list.length} 条评审没通过的用例，其它用例不要动。`,
  );
  lines.push('');
  list.forEach((v, i) => {
    const label = v.verdict === 'invalid' ? '错误无效' : '待修改';
    lines.push(
      `### ${i + 1}. ${v.no || '（无编号）'} ${v.title || '（无标题）'} · ${label} ${v.score}`,
    );
    if (v.hard) lines.push(`- 硬伤：${v.hard}`);
    for (const d of v.deductions) {
      lines.push(
        `- 扣 ${d.points} 分：${d.reason}${d.suggestion ? `｜建议：${d.suggestion}` : ''}`,
      );
    }
  });
  if (target.requirementTitle) {
    lines.push('');
    lines.push(`对照需求：${target.requirementTitle}（对不上时以需求分析的验收标准为准）`);
  }
  lines.push('');
  lines.push('要求：');
  lines.push(
    '1. 先读一遍这个文件，按编号定位要改的行，确认表头与已有用例的写法；只改上面列出的这些条，其它行一个字都不要动；',
  );
  lines.push(
    '2. 标题、步骤、预期、前置条件按建议补齐：步骤一步一个动作，预期写到可判定的状态 / 文案 / 数值；',
  );
  lines.push(
    '3. 改完的每条都把「用例状态」直接标为「待验证」（不要标通过 / 已修改 / 不通过）；没有「用例状态」列就跳过这一步；',
  );
  lines.push(
    '4. 我也在「用例管理」里同时手改，改之前先按文件当前内容确认一遍，不要用我早期的版本覆盖后来的手改；',
  );
  lines.push(
    `5. 条数多时分包处理（每包 ${BATCH_FIX_SIZE} 条以内），每包处理完先回报「编号 → 改了什么」，不要一口气静默改完；`,
  );
  lines.push(...deliverByExt(file, 'fix', 6));
  lines.push(
    '8. 改完在回复里给我一张对照表（编号 / 改前问题 / 改后要点 / 已标待验证）；对照表只写在对话里，不要另存成用例管理目录下的新文件。',
  );
  return lines.join('\n');
}

/** 评审里的「批量修改」→ 去工作台，一次改一批（建议每批不超过 BATCH_FIX_SIZE 条） */
export async function openCaseBatchFixInChatSession(target: CaseBatchFixTarget): Promise<void> {
  const file = target.name || target.path.split('/').pop() || target.path;
  const n = target.verdicts.length;
  const nos = target.verdicts
    .map((v) => v.no)
    .filter(Boolean)
    .slice(0, 3)
    .join('、');
  await openInBoundSession(target.path, target.name, {
    id: `case-batch-fix:${normalizePath(target.path)}:${target.verdicts.map((v) => v.no || v.title).join(',')}`,
    // 胶囊名与「生成测试用例」同风格：短固定名，条数 / 文件放 detail
    label: '批量修改用例',
    detail: nos ? `${n} 条 · ${nos}${n > 3 ? ' 等' : ''} · ${file}` : `${n} 条 · ${file}`,
    body: caseBatchFixInstruction(target),
  });
}

export interface BlindspotWritebackTarget {
  /** 用例文件相对路径（相对 cases/） */
  path: string;
  name?: string;
  /** 勾选要写回的盲区 */
  items: readonly BlindspotItem[];
  /** 对照需求标题（有就写进提示，帮模型补齐验收口径） */
  requirementTitle?: string;
}

/** 拼「把勾选的盲区补进用例文件」的写回要求 */
export function blindspotWritebackInstruction(target: BlindspotWritebackTarget): string {
  const file = target.name || target.path.split('/').pop() || target.path;
  const lines: string[] = [];
  lines.push(`帮我把下面 ${target.items.length} 条「场景补全」用例补进用例文件《${file}》。`);
  lines.push('');
  if (target.requirementTitle) {
    lines.push(`对照需求：${target.requirementTitle}`);
    lines.push('');
  }
  lines.push('待补进的用例：');
  target.items.forEach((item, i) => {
    const meta = BLINDSPOT_META[item.category];
    lines.push('');
    lines.push(`### ${i + 1}. [${meta?.label ?? item.category}] ${item.title}`);
    lines.push(
      `- 归属需求：${item.reqAnchor?.trim() || '（未标，按标题 / why / 对照需求与文件里已有分组推断）'}`,
    );
    lines.push(`- 为什么容易漏：${item.why || '—'}`);
    lines.push(`- 前置条件：${item.precondition || '（待补）'}`);
    lines.push(
      `- 测试步骤：${item.steps.length ? item.steps.map((x, n) => `${n + 1}. ${x}`).join('；') : '（待补）'}`,
    );
    lines.push(`- 预期结果：${item.expected || '（待补）'}`);
    lines.push(`- 优先级：${item.priority || 'P2'}`);
  });
  lines.push('');
  lines.push('要求：');
  lines.push(
    '1. 先读一遍这个文件，看清表头，以及已有用例是怎么按需求分组的（常见分组列：需求编号 / 关联需求 / 所属模块 / 测试项目 / 模块；Ideal 一类常按「一行需求标题」聚在同一模块列）。',
  );
  lines.push('2. 每条新用例必须插到「归属需求」对应分组的最后一行之后，禁止整批发到文件末尾：');
  lines.push(
    '   - 条目写了归属需求时，优先用它匹配（与文件「需求编号 / 关联需求」列原文一致即可，前缀不限；或模块 / 测试项目 / 标题列包含该文案）；',
  );
  lines.push('   - 没写归属时，根据标题、why、对照需求推断最贴近的一组，再插到该组末尾；');
  lines.push('   - 整份文件都对不上任何组时，才允许追加到文件末尾，并在回复里说明对不上的原因。');
  lines.push(
    '3. 分组列（需求编号 / 关联需求等）优先抄同组已有行的编号；同组也没有编号、且归属需求本身也没有编号时，再补一个自定义编号写入该列（同组多条共用同一个号，风格跟文件里已有编号一致；文件完全没有先例时用短递增号），并在回复里列出新编了哪些号。模块 / 测试项目等展示列仍跟同组邻行一致。',
  );
  lines.push(
    '4. 再按文件表头填标题、前置、步骤、预期、优先级、类型、用例编号。用例编号沿用文件规则并避开已用编号。',
  );
  lines.push(
    '5. 只插入这些新用例：原有行内容一个字都不要改，也不要重排无关行；步骤一步一个动作，预期写到可判定，不要留「待补」。',
  );
  lines.push('6. 我自己也会同时手改这个文件，插入前先按当前内容确认用例编号没有被占用；');
  lines.push(...deliverByExt(file, 'add', 7));
  return lines.join('\n');
}

/** 场景补全的「写回」→ 交给工作台会话写文件（不再走服务端追加） */
export async function openBlindspotWritebackInChatSession(
  target: BlindspotWritebackTarget,
): Promise<void> {
  const file = target.name || target.path.split('/').pop() || target.path;
  await openInBoundSession(target.path, target.name, {
    id: `blindspot-writeback:${normalizePath(target.path)}:${target.items.map((x) => x.id).join(',')}`,
    label: `补进 ${target.items.length} 条场景用例`,
    detail: file,
    body: blindspotWritebackInstruction(target),
  });
}
