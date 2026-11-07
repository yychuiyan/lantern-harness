/**
 * 创建项目向导：两种方式，先生选一种再往下走。
 *
 * - 挂载本地项目：选一个已有的 Playwright / pytest / Selenium 目录，自动识别框架后挂载；
 * - 创建全新项目：用平台模板生成一套企业级基础框架（四步：技术栈 → 目标目录 → 预览 → 结果）。
 *
 * 生成模式下预览与写入走同一个后端渲染结果，所见即所写；目标目录非空会被拦下，不覆盖已有文件。
 */
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  addProject,
  checkScaffold,
  createScaffoldProject,
  detectFrameworks,
  fetchProjects,
  fetchScaffoldStacks,
  pickProjectDirectory,
  previewScaffold,
  type FrameworkCandidate,
  type ScaffoldPreview,
  type ScaffoldStack,
  type UiAutoProject,
} from '../../lib/ui-auto';
import {
  applySkeletonPatches,
  AUDIT_STAGE_LABEL,
  patchTargets,
  platformFindings,
  runScaffoldAudit,
  type AuditLogEntry,
  type ScaffoldAuditResult,
  type ScaffoldFinding,
} from '../../lib/ui-auto-scaffold-audit';
import { hydrateAppConfig } from '../../lib/app-config';
import { loadSettings } from '../../lib/settings';
import { buildPreviewTree } from '../../lib/ui-auto-scaffold-tree';
import { revealPath } from '../../lib/ui-auto-agent';
import { readViewText, writeViewText } from '../../lib/view-prefs';
import { PmIcon } from './PmShared';
import { showToast } from './Toast';
import UiAutoGenerationDialog from './UiAutoGenerationDialog';
import UiAutoPreviewTree, { formatBytes } from './UiAutoPreviewTree';
import UiAutoSetupPanel from './UiAutoSetupPanel';

interface Props {
  onClose: () => void;
  /** 生成成功并自动挂载后回调（调用方通常直接进入这个项目） */
  onCreated: (project: UiAutoProject) => void;
  /** 打开时直接进入某种方式；不传则先让用户选 */
  initialMode?: NewProjectMode;
}

type Step = 'mode' | 'mount' | 'stack' | 'target' | 'audit' | 'preview' | 'result';
/** 两种创建方式：挂载已有目录 / 用模板生成 */
export type NewProjectMode = 'mount' | 'scaffold';

const PARENT_PREF = 'ui-auto.scaffold.parent';

const PANEL = 'bg-[var(--tw-surface-panel)] border-[var(--tw-border)]';
const TEXT_PRIMARY = 'text-[var(--tw-label-primary)]';
const TEXT_SECONDARY = 'text-[var(--tw-label-secondary)]';
const TEXT_TERTIARY = 'text-[var(--tw-label-tertiary)]';
const PRIMARY_BTN =
  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-(--tw-accent) px-3 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50';
const GHOST_BTN =
  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-(--tw-border) bg-(--tw-surface-panel) px-3 text-sm text-(--tw-label-secondary) transition-colors hover:bg-(--tw-session-hover-bg) hover:text-(--tw-label-primary) disabled:cursor-not-allowed disabled:opacity-50';
const INPUT =
  'h-8 w-full rounded-lg border border-(--tw-border) bg-(--tw-surface-panel) px-2.5 text-sm text-(--tw-label-primary) outline-none transition-colors placeholder:text-(--tw-label-tertiary) focus:border-(--tw-accent)';
/** 卡片底部的能力标签：弱描边，不抢标题视线 */
const CHIP_MUTED =
  'inline-flex h-5 items-center rounded-md border border-(--tw-border) px-1.5 text-[11px] text-(--tw-label-secondary)';

const STEP_LABEL: Record<Step, string> = {
  mode: '方式',
  mount: '项目目录',
  stack: '技术栈',
  target: '目标目录',
  audit: '检查',
  preview: '预览',
  result: '完成',
};

/**
 * 两种方式各自的步骤条（不含「方式」这一步，选方式前还没有流程可展示）。
 * 挂载只有一步：选目录即完成；生成是「技术栈 → 目标目录 → 检查 → 预览 → 完成」。
 */
function stepOrderOf(mode: NewProjectMode | null): Step[] {
  if (mode === 'mount') return ['mount'];
  if (mode === 'scaffold') return ['stack', 'target', 'audit', 'preview', 'result'];
  return [];
}

