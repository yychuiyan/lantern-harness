import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { resolveContentRoot } from '../../builtin/session/space-layout.mjs';
import { supplementAutomationFlow, businessMapFilePath } from '../lh-business-map.mjs';
import { readPluginPrompt } from '../plugin-prompts.mjs';
import { CASE_AUTOMATION_FLOW_PROMPT_FILE } from '../case-automation-prompt.mjs';
import { emitFiles } from '../uiauto-explorer/emit-files.mjs';
import { mergeGeneratedFile } from '../uiauto-explorer/merge.mjs';
import {
  detectEmitLayout,
  findGeneratedSessionByAutomationCaseId,
  removeGeneratedSession,
  saveGeneratedSession,
} from '../uiauto-explorer/sessions.mjs';
import { uiautoCachePaths } from '../lh-uiauto.mjs';
import { loadCaseDocument } from '../case-execution/files.mjs';
import {
  readAutomationLinks,
  readFlowStore,
  writeAutomationLinks,
  writeFlowStore,
  upsertAutomationLinks,
  upsertFlowCases,
} from './store.mjs';
import {
  AUTOMATION_HEADERS,
  automationDependencyHash,
  projectRecord,
  normalizeIteration,
  refreshAutomationLinks,
  storageStateStatus,
} from './service.mjs';
import { backupFile, readTable, writeTableAtomic } from './tables.mjs';

const clean = (value, max = 4000) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const fail = (message, statusCode = 400) => {
  throw Object.assign(new Error(message), { statusCode });
};

function flowIdFor(kind, businessSystemId, automationCaseIds) {
  const source = [...automationCaseIds].sort().join('\0');
  return `FLOW-${crypto
    .createHash('sha256')
    .update(`${kind}\0${businessSystemId}\0${source}`)
    .digest('hex')
    .slice(0, 12)
    .toUpperCase()}`;
}

function mapRevision(root) {
  try {
    return Number(JSON.parse(fs.readFileSync(businessMapFilePath(root), 'utf8')).revision || 0);
  } catch {
    return 0;
  }
}

function roleName(project, roleId) {
  return project.roles?.find((role) => role.id === roleId)?.name || roleId;
}

function sourceEvidence(source) {
  return [
    {
      id: `ev-${source.id}`,
      type: 'manual',
      title: `功能用例 ${source.no || source.id} ${source.title}`,
      ref: `case:${source.id}`,
      note: source.expected || '',
      confidence: 'medium',
    },
  ];
}

function sourceRefs(source) {
  return (source.fields || [])
    .filter((field) => /需求|requirement|reqcite|reqpoint/i.test(field.name))
    .map((field) => `${field.name}：${field.value}`)
    .join('；');
}

function writeFileAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

function mapPatchView(patch) {
  return {
    systemId: patch.systemId,
    flowId: patch.flowId,
    flowCreated: patch.flowCreated,
    createdDirectories: patch.createdDirectories || [],
    addedFunctions: patch.addedFunctions || [],
    addedStepTitles: patch.addedStepTitles || [],
    revisionBefore: patch.previousRevision,
    revisionAfter: patch.revision,
    persisted: patch.dryRun !== true,
  };
}

