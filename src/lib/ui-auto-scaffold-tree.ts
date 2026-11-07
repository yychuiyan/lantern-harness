/**
 * 创建 / 修改项目预览：把平铺的文件清单按骨架目录结构折成树。
 *
 * 预览来自 `/scaffold/preview` 的 `files[]`（路径 + 体积，修改项目还带 status），
 * 这里只做分组与排序，不改动清单本身。
 */

/** `keep` 是「保留旧文件、本次不写」，既不算新增也不算变更 */
export type PreviewStatus = 'new' | 'changed' | 'same' | 'keep';

export interface PreviewNode {
  name: string;
  /** 相对项目根的路径，目录也带全路径（折叠状态按它记） */
  path: string;
  dir: boolean;
  /** 文件体积；目录上恒为 0，显示时用 `subtreeStats` 汇总 */
  bytes: number;
  /** 修改项目时文件的状态；目录上表示子树里是否有变更 */
  status?: PreviewStatus;
  children: PreviewNode[];
}

/** 平铺的文件清单 → 目录树；同层目录在前、文件在后，各自按名字排 */
export function buildPreviewTree(
  files: Array<{ path: string; bytes: number; status?: PreviewStatus }>,
): PreviewNode[] {
  const root: PreviewNode = { name: '', path: '', dir: true, bytes: 0, children: [] };
  for (const file of files) {
    const parts = file.path.replace(/\\/g, '/').split('/').filter(Boolean);
    let cursor = root;
    parts.forEach((part, index) => {
      const path = parts.slice(0, index + 1).join('/');
      const last = index === parts.length - 1;
      if (last) {
        cursor.children.push({
          name: part,
          path,
          dir: false,
          bytes: file.bytes,
          status: file.status,
          children: [],
        });
        return;
      }
      let next = cursor.children.find((child) => child.dir && child.name === part);
      if (!next) {
        next = { name: part, path, dir: true, bytes: 0, children: [] };
        cursor.children.push(next);
      }
      cursor = next;
    });
  }
  const sort = (nodes: PreviewNode[]) => {
    nodes.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    for (const node of nodes) if (node.children.length) sort(node.children);
    return nodes;
  };
  return sort(root.children);
}

/** 目录行右侧的汇总：递归数文件与体积，不用展开也能知道这个目录有多少东西 */
export function subtreeStats(node: PreviewNode): { files: number; bytes: number; changed: number } {
  if (!node.dir) {
    const changing = node.status === 'new' || node.status === 'changed';
    return { files: 1, bytes: node.bytes, changed: changing ? 1 : 0 };
  }
  return node.children.reduce(
    (acc, child) => {
      const next = subtreeStats(child);
      return {
        files: acc.files + next.files,
        bytes: acc.bytes + next.bytes,
        changed: acc.changed + next.changed,
      };
    },
    { files: 0, bytes: 0, changed: 0 },
  );
}