export default function UiAutoScaffoldDialog({ onClose, onCreated, initialMode }: Props) {
  const [step, setStep] = useState<Step>(() =>
    initialMode === 'mount' ? 'mount' : initialMode === 'scaffold' ? 'stack' : 'mode',
  );
  const [mode, setMode] = useState<NewProjectMode | null>(initialMode ?? null);
  /** 方式页里当前悬停 / 聚焦的卡片，用来切换上方说明文字 */
  const [hoverMode, setHoverMode] = useState<NewProjectMode | null>(null);
  const [stacks, setStacks] = useState<ScaffoldStack[]>([]);
  const [loadingStacks, setLoadingStacks] = useState(true);
  const [stackId, setStackId] = useState('playwright');
  const [parentDir, setParentDir] = useState(() => readViewText(PARENT_PREF));
  const [name, setName] = useState('');
  const [baseURL, setBaseURL] = useState('');
  const [options, setOptions] = useState<string[]>([]);
  const [preview, setPreview] = useState<ScaffoldPreview | null>(null);
  /** 预览文件清单的目录树（按骨架架构分组） */
  const previewTree = useMemo(() => (preview ? buildPreviewTree(preview.files) : []), [preview]);
  const [created, setCreated] = useState<UiAutoProject | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState('');
  /**
   * 检查步骤（生成前）：左栏实时日志、右栏完整性 / 建议。
   * 勾中的建议只作用于「本次生成」的骨架副本（patchedSkeleton），不改空间基线。
   */
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [auditFindings, setAuditFindings] = useState<ScaffoldFinding[]>([]);
  const [auditResult, setAuditResult] = useState<ScaffoldAuditResult | null>(null);
  const [auditRaw, setAuditRaw] = useState('');
  const [auditStream, setAuditStream] = useState('');
  const [auditRunning, setAuditRunning] = useState(false);
  /** 运行中每 0.5s 刷新一次的已用时（纯展示，不参与判定） */
  const [auditElapsed, setAuditElapsed] = useState(0);
  const auditStartedAt = useRef(0);
  const [auditPromptReady, setAuditPromptReady] = useState(true);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  /** 实际应用到本次骨架的建议 id（生成过程留档里标「已应用」） */
  const [appliedIds, setAppliedIds] = useState<string[]>([]);
  /** 应用补丁后的骨架文本；null 表示用空间基线 */
  const [patchedSkeleton, setPatchedSkeleton] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  /** 完成页的「查看生成过程」弹窗 */
  const [generationOpen, setGenerationOpen] = useState(false);
  /** 预览树里被收起的目录（只记展开状态，默认全展开） */
  const [collapsedDirs, setCollapsedDirs] = useState<Record<string, boolean>>({});
  const auditAbort = useRef<AbortController | null>(null);
  const auditSeq = useRef(0);
  const logBoxRef = useRef<HTMLDivElement | null>(null);
  /** 创建请求进行中：同步挡住连点（busy 是 state，同一帧拦不住第二次点击） */
  const creatingRef = useRef(false);
  /** 挂载方式：目录、可选名称、识别结果 */
  const [mountDir, setMountDir] = useState('');
  const [mountName, setMountName] = useState('');
  const [candidates, setCandidates] = useState<FrameworkCandidate[]>([]);
  const [candidateId, setCandidateId] = useState('');
  const [detecting, setDetecting] = useState(false);
  const [detectNote, setDetectNote] = useState('');
  const detectSeq = useRef(0);

  const stopAudit = useCallback(() => {
    auditAbort.current?.abort();
    auditAbort.current = null;
    // 立刻回到「可操作」状态；被中断的 run 稍后返回时再补一次结果
    setAuditRunning(false);
  }, []);

  /**
   * 输入变了就把上一次检查的结论清掉：父目录 / 项目名 / 被测地址 / 附带内容都会影响
   * 结构与渲染结果，留着旧的「结构通过」和已应用的补丁骨架会让人以为新配置也检查过了。
   */
  const resetChecks = useCallback(() => {
    stopAudit();
    auditSeq.current += 1;
    setAuditLogs([]);
    setAuditFindings([]);
    setAuditResult(null);
    setAuditRaw('');
    setAuditStream('');
    setPicked({});
    setAppliedIds([]);
    setPatchedSkeleton(null);
  }, [stopAudit]);

  /**
   * 只让「结论」失效，不动已应用的骨架补丁。
   * 改父目录 / 项目名 / 被测地址与骨架结构无关，已经补进骨架的文件不该因为改个名字就丢了；
   * 但旧的「结构通过」也不再可信，要重新点「开始检查」。
   */
  const invalidateAudit = useCallback(() => {
    stopAudit();
    auditSeq.current += 1;
    setAuditLogs([]);
    setAuditFindings([]);
    setAuditResult(null);
    setAuditRaw('');
    setAuditStream('');
    setPicked({});
  }, [stopAudit]);

  const stack = useMemo(
    () => stacks.find((item) => item.id === stackId) ?? null,
    [stacks, stackId],
  );

  useEffect(() => {
    let alive = true;
    void fetchScaffoldStacks()
      .then((list) => {
        if (!alive) return;
        setStacks(list);
        const ready = list.filter((item) => item.status === 'ready');
        const preferred = ready[0];
        if (preferred) {
          setStackId(preferred.id);
          setOptions(preferred.defaultOptions);
        }
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setLoadingStacks(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // 换栈时把选项换成该栈的默认勾选
  const chooseStack = (next: ScaffoldStack) => {
    if (next.status !== 'ready') return;
    setStackId(next.id);
    setOptions(next.defaultOptions);
    setPreview(null);
    resetChecks();
    setError('');
  };

  const toggleOption = (id: string) => {
    setOptions((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
    setPreview(null);
    resetChecks();
  };

  const chooseMode = (next: NewProjectMode) => {
    setMode(next);
    setHoverMode(null);
    setError('');
    setStep(next === 'mount' ? 'mount' : 'stack');
  };

  /** 目录变化后识别框架；用序号丢弃过期结果，避免乱序覆盖 */
  const runDetect = useCallback(async (dir: string) => {
    const target = dir.trim();
    detectSeq.current += 1;
    const seq = detectSeq.current;
    setDetecting(true);
    setDetectNote('');
    try {
      const result = await detectFrameworks(target);
      if (seq !== detectSeq.current) return;
      setCandidates(result.candidates);
      setCandidateId(result.candidates[0]?.id ?? '');
      setDetectNote(result.candidates.length ? '' : '没识别到 Playwright / pytest / Selenium 特征');
    } catch (err) {
      if (seq !== detectSeq.current) return;
      setCandidates([]);
      setCandidateId('');
      setDetectNote(err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === detectSeq.current) setDetecting(false);
    }
  }, []);

  // 输入框里手打路径时停 400ms 再识别，避免每个按键都发一次请求
  useEffect(() => {
    if (step !== 'mount') return;
    const target = mountDir.trim();
    if (!target) {
      detectSeq.current += 1;
      setCandidates([]);
      setCandidateId('');
      setDetectNote('');
      setDetecting(false);
      return;
    }
    const timer = window.setTimeout(() => void runDetect(target), 400);
    return () => window.clearTimeout(timer);
  }, [mountDir, step, runDetect]);

  const onBrowseMount = async () => {
    setPicking(true);
    setError('');
    try {
      const dir = await pickProjectDirectory();
      if (dir) {
        setMountDir(dir);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPicking(false);
    }
  };

  const onMount = async () => {
    const dir = mountDir.trim();
    if (!dir) {
      setError('请先选择或填写项目目录');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const framework = candidates.find((item) => item.id === candidateId)?.id;
      const project = await addProject(dir, mountName.trim(), framework);
      showToast('已挂载项目', 'success');
      onCreated(project);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onBrowse = async () => {
    setPicking(true);
    setError('');
    try {
      const dir = await pickProjectDirectory();
      if (dir) {
        setParentDir(dir);
        setPreview(null);
        invalidateAudit();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPicking(false);
    }
  };

  const targetDir = useMemo(() => {
    const parent = parentDir.trim().replace(/\/+$/, '');
    const folder = name.trim();
    if (!parent || !folder) return '';
    return `${parent}/${folder
      .replace(/[\\/:*?"<>|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()}`;
  }, [parentDir, name]);

  const input = useMemo(
    () => ({
      stack: stackId,
      name: name.trim(),
      parentDir: parentDir.trim(),
      baseURL,
      options,
    }),
    [stackId, name, parentDir, baseURL, options],
  );

  /** 预览 / 生成都带上本次补丁，保证「检查里改过的」和「实际写出的」是同一份 */
  const inputWithSkeleton = useMemo(
    () => ({ ...input, ...(patchedSkeleton ? { skeleton: patchedSkeleton } : {}) }),
    [input, patchedSkeleton],
  );

  /** 跑一遍检查：平台体检 + AI 审骨架，日志实时进左栏 */
  const runAudit = useCallback(
    async (baseSkeleton: string | null) => {
      stopAudit();
      const controller = new AbortController();
      auditAbort.current = controller;
      const seq = ++auditSeq.current;
      setAuditRunning(true);
      setAuditElapsed(0);
      auditStartedAt.current = Date.now();
      setAuditLogs([]);
      setAuditFindings([]);
      setAuditResult(null);
      setAuditRaw('');
      setAuditStream('');
      setPicked({});
      setError('');
      // 模型配置可能还没从磁盘读回来（插件刚打开），先补一次
      if (!loadSettings()) {
        try {
          await hydrateAppConfig();
        } catch {
          // 读不到就当没配模型，只跑平台检查
        }
      }
      const result = await runScaffoldAudit(
        {
          stack: stackId,
          name: name.trim(),
          parentDir: parentDir.trim(),
          baseURL,
          options,
          skeleton: baseSkeleton,
        },
        loadSettings(),
        controller.signal,
        {
          onLog: (entry) => {
            if (seq !== auditSeq.current) return;
            setAuditLogs((prev) => [...prev, entry]);
          },
          onDelta: (delta) => {
            if (seq !== auditSeq.current) return;
            setAuditStream((prev) => `${prev}${delta}`.slice(-400));
          },
          onRaw: (text) => {
            if (seq !== auditSeq.current) return;
            setAuditRaw(text);
          },
        },
      );
      if (seq !== auditSeq.current) return;
      setAuditRunning(false);
      setAuditResult(result);
      setAuditFindings(result.findings);
      setAuditPromptReady(result.promptReady);
      setAuditRaw(result.raw);
      setAuditStream('');
      // 带补丁的建议默认勾上：多数人想「该补的都补」，不需要逐条点
      const next: Record<string, boolean> = {};
      for (const item of result.findings) {
        if (item.source === 'model' && item.patches.length) next[item.id] = true;
      }
      setPicked(next);
      if (result.error) setError(result.error);
    },
    [baseURL, name, options, parentDir, stackId, stopAudit],
  );

  /** 目标目录 → 检查步骤：只切页，检查由用户点「开始检查」触发 */
  const goAudit = useCallback(() => {
    if (!parentDir.trim()) {
      setError('请选择父目录');
      return;
    }
    if (!name.trim()) {
      setError('请填写项目名');
      return;
    }
    setError('');
    setStep('audit');
  }, [name, parentDir]);

  /** 检查页的「开始检查 / 重新检查」 */
  const startAudit = useCallback(() => {
    void runAudit(patchedSkeleton);
  }, [patchedSkeleton, runAudit]);

  // 关掉弹窗 / 卸载时中断在跑的 AI 分析，别让流继续写状态
  useEffect(() => () => stopAudit(), [stopAudit]);

  // 日志自动滚到底：用户不用手动追
  useEffect(() => {
    const box = logBoxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [auditLogs, auditStream]);

  // 运行中的已用时：日志里看不出「到底卡了多久」，这里给一个不停走的数
  useEffect(() => {
    if (!auditRunning) return;
    const timer = window.setInterval(() => {
      setAuditElapsed(Date.now() - auditStartedAt.current);
    }, 500);
    return () => window.clearInterval(timer);
  }, [auditRunning]);

  /** 应用勾选的补丁 → 复核 → 预览 */
  const applyAndPreview = useCallback(async () => {
    const chosen = auditFindings.filter(
      (item) => item.source === 'model' && picked[item.id] && item.patches.length,
    );
    const patches = chosen.flatMap((item) => item.patches);
    // 记录这次真正应用了哪几条（生成过程留档要标「已应用」）
    setAppliedIds(chosen.map((item) => item.id));
    // 始终从空间基线出发做一次完整应用：勾选是全量选择，不是「上一轮之上再叠加」
    const base = auditResult?.space?.raw ?? '';
    let nextSkeleton: string | null = null;
    if (patches.length) {
      if (!base.trim()) {
        setError('没读到空间骨架，无法应用补丁');
        return;
      }
      try {
        nextSkeleton = applySkeletonPatches(base, patches);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return;
      }
    }
    setBusy(true);
    setError('');
    const stamp = (level: AuditLogEntry['level'], text: string) =>
      setAuditLogs((prev) => [
        ...prev,
        { seq: prev.length + 1, at: Date.now(), stage: 'summary', level, text },
      ]);
    try {
      if (nextSkeleton) {
        stamp('info', `应用 ${patches.length} 个补丁，复核骨架…`);
        const recheck = await checkScaffold({ ...input, skeleton: nextSkeleton });
        const platformItems = platformFindings(recheck.checks);
        const modelItems = auditFindings.filter((item) => item.source === 'model');
        setAuditFindings([...platformItems, ...modelItems]);
        if (!recheck.ok) {
          stamp('error', `复核未通过：还有 ${recheck.summary.errors} 个必须处理`);
          setError(`补丁应用后仍有 ${recheck.summary.errors} 个必须处理，请看右侧`);
          return;
        }
        stamp('info', '复核通过，开始生成预览');
      } else {
        stamp('info', '没有选中补丁，按空间骨架继续');
      }
      const result = await previewScaffold({
        ...input,
        ...(nextSkeleton ? { skeleton: nextSkeleton } : {}),
      });
      setPatchedSkeleton(nextSkeleton);
      setPreview(result);
      setStep('preview');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [auditFindings, auditResult, input, picked]);

  /** 跳过检查直接预览：只在还没开始检查时可用（检查完就走「预览文件」那颗） */
  const skipAudit = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const result = await previewScaffold(inputWithSkeleton);
      setPreview(result);
      setStep('preview');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [inputWithSkeleton]);

  const onCreate = async () => {
    // 连点两下会发两次请求：第二次撞上「目录已非空」，界面反而报错；
    // 用 ref 挡住重复进入，busy 是异步更新的，拦不住同一帧的第二次点击
    if (creatingRef.current) return;
    creatingRef.current = true;
    setBusy(true);
    setError('');
    try {
      // 生成过程留档：把检查阶段的日志 / 建议 / 原始输出一并交给服务端，跟项目同一请求落盘。
      // 先在客户端按服务端同样的上限截断，避免模型输出过大把请求体顶到 1MB 上限。
      const record = auditResult
        ? {
            files: (preview?.files ?? []).slice(0, 5000),
            totalBytes: preview?.totalBytes ?? 0,
            logs: auditLogs.slice(-2000).map((entry) => ({
              seq: entry.seq,
              at: entry.at,
              stage: entry.stage,
              level: entry.level,
              text: entry.text.slice(0, 4000),
              ...(entry.detail ? { detail: entry.detail.slice(0, 8000) } : {}),
            })),
            findings: auditFindings.slice(0, 500).map((item) => ({
              id: item.id,
              level: item.level,
              title: item.title.slice(0, 400),
              detail: item.detail.slice(0, 8000),
              ...(item.file ? { file: item.file } : {}),
              source: item.source,
              patches: item.patches.slice(0, 200).map((patch) => ({
                action: patch.action,
                path: 'path' in patch && patch.path ? patch.path : '',
                ...('content' in patch
                  ? { bytes: new TextEncoder().encode(patch.content).length }
                  : {}),
              })),
            })),
            applied: appliedIds,
            promptReady: auditPromptReady,
            ok: auditResult.ok,
            error: auditResult.error,
            raw: auditResult.raw.slice(0, 200 * 1024),
            stats: auditResult.stats,
          }
        : null;
      const result = await createScaffoldProject({ ...inputWithSkeleton, record });
      writeViewText(PARENT_PREF, parentDir.trim());
      setCreated(result.project);
      setStep('result');
      showToast(
        record && !result.recordSaved
          ? '已生成并挂载项目，但生成过程未能留档'
          : '已生成基础框架并挂载项目',
        record && !result.recordSaved ? 'error' : 'success',
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      creatingRef.current = false;
      setBusy(false);
    }
  };

  const steps = stepOrderOf(mode);
  const stepIndex = steps.indexOf(step);
  const canNext =
    step === 'stack'
      ? Boolean(stack && stack.status === 'ready')
      : step === 'target'
        ? Boolean(parentDir.trim() && name.trim())
        : false;

  /* 检查步骤的派生值：右栏分组 + 底部按钮状态 */
  const platformIssues = auditFindings.filter((item) => item.source === 'platform');
  const modelFindings = auditFindings.filter((item) => item.source === 'model');
  const auditErrors = platformIssues.filter((item) => item.level === 'error');
  const pickedCount = modelFindings.filter((item) => picked[item.id] && item.patches.length).length;
  /** 方式页：悬停哪张卡片就显示那种方式的说明，没悬停时用一句总述 */
  const activeMode = step === 'mode' ? (hoverMode ?? mode) : mode;
  const subtitle =
    activeMode === 'mount'
      ? '目录里已经有测试代码？识别框架后直接挂载进来'
      : activeMode === 'scaffold'
        ? '还没有测试项目？按模板生成一套能直接跑的框架'
        : '两种方式都能把项目接进工作台，选一种开始';
  const changes = preview?.changes;
  const stepSubtitle =
    mode === 'mount'
      ? '选一个已有的 Playwright / pytest / Selenium 项目目录，识别到框架后挂载；不写任何文件。'
      : step === 'audit'
        ? '点「开始检查」后平台先查结构与选项一致性，再按「自动化项目提示词」让 AI 审一遍骨架；通过后点「预览文件」，勾选的建议只作用于本次生成。'
        : step === 'preview'
          ? '预览只列文件、不写磁盘；点底部「创建项目」才真正创建，关掉弹窗不会生成任何文件。'
          : step === 'result'
            ? '项目已经按骨架生成并挂载，可以直接进去跑用例。'
            : '用平台固定模板生成一套企业级基础框架，生成后自动挂载；不会装依赖，也不会改已有文件。';

  return (
    <Dialog open onClose={busy ? () => undefined : onClose} className="relative z-110">
      <DialogBackdrop
        transition
        className="tw-dialog-backdrop-anim fixed inset-0 bg-black/30"
        aria-hidden="true"
      />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel
          transition
          className={`tw-pop-dialog-anim flex max-h-[min(88vh,760px)] w-full max-w-3xl flex-col overflow-hidden rounded-xl border shadow-xl ${PANEL}`}
        >
          <div
            className={`relative shrink-0 px-5 ${
              step === 'mode' ? 'pt-4 pr-11 pb-2' : 'border-b border-[var(--tw-border)] py-4 pr-11'
            }`}
          >
            {/* 右上角关闭：每一步都能直接退出；写入中禁用，避免半途关掉 */}
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              aria-label="关闭"
              className="absolute top-3 right-3 flex h-7 w-7 items-center justify-center rounded-md text-sm text-(--tw-label-tertiary) transition-colors hover:bg-(--tw-session-hover-bg) hover:text-(--tw-label-primary) disabled:cursor-not-allowed disabled:opacity-40"
            >
              ✕
            </button>
            {/* 方式页不显示标题：上方只有一行会随悬停切换的说明 */}
            <DialogTitle
              className={step === 'mode' ? 'sr-only' : `text-base font-semibold ${TEXT_PRIMARY}`}
            >
              {mode === 'mount' ? '挂载项目' : '创建项目'}
            </DialogTitle>
            {step === 'mode' ? (
              <p
                key={activeMode ?? 'none'}
                className={`tw-fade-swap min-h-[20px] text-[13px] leading-5 ${TEXT_SECONDARY}`}
              >
                {subtitle}
              </p>
            ) : (
              <p className={`mt-1 text-xs leading-relaxed ${TEXT_SECONDARY}`}>{stepSubtitle}</p>
            )}
            {steps.length > 1 ? (
              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                {steps.map((item, index) => {
                  const done = index < stepIndex;
                  const current = item === step;
                  return (
                    <span
                      key={item}
                      className={`inline-flex h-6 items-center gap-1 rounded-md px-2 text-[11px] ${
                        current
                          ? 'bg-(--tw-accent-soft) text-(--tw-accent)'
                          : done
                            ? 'bg-(--tw-surface-recessed) text-(--tw-label-secondary)'
                            : 'bg-(--tw-surface-recessed) text-(--tw-label-tertiary)'
                      }`}
                    >
                      <span className="tabular-nums">{index + 1}</span>
                      {STEP_LABEL[item]}
                    </span>
                  );
                })}
              </div>
            ) : null}
          </div>

          <div
            className={`min-h-0 flex-1 overflow-auto px-5 ${step === 'mode' ? 'pt-0 pb-4' : 'py-4'}`}
          >
            {step === 'mode' ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => chooseMode('mount')}
                  onMouseEnter={() => setHoverMode('mount')}
                  onMouseLeave={() => setHoverMode(null)}
                  onFocus={() => setHoverMode('mount')}
                  onBlur={() => setHoverMode(null)}
                  className={`group flex min-h-[132px] flex-col items-start rounded-xl border px-4 py-3.5 text-left transition-all duration-150 ${
                    hoverMode === 'mount'
                      ? 'border-(--tw-accent) bg-(--tw-accent-soft) shadow-sm'
                      : 'border-(--tw-border) hover:border-(--tw-accent) hover:bg-(--tw-accent-soft) hover:shadow-sm'
                  }`}
                >
                  <span className="flex w-full items-center gap-2.5">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-(--tw-surface-recessed) text-(--tw-label-secondary) transition-colors group-hover:bg-(--tw-surface-panel) group-hover:text-(--tw-accent)">
                      <PmIcon name="folder" size={17} />
                    </span>
                    <span className={`min-w-0 flex-1 text-sm font-medium ${TEXT_PRIMARY}`}>
                      挂载本地项目
                    </span>
                    <PmIcon
                      name="chevronRight"
                      size={14}
                      className="shrink-0 text-(--tw-label-tertiary) opacity-0 transition-opacity group-hover:opacity-100"
                    />
                  </span>
                  <span className={`mt-2.5 block text-xs leading-relaxed ${TEXT_TERTIARY}`}>
                    选一个已有的 Playwright / pytest / Selenium 项目目录
                  </span>
                  <span className="mt-auto flex flex-wrap gap-1.5 pt-3">
                    <span className={CHIP_MUTED}>自动识别框架</span>
                    <span className={CHIP_MUTED}>不改动文件</span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => chooseMode('scaffold')}
                  onMouseEnter={() => setHoverMode('scaffold')}
                  onMouseLeave={() => setHoverMode(null)}
                  onFocus={() => setHoverMode('scaffold')}
                  onBlur={() => setHoverMode(null)}
                  className={`group flex min-h-[132px] flex-col items-start rounded-xl border px-4 py-3.5 text-left transition-all duration-150 ${
                    hoverMode === 'scaffold'
                      ? 'border-(--tw-accent) bg-(--tw-accent-soft) shadow-sm'
                      : 'border-(--tw-border) hover:border-(--tw-accent) hover:bg-(--tw-accent-soft) hover:shadow-sm'
                  }`}
                >
                  <span className="flex w-full items-center gap-2.5">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-(--tw-surface-recessed) text-(--tw-label-secondary) transition-colors group-hover:bg-(--tw-surface-panel) group-hover:text-(--tw-accent)">
                      <PmIcon name="plus" size={17} />
                    </span>
                    <span className={`min-w-0 flex-1 text-sm font-medium ${TEXT_PRIMARY}`}>
                      创建全新项目
                    </span>
                    <PmIcon
                      name="chevronRight"
                      size={14}
                      className="shrink-0 text-(--tw-label-tertiary) opacity-0 transition-opacity group-hover:opacity-100"
                    />
                  </span>
                  <span className={`mt-2.5 block text-xs leading-relaxed ${TEXT_TERTIARY}`}>
                    用平台模板生成一套企业级基础框架
                  </span>
                  <span className="mt-auto flex flex-wrap gap-1.5 pt-3">
                    <span className={CHIP_MUTED}>Playwright 模板</span>
                    <span className={CHIP_MUTED}>目标目录需为空</span>
                  </span>
                </button>
              </div>
            ) : null}

            {step === 'mount' ? (
              <div className="space-y-3">
                <label className="block">
                  <span className={`mb-1 block text-xs ${TEXT_SECONDARY}`}>项目目录</span>
                  <div className="flex items-center gap-2">
                    <input
                      className={INPUT}
                      value={mountDir}
                      onChange={(event) => setMountDir(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && mountDir.trim()) void onMount();
                      }}
                      placeholder="/Users/you/work/my-e2e"
                      spellCheck={false}
                      autoFocus
                    />
                    <button
                      type="button"
                      className={GHOST_BTN}
                      onClick={() => void onBrowseMount()}
                      disabled={picking}
                    >
                      <PmIcon name="folder" size={13} />
                      {picking ? '选择中…' : '浏览…'}
                    </button>
                  </div>
                </label>

                <label className="block">
                  <span className={`mb-1 block text-xs ${TEXT_SECONDARY}`}>项目名（可选）</span>
                  <input
                    className={INPUT}
                    value={mountName}
                    onChange={(event) => setMountName(event.target.value)}
                    placeholder="留空则用目录名"
                    spellCheck={false}
                  />
                </label>

                <div>
                  <span className={`mb-1 block text-xs ${TEXT_SECONDARY}`}>识别到的框架</span>
                  {detecting ? (
                    <p className={`text-[11px] ${TEXT_TERTIARY}`}>正在识别目录内容…</p>
                  ) : candidates.length ? (
                    <div className="space-y-1.5">
                      {candidates.map((item) => {
                        const active = item.id === candidateId;
                        return (
                          <button
                            key={item.id}
                            type="button"
                            onClick={() => setCandidateId(item.id)}
                            className={`flex w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors ${
                              active
                                ? 'border-(--tw-accent) bg-(--tw-accent-soft)'
                                : 'border-(--tw-border) hover:bg-(--tw-session-hover-bg)'
                            }`}
                          >
                            <span
                              className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                                active ? 'border-(--tw-accent)' : 'border-(--tw-border)'
                              }`}
                              aria-hidden="true"
                            >
                              {active ? (
                                <span className="h-2 w-2 rounded-full bg-(--tw-accent)" />
                              ) : null}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-1.5">
                                <span className={`text-sm ${TEXT_PRIMARY}`}>{item.label}</span>
                                {item.ready ? null : (
                                  <span className="text-[11px] text-amber-600">命令未就绪</span>
                                )}
                              </span>
                              <span
                                className={`mt-0.5 block truncate text-[11px] ${TEXT_TERTIARY}`}
                              >
                                {item.evidence.join(' · ') || '未命中证据'}
                              </span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <p className={`text-[11px] ${TEXT_TERTIARY}`}>
                      {detectNote || '选好目录后自动识别，也可以直接挂载（按默认框架）'}
                    </p>
                  )}
                </div>

                <p className={`text-[11px] ${TEXT_TERTIARY}`}>
                  挂载只登记目录与框架，不会写入或改写项目里的任何文件。
                </p>
              </div>
            ) : null}

            {step === 'stack' ? (
              <div className="space-y-2">
                {loadingStacks ? (
                  <p className={`text-xs ${TEXT_TERTIARY}`}>正在读取可用技术栈…</p>
                ) : (
                  stacks.map((item) => {
                    const disabled = item.status !== 'ready';
                    const active = item.id === stackId;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        disabled={disabled}
                        onClick={() => chooseStack(item)}
                        className={`flex w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors ${
                          active
                            ? 'border-(--tw-accent) bg-(--tw-accent-soft)'
                            : 'border-(--tw-border) hover:bg-(--tw-session-hover-bg)'
                        } ${disabled ? 'cursor-not-allowed opacity-55 hover:bg-transparent' : ''}`}
                      >
                        <span
                          className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                            active ? 'border-(--tw-accent)' : 'border-(--tw-border)'
                          }`}
                          aria-hidden="true"
                        >
                          {active ? (
                            <span className="h-2 w-2 rounded-full bg-(--tw-accent)" />
                          ) : null}
                        </span>
                        <span className="min-w-0">
                          <span className={`block text-sm ${TEXT_PRIMARY}`}>{item.label}</span>
                          <span className={`mt-0.5 block text-[11px] ${TEXT_TERTIARY}`}>
                            {item.hint}
                          </span>
                        </span>
                        {disabled ? (
                          <span className="ml-auto shrink-0 text-[11px] text-[var(--tw-label-tertiary)]">
                            规划中
                          </span>
                        ) : null}
                      </button>
                    );
                  })
                )}
              </div>
            ) : null}

            {step === 'target' ? (
              <div className="space-y-3">
                <label className="block">
                  <span className={`mb-1 block text-xs ${TEXT_SECONDARY}`}>父目录</span>
                  <div className="flex items-center gap-2">
                    <input
                      className={INPUT}
                      value={parentDir}
                      onChange={(event) => {
                        setParentDir(event.target.value);
                        setPreview(null);
                        invalidateAudit();
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') goAudit();
                      }}
                      placeholder="/Users/you/work"
                      spellCheck={false}
                      autoFocus={!parentDir.trim()}
                    />
                    <button
                      type="button"
                      className={GHOST_BTN}
                      onClick={() => void onBrowse()}
                      disabled={picking}
                    >
                      <PmIcon name="folder" size={13} />
                      {picking ? '选择中…' : '浏览…'}
                    </button>
                  </div>
                </label>

                <label className="block">
                  <span className={`mb-1 block text-xs ${TEXT_SECONDARY}`}>项目名</span>
                  <input
                    className={INPUT}
                    value={name}
                    onChange={(event) => {
                      setName(event.target.value);
                      setPreview(null);
                      invalidateAudit();
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') goAudit();
                    }}
                    placeholder="例如 web-e2e"
                    spellCheck={false}
                    autoFocus={Boolean(parentDir.trim())}
                  />
                  <span className={`mt-1 block text-[11px] ${TEXT_TERTIARY}`}>
                    {targetDir ? `将创建在 ${targetDir}` : '项目名会作为目录名'}
                  </span>
                </label>

                <label className="block">
                  <span className={`mb-1 block text-xs ${TEXT_SECONDARY}`}>
                    被测地址（可选，写入 .env.example）
                  </span>
                  <input
                    className={INPUT}
                    value={baseURL}
                    onChange={(event) => {
                      setBaseURL(event.target.value);
                      setPreview(null);
                      invalidateAudit();
                    }}
                    placeholder="https://your-app.example.com"
                    spellCheck={false}
                  />
                </label>

                {stack?.options.length ? (
                  <div>
                    <span className={`mb-1 block text-xs ${TEXT_SECONDARY}`}>附带内容</span>
                    <div className="space-y-1.5">
                      {stack.options.map((option) => (
                        <label
                          key={option.id}
                          className="flex cursor-pointer items-start gap-2 rounded-lg px-1 py-1 hover:bg-[var(--tw-session-hover-bg)]"
                        >
                          <input
                            type="checkbox"
                            className="mt-0.5"
                            checked={options.includes(option.id)}
                            onChange={() => toggleOption(option.id)}
                          />
                          <span className="min-w-0">
                            <span className={`block text-sm ${TEXT_PRIMARY}`}>{option.label}</span>
                            <span className={`block text-[11px] ${TEXT_TERTIARY}`}>
                              {option.hint}
                            </span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            {step === 'audit' ? (
              <div className="grid h-[min(52vh,400px)] gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
                {/* 左栏：实时日志（平台阶段 + AI 流式）。高度固定，日志在框内滚到底 */}
                <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-[var(--tw-border)]">
                  <div className="flex shrink-0 items-center gap-2 border-b border-[var(--tw-border)] px-2.5 py-2">
                    <span className={`text-xs font-medium ${TEXT_PRIMARY}`}>生成过程</span>
                    {auditRunning ? (
                      <span className="inline-flex items-center gap-1 text-[11px] text-(--tw-accent)">
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-(--tw-accent)" />
                        运行中
                      </span>
                    ) : (
                      <span className={`text-[11px] ${TEXT_TERTIARY}`}>
                        {auditResult ? '已完成' : '未开始'}
                      </span>
                    )}
                    <span className={`ml-auto text-[11px] tabular-nums ${TEXT_TERTIARY}`}>
                      {auditRunning
                        ? `${(auditElapsed / 1000).toFixed(1)}s`
                        : auditResult
                          ? `${(auditResult.stats.ms / 1000).toFixed(1)}s${
                              auditResult.stats.firstTokenMs
                                ? ` · 首字 ${(auditResult.stats.firstTokenMs / 1000).toFixed(1)}s`
                                : ''
                            }`
                          : ''}
                    </span>
                  </div>
                  <div
                    ref={logBoxRef}
                    className="min-h-0 flex-1 space-y-1 overflow-auto px-2.5 py-2 font-mono text-[11px] leading-5"
                  >
                    {auditLogs.length === 0 ? (
                      <p className={`font-sans ${TEXT_TERTIARY}`}>
                        {auditRunning
                          ? '准备中…'
                          : '点下面的「开始检查」开始，检查过程中可以随时停止。'}
                      </p>
                    ) : (
                      auditLogs.map((entry) => (
                        <div key={entry.seq} className="flex gap-1.5">
                          <span className="shrink-0 text-[var(--tw-label-tertiary)]">
                            {new Date(entry.at).toLocaleTimeString('zh-CN', { hour12: false })}
                          </span>
                          <span className="shrink-0 text-[var(--tw-label-tertiary)]">
                            [{AUDIT_STAGE_LABEL[entry.stage] ?? entry.stage}]
                          </span>
                          <span
                            className={`min-w-0 flex-1 break-words ${
                              entry.level === 'error'
                                ? 'text-red-600'
                                : entry.level === 'warn'
                                  ? 'text-amber-600'
                                  : TEXT_SECONDARY
                            }`}
                          >
                            {entry.text}
                          </span>
                        </div>
                      ))
                    )}
                    {auditRunning && auditStream ? (
                      <div className="flex gap-1.5">
                        <span className="shrink-0 text-[var(--tw-label-tertiary)]">[AI 分析]</span>
                        <span
                          className={`min-w-0 flex-1 whitespace-pre-wrap break-words ${TEXT_TERTIARY}`}
                        >
                          …{auditStream}
                          <span className="ml-0.5 inline-block h-3 w-1 animate-pulse bg-(--tw-accent) align-middle" />
                        </span>
                      </div>
                    ) : null}
                  </div>
                  <div className="shrink-0 border-t border-[var(--tw-border)] px-2.5 py-1.5">
                    <button
                      type="button"
                      className={`inline-flex items-center gap-1 text-[11px] ${TEXT_SECONDARY} transition-colors hover:text-(--tw-label-primary)`}
                      onClick={() => setShowRaw((prev) => !prev)}
                      disabled={!auditRaw}
                    >
                      <PmIcon name={showRaw ? 'chevronDown' : 'chevronRight'} size={12} />
                      AI 原始输出
                      <span className={TEXT_TERTIARY}>
                        {auditRaw ? `${auditRaw.length} 字符` : '（无）'}
                      </span>
                    </button>
                    {showRaw && auditRaw ? (
                      <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded-md bg-(--tw-surface-recessed) p-2 text-[10px] leading-4 text-(--tw-label-secondary)">
                        {auditRaw}
                      </pre>
                    ) : null}
                  </div>
                </div>

                {/* 右栏：完整性检查 + 建议补全 */}
                <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-[var(--tw-border)]">
                  <div className="flex shrink-0 items-center gap-2 border-b border-[var(--tw-border)] px-2.5 py-2">
                    <span className={`text-xs font-medium ${TEXT_PRIMARY}`}>完整性检查</span>
                    {auditErrors.length ? (
                      <span className="rounded bg-red-50 px-1.5 text-[10px] text-red-600">
                        {auditErrors.length} 个必须处理
                      </span>
                    ) : auditResult ? (
                      <span className="rounded bg-emerald-50 px-1.5 text-[10px] text-emerald-700">
                        结构通过
                      </span>
                    ) : null}
                  </div>
                  <div className="min-h-0 flex-1 space-y-3 overflow-auto px-2.5 py-2">
                    {platformIssues.length === 0 && modelFindings.length === 0 ? (
                      <p className={`text-[11px] ${TEXT_TERTIARY}`}>
                        {auditRunning
                          ? '正在检查…'
                          : auditResult
                            ? '没有发现问题。'
                            : '还没开始检查。'}
                      </p>
                    ) : null}

                    {platformIssues.length ? (
                      <div className="space-y-1.5">
                        {platformIssues.map((item) => (
                          <div
                            key={item.id}
                            className={`rounded-lg border px-2 py-1.5 ${
                              item.level === 'error'
                                ? 'border-red-200 bg-red-50/60'
                                : 'border-[var(--tw-border)]'
                            }`}
                          >
                            <div className="flex items-start gap-1.5">
                              <span
                                className={`mt-0.5 shrink-0 text-[10px] font-medium ${
                                  item.level === 'error'
                                    ? 'text-red-600'
                                    : item.level === 'warn'
                                      ? 'text-amber-600'
                                      : TEXT_TERTIARY
                                }`}
                              >
                                {item.level === 'error'
                                  ? '必须'
                                  : item.level === 'warn'
                                    ? '提示'
                                    : '说明'}
                              </span>
                              <div className="min-w-0 flex-1">
                                <p className={`text-[12px] leading-4 ${TEXT_PRIMARY}`}>
                                  {item.title}
                                </p>
                                <p className={`mt-0.5 text-[11px] leading-4 ${TEXT_TERTIARY}`}>
                                  {item.detail}
                                </p>
                                {item.file ? (
                                  <p className="mt-0.5 truncate font-mono text-[10px] text-(--tw-label-tertiary)">
                                    {item.file}
                                  </p>
                                ) : null}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : null}

                    {modelFindings.length ? (
                      <div className="space-y-1.5">
                        <div className="flex items-center gap-2">
                          <span className={`text-[11px] font-medium ${TEXT_SECONDARY}`}>
                            建议补全
                          </span>
                          <span className={`text-[10px] ${TEXT_TERTIARY}`}>
                            带补丁的可勾选，只改本次生成
                          </span>
                        </div>
                        {modelFindings.map((item) => {
                          const selectable = item.patches.length > 0;
                          const targets = patchTargets(item.patches);
                          // 没有补丁的建议是纯提示（勾了也没内容可应用）：不给勾选框，标成「仅提示」
                          const Wrapper: 'label' | 'div' = selectable ? 'label' : 'div';
                          return (
                            <Wrapper
                              key={item.id}
                              className={`flex items-start gap-2 rounded-lg border px-2 py-1.5 ${
                                picked[item.id]
                                  ? 'border-(--tw-accent) bg-(--tw-accent-soft)'
                                  : 'border-[var(--tw-border)]'
                              } ${selectable ? 'cursor-pointer' : ''}`}
                            >
                              {selectable ? (
                                <input
                                  type="checkbox"
                                  className="mt-0.5 shrink-0"
                                  checked={Boolean(picked[item.id])}
                                  disabled={busy || auditRunning}
                                  onChange={() =>
                                    setPicked((prev) => ({ ...prev, [item.id]: !prev[item.id] }))
                                  }
                                />
                              ) : (
                                <span className="mt-0.5 shrink-0 rounded bg-(--tw-surface-recessed) px-1 text-[10px] leading-4 text-(--tw-label-tertiary)">
                                  仅提示
                                </span>
                              )}
                              <span className="min-w-0 flex-1">
                                <span className="flex items-center gap-1.5">
                                  <span
                                    className={`text-[10px] ${
                                      item.level === 'error'
                                        ? 'text-red-600'
                                        : item.level === 'warn'
                                          ? 'text-amber-600'
                                          : TEXT_TERTIARY
                                    }`}
                                  >
                                    {item.level === 'error'
                                      ? '必须'
                                      : item.level === 'warn'
                                        ? '建议'
                                        : '可选'}
                                  </span>
                                  <span className={`text-[12px] leading-4 ${TEXT_PRIMARY}`}>
                                    {item.title}
                                  </span>
                                </span>
                                {item.detail ? (
                                  <span
                                    className={`mt-0.5 block text-[11px] leading-4 ${TEXT_TERTIARY}`}
                                  >
                                    {item.detail}
                                  </span>
                                ) : null}
                                {targets.length ? (
                                  <span className="mt-1 flex flex-wrap gap-1">
                                    {targets.map((target) => (
                                      <span
                                        key={target}
                                        className="rounded bg-(--tw-surface-recessed) px-1 font-mono text-[10px] text-(--tw-label-secondary)"
                                      >
                                        {target}
                                      </span>
                                    ))}
                                  </span>
                                ) : (
                                  <span className={`mt-1 block text-[10px] ${TEXT_TERTIARY}`}>
                                    只描述问题，没有可直接应用的改动
                                  </span>
                                )}
                              </span>
                            </Wrapper>
                          );
                        })}
                      </div>
                    ) : null}

                    {!auditPromptReady && auditResult ? (
                      <p className="rounded-lg bg-amber-50 px-2 py-1.5 text-[11px] leading-4 text-amber-700">
                        没读到「提示词管理 /
                        自动化项目提示词.md」，本次只做了平台检查；在「提示词管理」里补一份再重跑即可。
                      </p>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : null}

            {step === 'preview' && preview ? (
              <div className="space-y-3">
                <div className="rounded-lg bg-(--tw-surface-recessed) px-3 py-2 text-[11px] text-(--tw-label-secondary)">
                  <span className="break-all font-mono">{preview.dir}</span>
                  <span className={`ml-2 ${TEXT_TERTIARY}`}>
                    {preview.files.length} 个文件 · {formatBytes(preview.totalBytes)}
                  </span>
                  {preview.skeletonSource === 'custom' ? (
                    <span className="ml-2 rounded bg-(--tw-accent-soft) px-1.5 text-[10px] text-(--tw-accent)">
                      已应用本次检查的建议
                    </span>
                  ) : null}
                </div>
                {changes ? (
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                    <span className="rounded bg-emerald-50 px-1.5 text-emerald-700">
                      新增 {changes.created}
                    </span>
                    <span className="rounded bg-amber-50 px-1.5 text-amber-700">
                      更新 {changes.changed}
                    </span>
                    <span className={`rounded bg-(--tw-surface-recessed) px-1.5 ${TEXT_TERTIARY}`}>
                      未变 {changes.same}
                    </span>
                    <span className={`ml-auto ${TEXT_TERTIARY}`}>
                      只写「新增 / 更新」的文件，覆盖前自动备份
                    </span>
                  </div>
                ) : null}
                <div className="flex items-center gap-2">
                  <span className={`text-[11px] ${TEXT_TERTIARY}`}>
                    按骨架目录结构分组，点目录可收起
                  </span>
                  <button
                    type="button"
                    className={`ml-auto text-[11px] ${TEXT_SECONDARY} transition-colors hover:text-(--tw-label-primary)`}
                    onClick={() => setCollapsedDirs({})}
                  >
                    全部展开
                  </button>
                </div>
                <UiAutoPreviewTree
                  nodes={previewTree}
                  collapsed={collapsedDirs}
                  onToggle={(path) =>
                    setCollapsedDirs((prev) => ({ ...prev, [path]: !prev[path] }))
                  }
                />
                <p className={`text-[11px] ${TEXT_TERTIARY}`}>
                  {changes
                    ? '这一步只读不写；点「创建项目」才会改动标了「新增 / 更新」的文件，覆盖前备份到空间内的 .lantern/local/uiauto-scaffold/backup/。'
                    : '这一步只读不写：关掉弹窗不会生成任何文件。点「创建项目」才真正写到磁盘；目标目录必须不存在或为空。'}
                </p>
              </div>
            ) : null}

            {step === 'result' && created ? (
              <div className="space-y-3">
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800">
                  已生成并挂载「{created.name}」
                </div>
                <p className={`text-[11px] ${TEXT_TERTIARY}`}>
                  项目目录：<span className="font-mono">{created.dir}</span>
                </p>
                <UiAutoSetupPanel projectId={created.id} plan={created.setupPlan ?? []} />
                {created.hasGenerationRecord ? (
                  <button
                    type="button"
                    className={`inline-flex items-center gap-1 text-[11px] ${TEXT_SECONDARY} transition-colors hover:text-(--tw-label-primary)`}
                    onClick={() => setGenerationOpen(true)}
                  >
                    <PmIcon name="file" size={12} />
                    查看生成过程
                  </button>
                ) : null}
              </div>
            ) : null}

            {error ? (
              <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-600">
                {error}
              </p>
            ) : null}
          </div>

          {step === 'mode' ? null : (
            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--tw-border)] px-5 py-3">
              {step === 'mount' ? (
                <button
                  type="button"
                  className={GHOST_BTN}
                  onClick={() => {
                    setStep('mode');
                    setError('');
                  }}
                  disabled={busy}
                >
                  上一步
                </button>
              ) : null}

              {step === 'target' ? (
                <button
                  type="button"
                  className={GHOST_BTN}
                  onClick={() => setStep('stack')}
                  disabled={busy}
                >
                  上一步
                </button>
              ) : null}

              {step === 'preview' ? (
                <button
                  type="button"
                  className={GHOST_BTN}
                  onClick={() => setStep('audit')}
                  disabled={busy}
                >
                  上一步
                </button>
              ) : null}

              {step === 'stack' ? (
                <button
                  type="button"
                  className={GHOST_BTN}
                  onClick={() => {
                    setStep('mode');
                    setError('');
                  }}
                >
                  上一步
                </button>
              ) : null}

              {step === 'mount' ? (
                <button
                  type="button"
                  className={PRIMARY_BTN}
                  onClick={() => void onMount()}
                  disabled={busy || !mountDir.trim()}
                >
                  {busy ? '挂载中…' : '挂载项目'}
                </button>
              ) : null}

              {step === 'stack' ? (
                <button
                  type="button"
                  className={PRIMARY_BTN}
                  onClick={() => setStep('target')}
                  disabled={!canNext}
                >
                  下一步
                </button>
              ) : null}

              {step === 'target' ? (
                <button
                  type="button"
                  className={PRIMARY_BTN}
                  onClick={goAudit}
                  disabled={!canNext || busy}
                >
                  下一步
                </button>
              ) : null}

              {step === 'audit' ? (
                <>
                  <button
                    type="button"
                    className={GHOST_BTN}
                    onClick={() => {
                      stopAudit();
                      setStep('target');
                    }}
                    disabled={busy}
                  >
                    上一步
                  </button>
                  {/*
                    底部只留「上一步 + 次要动作 + 主操作」三颗：
                    - 未检查：跳过检查（次要） + 开始检查（主）
                    - 检查中：停止检查（次要） + 检查中…（主，禁用）
                    - 通过：重新检查（次要） + 预览（主）
                    - 有必须处理：重新检查（次要） + 先处理（主，禁用）
                    「跳过检查」只在还没检查时存在，检查过之后它就是错的文案。
                  */}
                  {auditRunning ? (
                    <button type="button" className={GHOST_BTN} onClick={stopAudit}>
                      停止检查
                    </button>
                  ) : auditResult ? (
                    <button
                      type="button"
                      className={GHOST_BTN}
                      onClick={startAudit}
                      disabled={busy}
                    >
                      重新检查
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={GHOST_BTN}
                      onClick={() => void skipAudit()}
                      disabled={busy}
                    >
                      跳过检查，直接预览
                    </button>
                  )}
                  {auditRunning ? (
                    <button type="button" className={PRIMARY_BTN} disabled>
                      检查中…
                    </button>
                  ) : auditErrors.length ? (
                    <button
                      type="button"
                      className={PRIMARY_BTN}
                      disabled
                      // 必须处理的问题不解决，服务端也会拦下预览；这里先挡住，别让人白点
                    >
                      先处理 {auditErrors.length} 个必须处理
                    </button>
                  ) : auditResult ? (
                    <button
                      type="button"
                      className={PRIMARY_BTN}
                      onClick={() => void applyAndPreview()}
                      disabled={busy}
                    >
                      {busy
                        ? '生成预览…'
                        : pickedCount
                          ? `应用 ${pickedCount} 条建议并预览`
                          : '预览文件'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={PRIMARY_BTN}
                      onClick={startAudit}
                      disabled={busy}
                    >
                      开始检查
                    </button>
                  )}
                </>
              ) : null}

              {step === 'preview' ? (
                <button
                  type="button"
                  className={PRIMARY_BTN}
                  onClick={() => void onCreate()}
                  disabled={busy || (changes ? changes.created + changes.changed === 0 : false)}
                >
                  {busy
                    ? '创建中…'
                    : changes
                      ? changes.created + changes.changed
                        ? `创建项目（${changes.created + changes.changed} 处变更）`
                        : '已是最新'
                      : `创建项目（${preview?.files.length ?? 0} 个文件）`}
                </button>
              ) : null}

              {step === 'result' && created ? (
                <>
                  <button
                    type="button"
                    className={GHOST_BTN}
                    onClick={() => {
                      void revealPath({ projectId: created.id, path: '' }).catch(() => undefined);
                    }}
                  >
                    <PmIcon name="folder" size={13} />
                    打开目录
                  </button>
                  <button type="button" className={PRIMARY_BTN} onClick={() => onCreated(created)}>
                    进入项目
                  </button>
                </>
              ) : null}
            </div>
          )}
        </DialogPanel>
      </div>
      {generationOpen && created ? (
        <UiAutoGenerationDialog
          project={created}
          onClose={() => setGenerationOpen(false)}
          onSetupFinished={() => {
            void fetchProjects()
              .then((data) => {
                const next = data.projects.find((item) => item.id === created.id);
                if (next) setCreated(next);
              })
              .catch(() => undefined);
          }}
        />
      ) : null}
    </Dialog>
  );
}
