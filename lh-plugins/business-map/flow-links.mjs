const TARGET = /(?:→|->|=>|[:：]|转到|转至|到|至)\s*(?:步骤\s*|第\s*)?(\d+)(?:\s*步)?/g;
const END = /^(?:结束|完成|终止|end)$/i;

export function nextTargets(value) {
  const text = String(value || '').trim();
  if (!text || END.test(text)) return [];
  if (!/^\d+(?:\s*[,，、;；]\s*\d+)*$/.test(text)) return null;
  return text.split(/[,，、;；]/).map(Number);
}

export function branchTargets(value) {
  return [...String(value || '').matchAll(TARGET)].map((match) => Number(match[1]));
}

export function hasBrokenBranch(step, numbers) {
  if (!step.branch) return false;
  const clauses = String(step.branch)
    .split(/[;；\n]/)
    .filter((part) => part.trim());
  return (
    step.branchBroken === true ||
    clauses.some((clause) => {
      const targets = branchTargets(clause);
      return targets.length
        ? targets.some((target) => !numbers.has(target))
        : !/(?:→|->|=>|[:：])\s*(?:结束|完成|终止|end)\s*$/i.test(clause);
    })
  );
}

/** Re-number steps and their explicit numeric references together. */
export function normalizeFlowLinks(steps) {
  const mapping = new Map(steps.map((step, index) => [Number(step.n) || index + 1, index + 1]));
  const normalized = steps.map((step, index) => ({
    ...step,
    n: index + 1,
    next: (nextTargets(step.next) || []).length
      ? String(step.next).replace(/\d+/g, (value) => String(mapping.get(Number(value)) ?? value))
      : String(step.next || ''),
    branch: String(step.branch || '').replace(TARGET, (match, value) =>
      match.replace(value, String(mapping.get(Number(value)) ?? value)),
    ),
  }));
  const numbers = new Set(normalized.map((step) => step.n));
  return normalized.map((step) => ({ ...step, branchBroken: hasBrokenBranch(step, numbers) }));
}

export function flowLinkIssues(steps) {
  const numbers = new Set(steps.map((step) => Number(step.n)));
  const issues = [];
  if (numbers.size !== steps.length || [...numbers].some((n) => !Number.isInteger(n) || n < 1))
    issues.push('步骤编号必须是唯一正整数');
  for (const step of steps) {
    const targets = nextTargets(step.next);
    if (targets === null || targets.some((n) => !numbers.has(n)))
      issues.push(`步骤 ${step.n} 的下一步无效或不存在`);
  }
  return issues;
}
