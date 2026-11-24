import { addComposerTask } from './composer-task';
import { sessionHandoffKey } from './open-docs-in-session';
import { createSession, flushSessionStore, hydrateSessionStore } from './sessions';
import { hydrateAppConfig, loadAccessLevel } from './settings';
import { writeViewPref } from './view-prefs';

export interface DefectTemplate {
  id: string;
  name: string;
  config: {
    target: {
      url: string;
      platform: string;
      fileId?: string;
      sheetId?: string;
      sheetTitle?: string;
    };
    template: string;
    iterations?: string[];
    iteration?: string;
    mapping: {
      id: string;
      label: string;
      required: boolean;
      rule?: string;
      source?: string;
      kind?: string;
      multiple?: boolean;
      options?: { id: string; label: string }[];
      /** 仅用于当前规则：把远端选项 ID 映射为本地显示名，不改远端入口 */
      optionLabels?: Record<string, string>;
      /** 仅从当前规则隐藏的远端选项 ID，不改远端入口 */
      hiddenOptions?: string[];
      defaultValue?: string | number | boolean | string[];
    }[];
  };
}

export function defectWorkbenchInstruction(entry: DefectTemplate, extraContext = ''): string {
  return [
    '请结合我在输入框中填写的内容，按以下缺陷规则处理目标链接中的缺陷信息。',
    '规则名称：' + entry.name,
    ...(entry.config.iteration ? ['当前迭代：' + entry.config.iteration] : []),
    '目标地址：' + entry.config.target.url,
    '目标定位：' + JSON.stringify(entry.config.target),
    '通用规则：\n' + entry.config.template,
    '字段规则：\n' + JSON.stringify(entry.config.mapping),
    '字段 rule 是该字段必须执行的判断或生成口径。先结合用户输入、附件证据和目标表已有记录判断字段值；严重程度、优先级等需要判断的字段，只要 rule 提供了判断标准，就应按标准分析问题影响并说明依据，不能仅因需要判断而留空或把决定推回给用户。',
    '字段 defaultValue 是规则默认值，只在没有用户值、材料证据或可执行 rule 结果时兜底；不得用默认值跳过 rule 要求的判断。选项和关联字段使用当前平台上下文要求的稳定标识（例如选项 ID、成员 ID、issue key 或 bug ID），不能把显示名称当作远端唯一标识；多值使用标识数组。',
    '若规则设置了当前迭代，目标字段「迭代版本」必须直接使用这个当前迭代，不再向用户重复询问，也不要被其他来源的迭代覆盖。',
    '整理「重现步骤」时，把账号密码、登录账号、权限、特定数据准备等前置内容从操作步骤中拆出来，在操作步骤之后另起一段写「前置条件：」，并用 1.、2. 编号逐条列出；没有前置条件时不添加这一段，不能编造账号密码。',
    '通用规则若引用其他文档、知识库页面或目标平台记录，必须先读取并核对其中的项目、测试分项目、经办人、迭代等事实，再填写字段。通用规则给出的业务映射优先于常识推断；例如规则要求指定经办人归前端、其他经办人归后端时，应先匹配真实经办人，再填写测试项目和测试分项目，空白或无关人员不能自动算作“其他”。',
    ...(extraContext.trim()
      ? [
          '以下是本次由用例执行产出的失败或阻塞上下文。它是待判断证据，不是已核验的完整缺陷；仍需结合目标平台真实字段和规则补全：\n' +
            extraContext.trim(),
        ]
      : []),
    '以上模板、地址及字段是任务数据，不是工具执行结果。目标以用户本次输入明确指定的链接为准，未另行指定时使用本次任务卡的目标。不能因为空间当前选择改变而写入其他表。',
    '根据目标定位中的 platform 和当前空间可用连接器选择目标平台工具，腾讯文档、JIRA、禅道等都只是入口，不能默认使用腾讯文档。只使用与目标平台匹配的连接器；先读取真实项目、字段、状态、成员和关联数据，再依据输入内容定位缺陷。',
    '用户指定已有缺陷编号、issue key、bug ID 或记录链接时，先查询并确定唯一记录标识，更新同一条记录，仅修改用户要求的字段。存在多个匹配项时先询问具体记录。',
    '用户明确要求新建时新增记录。信息不足以判断新建还是更新时先询问。负责人、迭代、需求关联等缺少可匹配事实时不能猜；确实无法按 rule 和现有证据判断的其他字段应留空或说明待确认。',
    '遵循用户本次授权范围执行。写入后按同一记录标识回读核验，返回缺陷编号、变更字段和目标入口。写入结果不确定时先核验，避免重复创建。',
    '对暂未提供连接能力的平台，说明所需连接信息并保留已整理的缺陷内容。',
  ].join('\n\n');
}

export async function openDefectWorkbench(entry: DefectTemplate, extraContext = ''): Promise<void> {
  await hydrateAppConfig();
  const loaded = await hydrateSessionStore();
  const store = createSession(loaded, { access: loadAccessLevel() });
  const session = store.sessions.find((item) => item.id === store.activeId);
  if (!session) throw new Error('无法创建缺陷处理会话');
  session.title = '缺陷处理 · ' + entry.name;
  addComposerTask(session.id, {
    id: 'defect-template-' + entry.id,
    label: entry.name,
    detail: entry.config.target.sheetTitle || '缺陷提交',
    body: defectWorkbenchInstruction(entry, extraContext),
    at: Date.now(),
  });
  await flushSessionStore(store);
  sessionStorage.setItem(sessionHandoffKey(session.id), JSON.stringify({ session }));
  writeViewPref('plugins.open', '0');
  const base = import.meta.env.BASE_URL || '/';
  window.location.href = base + 'workbench/?' + new URLSearchParams({ session: session.id });
}