async function upsertFlowAutomationRow(root, body, flow, session) {
  const automationFile = String(body.selected[0]?.automationFilePath || '');
  if (!automationFile) return { path: '', hash: '' };
  const base = resolveContentRoot(root, '用例管理').abs;
  const abs = path.join(base, automationFile);
  const hadFile = fs.existsSync(abs);
  if (!fs.existsSync(abs)) {
    fail('流程来源的自动化用例文件已缺失，请重新生成原子用例');
  }
  const ext = path.extname(abs).toLowerCase();
  const table = await readTable(abs, ext);
  const headers = [...new Set([...AUTOMATION_HEADERS, ...table.headers])];
  const sources = body.selected.map((item) => item.source).filter(Boolean);
  const sourceCases = body.document.cases.filter((item) =>
    sources.some((source) => source.caseId === item.id),
  );
  const row = {
    ...Object.fromEntries(headers.map((header) => [header, ''])),
    用例类型: '流程',
    自动化用例编号: flow.flowCaseId,
    流程用例编号: flow.flowCaseId,
    来源用例文件: body.casePath,
    来源用例编号: [...new Set(sources.map((item) => item.caseNo).filter(Boolean))].join('、'),
    来源自动化用例: body.automationCaseIds.join('、'),
    自动化用例标题: body.title,
    执行角色: flow.requiredRoles.map((role) => role.roleName).join('、'),
    检查点: flow.checkpoints.map((item) => item.title).join('\n'),
    引用需求点: [...new Set(sourceCases.map(sourceRefs).filter(Boolean))].join('；'),
    前置条件: '来源原子用例已接入，所需角色登录态已绑定',
    自动化步骤: flow.checkpoints.map((item, index) => `${index + 1}. ${item.title}`).join('\n'),
    预期结果: `${flow.kind === 'smoke' ? '冒烟' : '回归'}流程通过，${flow.checkpoints.length} 个检查点全部通过`,
    优先级: flow.kind === 'smoke' ? 'P0' : 'P1',
    可行性: '可自动化',
    自动化项目: flow.projectName,
    迭代版本: flow.iteration,
    目标迭代文件: flow.iterationFile,
    测试标签: `@lantern-${flow.flowCaseId.toLowerCase()}`,
    脚本状态: '已接入',
    运行状态:
      {
        connected: '待运行',
        running: '运行中',
        passed: '已通过',
        failed: '运行失败',
        stale: '已过期',
        needs_role: '待绑定角色',
      }[flow.status] || flow.status,
    实际结果: flow.actualResult || '',
    报告地址: flow.reportUrl || '',
    说明: `${flow.kind === 'smoke' ? '冒烟' : '回归'}流程 · UI 会话 ${session.id}`,
  };
  const backup = backupFile(abs);
  const index = table.rows.findIndex(
    (item) =>
      item['流程用例编号'] === flow.flowCaseId || item['自动化用例编号'] === flow.flowCaseId,
  );
  if (index < 0) table.rows.push(row);
  else table.rows[index] = { ...table.rows[index], ...row };
  try {
    const written = await writeTableAtomic(abs, ext, headers, table.rows);
    const linked = readAutomationLinks(root).items.filter(
      (item) => item.automationFilePath === automationFile,
    );
    if (linked.length) {
      upsertAutomationLinks(
        root,
        linked.map((item) => ({
          ...item,
          automationFileHash: written.fileHash,
        })),
      );
    }
    return { path: automationFile, hash: written.fileHash, backup };
  } catch (error) {
    if (backup && fs.existsSync(backup)) fs.copyFileSync(backup, abs);
    else if (!hadFile && fs.existsSync(abs)) fs.rmSync(abs, { force: true });
    throw error;
  }
}

function validateFlowInputs(root, raw) {
  const casePath = clean(raw.casePath, 1000);
  const projectId = clean(raw.projectId, 80);
  const iteration = normalizeIteration(raw.iteration);
  const kind = raw.kind === 'smoke' ? 'smoke' : raw.kind === 'regression' ? 'regression' : '';
  if (!kind) fail('流程类型必须是 smoke 或 regression');
  const automationCaseIds = [
    ...new Set(
      (Array.isArray(raw.automationCaseIds) ? raw.automationCaseIds : [])
        .map((item) => clean(item, 80))
        .filter(Boolean),
    ),
  ];
  if (automationCaseIds.length < 2) fail('流程至少需要两条已生成的原子自动化用例');
  const { project, health } = projectRecord(root, projectId);
  const links = readAutomationLinks(root).items;
  const selected = automationCaseIds.map((id) =>
    links.find((item) => item.automationCaseId === id),
  );
  if (selected.some((item) => !item)) fail('部分自动化用例不存在');
  if (selected.some((item) => item.caseKind === 'flow')) fail('流程不能再嵌套其他流程');
  if (selected.some((item) => !['connected', 'passed'].includes(item.status))) {
    fail('只能组合已接入或已通过的原子自动化用例');
  }
  if (selected.some((item) => item.projectId !== project.id)) {
    fail('原子自动化用例必须来自同一个 UI 自动化项目');
  }
  const automationFiles = new Set(
    selected.map((item) => String(item.automationFilePath || '')).filter(Boolean),
  );
  if (selected.some((item) => !item.automationFilePath)) {
    fail('流程来源原子用例缺少自动化用例文件绑定');
  }
  if (automationFiles.size > 1) {
    fail('流程来源原子用例必须位于同一个自动化用例文件');
  }
  if (selected.some((item) => item.source?.casePath !== casePath)) {
    fail('流程来源原子用例必须来自当前功能用例文件');
  }
  return {
    casePath,
    project,
    health,
    iteration,
    kind,
    automationCaseIds,
    selected,
  };
}

