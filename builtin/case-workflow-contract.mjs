/** Pure contracts shared by browser UI and local services. */
export function defectLinks(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(/\r?\n|[；;]/);
  return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))];
}

export function validateDefectLinks(value) {
  const links = defectLinks(value);
  if (links.length > 50) throw new Error('一条用例最多关联 50 个缺陷地址');
  for (const link of links) {
    let url;
    try {
      url = new URL(link);
    } catch {
      throw new Error('缺陷地址必须是完整的 HTTP / HTTPS 链接');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('缺陷地址必须是无账号密码的 HTTP / HTTPS 链接');
    }
  }
  return links.join('\n');
}

export function normalizeExecutionStatus(raw) {
  const value = String(raw || '').trim();
  if (['待验证', '通过', '不通过', '阻塞', '跳过'].includes(value)) return value;
  if (/^(p|pass|passed|ok|成功|true|1)$/i.test(value)) return '通过';
  if (/^(f|fail|failed|失败|false|0)$/i.test(value)) return '不通过';
  if (/block/i.test(value)) return '阻塞';
  if (/skip|n\/?a/i.test(value)) return '跳过';
  return '待验证';
}

export function executionHeaders(headers) {
  const next = [...headers];
  const normalize = (h) =>
    String(h)
      .replace(/[（(][^）)]*[）)]/g, '')
      .replace(/[\s*＊・·:：]/g, '')
      .toLowerCase();
  if (!next.some((h) => /^(用例状态|执行状态|执行结果|测试结果)$/.test(normalize(h))))
    next.push('用例状态');
  if (!next.some((h) => /^(实际结果|实测结果|执行实际结果)$/.test(normalize(h))))
    next.push('实际结果');
  return next;
}

export function assertTargetUrl(value, target, extraOrigins = []) {
  const url = new URL(value, target);
  const origins = new Set([new URL(target).origin, ...extraOrigins]);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    !origins.has(url.origin)
  ) {
    throw new Error('目标地址不在本次执行授权的站点范围内');
  }
  return url.href;
}

export function assessExecutionEvidence(result, events) {
  const observed = events.filter(
    (e) => e.type === 'tool' && e.status === 'done' && /case_browser_(open|snapshot)/.test(e.title),
  );
  const steps = Array.isArray(result?.stepResults) ? result.stepResults : [];
  const issues = [];
  if (!observed.length) issues.push('未取得目标页面快照');
  if (!steps.length || steps.some((s) => !s.actual || !s.evidence))
    issues.push('步骤缺少实际结果或证据');
  if ((result?.unverified || []).length || result?.blocker) issues.push('存在未验证步骤或阻塞');
  if (result?.status === '通过' && steps.some((s) => s.passed !== true))
    issues.push('步骤断言未全部通过');
  return { sufficient: !issues.length, issues };
}

export const CASE_FIELD_ALIASES = {
  no: [
    '用例编号',
    '测试用例编号',
    '案例编号',
    '用例号',
    '用例id',
    '编号',
    'no',
    'caseid',
    'tc编号',
  ],
  title: [
    '用例标题',
    '用例名称',
    '测试用例标题',
    // 有些模板分两级：`测试项目` 放迭代 / 模块名，`测试分项目` 才是这一条用例的标题。
    // `测试分项目` 排在 `测试项目` 前面，这类文件才不会被整列同名标题盖住。
    '测试分项目',
    '测试项目',
    '测试点',
    '检查点',
    '测试内容',
    '用例描述',
    '用例说明',
    '接口名称',
    '接口用例',
    '性能场景',
    '性能用例',
    '自动化场景',
    '标题',
    '名称',
    '摘要',
    'title',
    'casename',
  ],
  precondition: [
    '前置条件',
    '预置条件',
    '前提条件',
    '准备条件',
    '初始条件',
    '前置',
    'precondition',
  ],
  steps: [
    '测试步骤',
    '操作步骤',
    '执行步骤',
    '用例步骤',
    '测试过程',
    '操作过程',
    '步骤',
    'steps',
    'step',
  ],
  expected: [
    '预期结果',
    '期望结果',
    '预期内容',
    '期望内容标准',
    '预期效果',
    '期望结果标准',
    '验收标准',
    '检查结果',
    '预期',
    'expected',
  ],
  priority: ['优先级', '优先级别', '重要级别', '重要程度', '级别', 'priority'],
  type: ['用例类型', '测试类型', '用例种类', '类型', '类别', 'type'],
  module: [
    '所属模块',
    '测试模块',
    '功能模块',
    '所属功能',
    '所属子系统',
    '模块',
    '大模块',
    '测试项目',
    'module',
  ],
  /** Ideal「小模块」对应用例「子模块」 */
  submodule: ['子模块', '小模块', '二级模块', '功能点', 'submodule'],
  requirement: ['需求编号', '关联需求', '需求id', '需求', 'requirement'],
  /** 与需求编号分开：挂文档需求条目 / outline 标题 */
  reqCite: ['引用需求点', '需求点', '关联需求点', 'outline', 'reqcite', 'reqpoint'],
};
