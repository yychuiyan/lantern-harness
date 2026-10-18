/**
 * storage-domain：列举空间元数据目录下已知存储域（`.lantern/local` 子集）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { LOCAL_REL } from '../builtin/session/space-layout.mjs';

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
  { id: 'todos', rel: `${LOCAL_REL}/todos.json`, kind: 'file', roleZh: '待办事项' },
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
 * @param {string} root
 */
export function listStorageDomains(root) {
  const base = path.resolve(root);
  return KNOWN_STORAGE_DOMAINS.map((d) => {
    const abs = path.join(base, d.rel);
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
      path: d.rel,
      kind: d.kind,
      roleZh: d.roleZh,
      exists,
      /** 文件为字节；目录为条目数 */
      size: bytes,
      mtime,
    };
  });
}