function buildRoleBindings(project, selected, raw) {
  const roleIds = [
    ...new Set(
      selected.flatMap((item) => [
        ...(item.actorRoleId ? [item.actorRoleId] : []),
        ...(item.requiredRoleIds || []),
      ]),
    ),
  ];
  if (!roleIds.length) {
    fail('参与流程的原子用例必须至少声明一个执行角色', 422);
  }
  const requestedStates =
    raw.roleStorageStates && typeof raw.roleStorageStates === 'object' ? raw.roleStorageStates : {};
  const roleStorageStates = Object.fromEntries(
    roleIds
      .map((roleId) => [
        roleId,
        clean(requestedStates[roleId], 300) ||
          clean(project.roles?.find((role) => role.id === roleId)?.storageState, 300),
      ])
      .filter(([, storageState]) => storageState),
  );
  const missingRoles = roleIds.filter(
    (roleId) =>
      !roleStorageStates[roleId] || !storageStateStatus(project, roleStorageStates[roleId]).ok,
  );
  const invalidRoles = roleIds.filter(
    (roleId) => project.roles?.find((role) => role.id === roleId)?.status === 'invalid',
  );
  if (invalidRoles.length) {
    fail(
      `以下角色登录态已失效，请重新绑定 storageState：${invalidRoles.map((id) => roleName(project, id)).join('、')}`,
      422,
    );
  }
  if (missingRoles.length) {
    fail(
      `以下角色尚未绑定 storageState：${missingRoles.map((id) => roleName(project, id)).join('、')}`,
      422,
    );
  }
  return { roleIds, roleStorageStates };
}

function checkpointPayload(project, selected, checkpoints, document) {
  const sourceCases = new Map(document.cases.map((item) => [item.id, item]));
  return checkpoints.map((checkpoint, index) => {
    const link = selected[index];
    const source =
      sourceCases.get(link.source?.caseId) ||
      document.cases.find(
        (item) =>
          item.no === link.source?.caseNo &&
          (!link.source?.title || item.title === link.source.title),
      );
    return {
      id: checkpoint.id,
      title: checkpoint.title,
      role: roleName(project, checkpoint.actorRoleId),
      functionName: source?.title || checkpoint.title,
      directoryPath: String(source?.module || '')
        .split(/\s*\/\s*/)
        .filter(Boolean),
      expected: source?.expected || checkpoint.expected,
      evidence: source ? sourceEvidence(source) : [],
    };
  });
}

