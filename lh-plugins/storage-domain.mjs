/**
 * storage-domain：列举空间元数据目录下已知存储域（`.lantern/local` 子集）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { LOCAL_REL, resolveContentRoot } from '../builtin/session/space-layout.mjs';
import {
  TASK_DIR_NAME,
  TASK_STORE_FILE,
  TODO_DIR_NAME,
  TODO_STORE_FILE,
} from './lh-work-store.mjs';
import {
  CASE_EXEC_DIR_NAME,
  CASE_EXEC_STORE_FILE,
  TEST_STATS_DIR_NAME,
  TEST_STATS_STORE_FILE,
} from './lh-stats.mjs';
import { UIAUTO_DIR_NAME, UIAUTO_STORE_FILE } from './lh-uiauto.mjs';

/** @type {Array<{ id: string, rel: string, kind: 'file' | 'dir', roleZh: string }>} */
export const KNOWN_STORAGE_DOMAINS = [
  { id: 'sessions', rel: `${LOCAL_REL}/sessions.json`, kind: 'file', roleZh: '会话真相源' },
  {
    id: 'sessions-jsonl',
    rel: `${LOCAL_REL}/sessions.jsonl`,
    kind: 'file',
    roleZh: '会话 JSONL 审计',
  },
  {
    id: 'session-query',
    rel: `${LOCAL_REL}/session-query.sqlite`,
    kind: 'file',
    roleZh: '会话检索索引',
  },
  { id: 'checkpoints', rel: `${LOCAL_REL}/checkpoints`, kind: 'dir', roleZh: '会话检查点' },
  {
    id: 'session-log',
    rel: `${LOCAL_REL}/session-log`,
    kind: 'dir',
    roleZh: 'DeepSeek 形态回合日志',
  },
  { id: 'schedules', rel: `${LOCAL_REL}/schedules.json`, kind: 'file', roleZh: '主机定时提醒' },
  { id: 'spill', rel: `${LOCAL_REL}/spill`, kind: 'dir', roleZh: '工具结果溢出' },
  { id: 'memories', rel: `${LOCAL_REL}/memories`, kind: 'dir', roleZh: '会话记忆' },
  { id: 'todos', rel: `${TODO_DIR_NAME}/${TODO_STORE_FILE}`, kind: 'file', roleZh: '待办事项' },
  { id: 'tasks', rel: `${TASK_DIR_NAME}/${TASK_STORE_FILE}`, kind: 'file', roleZh: '任务管理' },
  {
    id: 'testStats',
    rel: `${TEST_STATS_DIR_NAME}/${TEST_STATS_STORE_FILE}`,
    kind: 'file',
    roleZh: '测试统计',
  },
  {
    id: 'caseExec',
    rel: `${CASE_EXEC_DIR_NAME}/${CASE_EXEC_STORE_FILE}`,
    kind: 'file',
    roleZh: '用例执行统计',
  },
  {
    id: 'uiAuto',
    rel: `${UIAUTO_DIR_NAME}/${UIAUTO_STORE_FILE}`,
    kind: 'file',
    roleZh: '自动化测试项目与运行记录',
  },
  {
    id: 'reports',
    rel: `${LOCAL_REL}/reports.json`,
    kind: 'file',
    roleZh: '工作汇报开关与提示词选择',
  },
  { id: 'workspaces', rel: `${LOCAL_REL}/workspaces.json`, kind: 'file', roleZh: '工作区注册表' },
  {
    id: 'app-config',
    rel: `${LOCAL_REL}/app.config.json`,
    kind: 'file',
    roleZh: '本机应用配置（不含模型）',
  },
  { id: 'case-suites', rel: `${LOCAL_REL}/case-suites.json`, kind: 'file', roleZh: '用例套件' },
  { id: 'case-sessions', rel: `${LOCAL_REL}/case-sessions.json`, kind: 'file', roleZh: '用例会话' },
];

/**
 * 待办 / 任务目录会跟着侧栏分组搬进分组文件夹，列清单时按实际位置算相对路径。
 * @type {Record<string, { dir: string, file: string }>}
 */
const RELOCATABLE = {
  todos: { dir: TODO_DIR_NAME, file: TODO_STORE_FILE },
  tasks: { dir: TASK_DIR_NAME, file: TASK_STORE_FILE },
  testStats: { dir: TEST_STATS_DIR_NAME, file: TEST_STATS_STORE_FILE },
  caseExec: { dir: CASE_EXEC_DIR_NAME, file: CASE_EXEC_STORE_FILE },
};

function domainRel(base, d) {
  const spec = RELOCATABLE[d.id];
  if (!spec) return d.rel;
  const abs = path.join(resolveContentRoot(base, spec.dir).abs, spec.file);
  return path.relative(base, abs).split(path.sep).join('/');
}

/**
 * @param {string} root
 */
export function listStorageDomains(root) {
  const base = path.resolve(root);
  return KNOWN_STORAGE_DOMAINS.map((d) => {
    const rel = domainRel(base, d);
    const abs = path.join(base, rel);
    let exists = false;
    let bytes = 0;
    let mtime = null;
    try {
      if (fs.existsSync(abs)) {
        const st = fs.statSync(abs);
        exists = true;
        bytes = st.isFile() ? st.size : 0;
        if (st.isDirectory()) {
          try {
            bytes = fs.readdirSync(abs).length;
          } catch {
            bytes = 0;
          }
        }
        mtime = st.mtime.toISOString();
      }
    } catch {
      // ignore
    }
    return {
      id: d.id,
      path: rel,
      kind: d.kind,
      roleZh: d.roleZh,
      exists,
      /** 文件为字节；目录为条目数 */
      size: bytes,
      mtime,
    };
  });
}