async function buildFlowBody(root, raw, apply) {
  if (!readPluginPrompt(CASE_AUTOMATION_FLOW_PROMPT_FILE, root).trim()) {
    fail('冒烟与回归流程编排技能尚未就绪，请重新打开自动化测试插件', 422);
  }
  const casePath = clean(raw.casePath, 1000);
  const document = await loadCaseDocument(root, casePath);
  refreshAutomationLinks(root, document);
  const input = validateFlowInputs(root, raw);
  const { project, health, iteration, kind, automationCaseIds, selected } = input;
  const { roleIds, roleStorageStates } = buildRoleBindings(project, selected, raw);
  const sessionBase = uiautoCachePaths(root).dir;
  const steps = [];
  const checkpoints = [];
  const sourceFunctionalCaseIds = [];
  const capturedFlowData = new Set();
  const titleCounts = new Map();
  for (const link of selected) {
    titleCounts.set(link.title, (titleCounts.get(link.title) || 0) + 1);
  }
  for (const [index, link] of selected.entries()) {
    const session = findGeneratedSessionByAutomationCaseId(sessionBase, link.automationCaseId);
    if (!session?.ir?.steps?.length) {
      fail(`原子自动化用例「${link.title}」还没有可复用的步骤 IR，请先完成探索和试跑`);
    }
    if (
      link.status !== 'passed' &&
      !['verified', 'written'].includes(String(session.status || ''))
    ) {
      fail(`原子自动化用例「${link.title}」还没有通过隔离试跑，不能进入正式流程`);
    }
    const actorRoleId = link.actorRoleId || link.requiredRoleIds?.[0] || roleIds[0] || '';
    const checkpointId = `cp-${index + 1}`;
    const checkpointTitle =
      titleCounts.get(link.title) > 1 ? `${index + 1}. ${link.title}` : link.title;
    checkpoints.push({
      id: checkpointId,
      title: checkpointTitle,
      actorRoleId,
      automationCaseId: link.automationCaseId,
      expected: link.source?.title || link.title,
      status: 'pending',
      actual: '',
      error: '',
      failureCategory: '',
      durationMs: 0,
    });
    for (const step of session.ir.steps) {
      if (step.valueFrom && !capturedFlowData.has(step.valueFrom)) {
        fail(
          `流程步骤「${step.target || step.action}」依赖前序数据 ${step.valueFrom}，但当前执行顺序没有提供该捕获值`,
          422,
        );
      }
      if (step.captureAs) capturedFlowData.add(step.captureAs);
      steps.push({
        ...step,
        actorRoleId: step.actorRoleId || actorRoleId,
        checkpointId,
        checkpointTitle,
      });
    }
    if (link.source?.caseId) sourceFunctionalCaseIds.push(link.source.caseId);
  }

  const title = clean(raw.title, 240) || `${kind === 'smoke' ? '冒烟' : '回归'}流程`;
  if (
    !project.baseURL &&
    steps.some(
      (step) =>
        ['goto', 'expectUrl'].includes(step.action) && String(step.url || '').startsWith('/'),
    )
  ) {
    fail('流程脚本包含相对地址，请先为 UI 自动化项目配置 baseURL', 422);
  }
  let businessSystemId = clean(raw.businessSystemId, 64);
  let businessFlowId = clean(raw.businessFlowId, 64);
  if (businessFlowId && !businessSystemId) {
    fail('选择已有业务流程前必须先选择业务系统', 422);
  }
  let mapPatch = null;
  if (raw.autoSupplementBusinessMap === true) {
    if (!businessSystemId) fail('自动补业务地图前必须选择业务系统');
    const patch = supplementAutomationFlow(
      root,
      {
        expectedRevision:
          raw.expectedBusinessMapRevision === undefined
            ? mapRevision(root)
            : Number(raw.expectedBusinessMapRevision),
        systemId: businessSystemId,
        flowId: businessFlowId || undefined,
        flowName: title,
        result: title,
        checkpoints: checkpointPayload(project, selected, checkpoints, document),
      },
      { dryRun: true },
    );
    businessSystemId = patch.systemId;
    businessFlowId = patch.flowId;
    mapPatch = mapPatchView(patch);
  }

  const flowCaseId = flowIdFor(kind, businessSystemId, automationCaseIds);
  const layout = detectEmitLayout(project.dir, health.testDir || '');
  const testDir = String(layout.testDir || 'tests').replaceAll(path.sep, '/');
  const iterationFile = path.posix.join(testDir, 'iteration', `${iteration}.spec.ts`);
  const sourceText = checkpoints
    .map((checkpoint) => `${checkpoint.title} / 角色：${roleName(project, checkpoint.actorRoleId)}`)
    .join('\n');
  const ir = {
    title,
    target: 'ts',
    baseURL: project.baseURL || '',
    roleStorageStates,
    automationCaseId: flowCaseId,
    tag: `@${kind}`,
    source: sourceText,
    steps,
  };
  const spec = emitFiles(ir, 'ts', { testDir }).files.find((file) => file.role === 'spec');
  if (!spec) fail('流程脚本生成失败');
  const specAbs = path.resolve(project.dir, iterationFile);
  if (!specAbs.startsWith(`${path.resolve(project.dir)}${path.sep}`)) {
    fail('目标迭代文件路径越界', 400);
  }
  const existing = fs.existsSync(specAbs) ? fs.readFileSync(specAbs, 'utf8') : '';
  const merged = mergeGeneratedFile(existing, spec.content, {
    path: iterationFile,
    role: 'spec',
  });
  if (!merged) fail('无法安全合并流程脚本，请检查目标 iteration 文件结构', 409);

  return {
    ...input,
    document,
    roleIds,
    roleStorageStates,
    checkpoints,
    steps,
    sourceFunctionalCaseIds,
    title,
    businessSystemId,
    businessFlowId,
    mapPatch,
    flowCaseId,
    iterationFile,
    ir,
    specAbs,
    existing,
    merged,
    apply,
  };
}

function makeFlowDraft(body) {
  return {
    flowCaseId: body.flowCaseId,
    title: body.title,
    kind: body.kind,
    sourceAutomationCaseIds: body.automationCaseIds,
    requiredRoles: body.roleIds.map((roleId) => ({
      roleId,
      roleName: roleName(body.project, roleId),
    })),
    missingRoles: [],
    checkpoints: body.checkpoints,
    gateEligible:
      body.kind === 'smoke' &&
      body.checkpoints.every((checkpoint) => Boolean(checkpoint.actorRoleId)),
    uiSessionId: '',
    scriptPath: body.iterationFile,
    codePreview: body.merged.content,
    mapPatch: body.mapPatch,
  };
}

export async function previewAutomationFlow(root, raw = {}) {
  const body = await buildFlowBody(root, raw, false);
  return makeFlowDraft(body);
}

export async function createAutomationFlow(root, raw = {}) {
  const body = await buildFlowBody(root, raw, true);
  const {
    project,
    iteration,
    iterationFile,
    selected,
    roleIds,
    roleStorageStates,
    checkpoints,
    steps,
    sourceFunctionalCaseIds,
    title,
    kind,
    businessSystemId,
    businessFlowId,
    flowCaseId,
    ir,
    specAbs,
    merged,
  } = body;
  let mapPatch = body.mapPatch;
  const hadExistingFile = fs.existsSync(specAbs);
  const backup = hadExistingFile ? `${specAbs}.lantern-backup-${Date.now()}` : '';
  if (backup) fs.copyFileSync(specAbs, backup);
  const mapFile = businessMapFilePath(root);
  const mapBefore = fs.existsSync(mapFile) ? fs.readFileSync(mapFile) : null;
  const flowStoreBefore = readFlowStore(root);
  const linksBefore = readAutomationLinks(root);
  const sessionBase = uiautoCachePaths(root).dir;
  const existingSession = findGeneratedSessionByAutomationCaseId(sessionBase, flowCaseId);
  const sessionBefore = existingSession ? JSON.parse(JSON.stringify(existingSession)) : null;
  let mapTouched = false;
  let sessionId = '';
  try {
    if (!merged.unchanged) writeFileAtomic(specAbs, merged.content);
    if (raw.autoSupplementBusinessMap === true && mapPatch) {
      const applied = supplementAutomationFlow(root, {
        expectedRevision: mapPatch.revisionBefore,
        systemId: businessSystemId,
        flowId: mapPatch.flowCreated ? undefined : clean(raw.businessFlowId, 64) || undefined,
        flowName: title,
        result: title,
        checkpoints: checkpointPayload(project, selected, checkpoints, body.document),
      });
      mapTouched = true;
      mapPatch = mapPatchView(applied);
    }

    const existingFlow = readFlowStore(root).items.find((item) => item.flowCaseId === flowCaseId);
    const session = saveGeneratedSession(sessionBase, {
      id: existingSession?.id,
      projectId: project.id,
      title,
      target: 'ts',
      baseURL: project.baseURL || '',
      storageState: '',
      roleStorageStates,
      source: ir.source,
      headed: true,
      plan: steps,
      ir,
      status: 'explored',
      automationCaseId: flowCaseId,
      caseKind: 'flow',
      flowCaseId,
      automationTag: `@lantern-${flowCaseId.toLowerCase()}`,
      iteration,
      iterationFile,
      savedPath: iterationFile,
      keepAlive: true,
    });
    sessionId = session.id;
    const dependencyHash = automationDependencyHash(
      root,
      project,
      roleIds,
      businessSystemId,
      businessFlowId,
    );
    const requiredRoles = roleIds.map((roleId) => ({
      roleId,
      roleName: roleName(project, roleId),
    }));
    const definitionKey = JSON.stringify(
      checkpoints.map((item) => ({
        title: item.title,
        actorRoleId: item.actorRoleId,
        automationCaseId: item.automationCaseId,
        expected: item.expected,
      })),
    );
    const previousDefinitionKey = JSON.stringify(
      (existingFlow?.checkpoints || []).map((item) => ({
        title: item.title,
        actorRoleId: item.actorRoleId,
        automationCaseId: item.automationCaseId,
        expected: item.expected,
      })),
    );
    const definitionChanged = definitionKey !== previousDefinitionKey;
    const flowRecord = {
      flowCaseId,
      automationCaseId: flowCaseId,
      title,
      kind,
      status: 'connected',
      businessSystemId,
      businessFlowId,
      sourceAutomationCaseIds: body.automationCaseIds,
      sourceFunctionalCaseIds,
      requiredRoles,
      checkpoints,
      checkpointResults: definitionChanged ? [] : existingFlow?.checkpointResults || [],
      pathConditions: Array.isArray(raw.pathConditions)
        ? raw.pathConditions.map((item) => clean(item, 300)).filter(Boolean)
        : existingFlow?.pathConditions || [],
      sharedDataKeys: [
        ...new Set(steps.flatMap((step) => [step.captureAs, step.valueFrom].filter(Boolean))),
      ],
      cleanup: Array.isArray(raw.cleanup)
        ? raw.cleanup.map((item) => clean(item, 500)).filter(Boolean)
        : existingFlow?.cleanup || [],
      gateEligible:
        kind === 'smoke' &&
        checkpoints.every((checkpoint) => Boolean(checkpoint.actorRoleId)) &&
        checkpoints.every(
          (checkpoint) => checkpoint.status === 'pending' || checkpoint.status === 'passed',
        ),
      projectId: project.id,
      projectName: project.name,
      iteration,
      iterationFile,
      scriptPath: iterationFile,
      uiSessionId: session.id,
      dependencyHash,
      latestRunId: definitionChanged ? '' : existingFlow?.latestRunId || '',
      reportUrl: definitionChanged ? '' : existingFlow?.reportUrl || '',
      failureSummary: definitionChanged ? '' : existingFlow?.failureSummary || '',
      failureCategory: definitionChanged ? '' : existingFlow?.failureCategory || '',
      actualResult: definitionChanged ? '' : existingFlow?.actualResult || '',
      createdAt: existingFlow?.createdAt || new Date().toISOString(),
    };
    const flow =
      upsertFlowCases(root, [flowRecord]).items.find((item) => item.flowCaseId === flowCaseId) ||
      flowRecord;
    const automationRow = await upsertFlowAutomationRow(root, body, flow, session);
    upsertAutomationLinks(root, [
      {
        automationCaseId: flowCaseId,
        flowCaseId,
        caseKind: 'flow',
        title,
        source: selected[0].source,
        sources: selected.map((item) => item.source),
        projectId: project.id,
        projectName: project.name,
        framework: project.framework,
        iteration,
        iterationFile,
        scriptPath: iterationFile,
        automationFilePath: automationRow.path,
        automationFileHash: automationRow.hash,
        tag: `@lantern-${flowCaseId.toLowerCase()}`,
        uiSessionId: session.id,
        status: 'connected',
        requiredRoleIds: roleIds,
        businessSystemId,
        businessFlowId,
        dependencyHash,
      },
    ]);
    return {
      flow,
      draft: {
        ...makeFlowDraft(body),
        flowCaseId,
        uiSessionId: session.id,
        scriptPath: iterationFile,
        automationFile: automationRow.path,
        mapPatch,
        codePreview: merged.content,
      },
    };
  } catch (error) {
    try {
      if (mapTouched) {
        if (mapBefore === null) fs.rmSync(mapFile, { force: true });
        else writeFileAtomic(mapFile, mapBefore);
      }
      writeFlowStore(root, flowStoreBefore);
      writeAutomationLinks(root, linksBefore);
      if (sessionId) {
        if (sessionBefore) saveGeneratedSession(sessionBase, sessionBefore);
        else removeGeneratedSession(sessionBase, sessionId);
      }
    } catch {
      // 保留原始写入错误；回滚失败会在下一次 revision / hash 校验时暴露。
    }
    if (!merged.unchanged && fs.existsSync(specAbs)) {
      if (hadExistingFile) fs.copyFileSync(backup, specAbs);
      else fs.rmSync(specAbs, { force: true });
    }
    throw error;
  } finally {
    if (backup) fs.rmSync(backup, { force: true });
  }
}

export function listAutomationFlows(root, casePath = '') {
  const sourceCaseIds = new Set(
    readAutomationLinks(root)
      .items.filter(
        (item) => item.caseKind !== 'flow' && (!casePath || item.source?.casePath === casePath),
      )
      .map((item) => item.automationCaseId),
  );
  return readFlowStore(root).items.filter(
    (flow) => !casePath || flow.sourceAutomationCaseIds.some((id) => sourceCaseIds.has(id)),
  );
}
