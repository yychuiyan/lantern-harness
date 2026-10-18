/**
 * 数据空间注册表 / 文件操作 / zip 往返 的单测。
 *
 * 通过 XDG_CONFIG_HOME 隔离注册表落盘位置，避免污染真实的 ~/.config。
 *
 * ⚠️ 必须在 Node >= 22.22 下跑：低版本的 node:test 不执行顶层 before/after，
 * 隔离用的临时目录取不到，测试会直接在仓库的「空间池」里建夹具目录。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  PUBLIC_SPACE_ID,
  PUBLIC_SPACE_LABEL,
  PUBLIC_SPACE_NAME,
  SPACE_MANIFEST_FILE,
  assertLooksLikeSpace,
  copyDirSync,
  copySpace,
  createSpace,
  discoverSpaces,
  exportSpaceToZip,
  getActiveSpaceId,
  importSpaceFromZip,
  listSpaces,
  readSpaceManifest,
  removeSpace,
  renameSpace,
  resolveSpace,
  sanitizeSpaceName,
  setActiveSpace,
  writeSpaceManifest,
} from '../../cli/spaces.mjs';
import {
  __resetSpaceContext,
  ensureSpaceContext,
  getDataRoot,
  publicSpacePath,
  setActiveRoot,
} from '../../builtin/session/space-context.mjs';
import { displaySpacePath, SPACE_POOL_DIR } from '../../builtin/session/space-layout.mjs';
import {
  ensureContentDirs,
  prepareExternalSpaceDir,
  prepareSpaceDir,
  prepareSpacesRoot,
  writeSpaceSystemPrompt,
} from '../../cli/data-root.mjs';
import { DOC_ROOT_DIRS, isContentRootEnabled } from '../../lh-plugins/lh-project-docs.mjs';

// 低版本 node:test 不执行顶层 before/after：临时目录取不到，会直接写进仓库的「空间池」。
// 在模块加载阶段就失败，宁可测试红，也不要污染真实数据。
const [NODE_MAJOR, NODE_MINOR] = process.versions.node.split('.').map(Number);
if (NODE_MAJOR < 22 || (NODE_MAJOR === 22 && NODE_MINOR < 22)) {
  throw new Error(
    `spaces.test.ts 需要 Node >= 22.22（当前 ${process.version}），否则会污染真实空间池`,
  );
}

const ORIGINAL_XDG = process.env.XDG_CONFIG_HOME;

interface Space {
  id: string;
  name: string;
  path: string;
}

/** 断言操作成功并取出 space（JS 模块推断出的类型不精确，这里统一收口） */
function okSpace(res: unknown): Space {
  const r = res as { ok: boolean; space?: Space; error?: string };
  assert.equal(r.ok, true, r.error ?? '操作应当成功');
  const space = r.space;
  assert.ok(space, '成功时应当返回 space');
  return space;
}

let home = '';
let base = '';
let managed = '';

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-spaces-home-'));
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-spaces-base-'));
  managed = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-spaces-managed-'));
  process.env.XDG_CONFIG_HOME = home;
  // 公共空间是 base 下的一个文件夹，需要先铺出来，否则 resolveSpace('public') 会判目录不存在
  prepareSpacesRoot(base);
});

after(() => {
  if (ORIGINAL_XDG === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = ORIGINAL_XDG;
  for (const d of [home, base, managed]) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

beforeEach(() => {
  // 每个用例从空注册表开始，但保留隔离的 XDG 目录
  fs.rmSync(path.join(home, 'lantern-harness', 'spaces.json'), { force: true });
});

describe('sanitizeSpaceName 输入校验', () => {
  it('拒绝空名、路径分隔符、点开头、内建名与保留名', () => {
    const bad = [
      '',
      '   ',
      'a/b',
      'a\\b',
      '..evil',
      '.hidden',
      PUBLIC_SPACE_NAME,
      PUBLIC_SPACE_LABEL,
      '公共空间(默认)',
      'config',
      '.local',
      '.lantern',
      '.tb',
      SPACE_POOL_DIR,
      'public',
    ];
    for (const name of bad) {
      const r = sanitizeSpaceName(name) as { ok: boolean; error?: string };
      assert.equal(r.ok, false, `应当拒绝：${JSON.stringify(name)}`);
      assert.ok(r.error, '拒绝时应给出原因');
    }
  });

  it('剔除控制字符并 trim，但不改变正常名称', () => {
    const r = sanitizeSpaceName('  项目\u0000A\n ') as { ok: boolean; name?: string };
    assert.equal(r.ok, true);
    assert.equal(r.name, '项目A');
  });

  it('超长名称被拒绝', () => {
    assert.equal((sanitizeSpaceName('x'.repeat(41)) as { ok: boolean }).ok, false);
  });

  it('接受常见中文与 ASCII 名称', () => {
    for (const good of ['项目A', 'Project-A', 'a.b', '研发_1']) {
      const r = sanitizeSpaceName(good) as { ok: boolean; name?: string };
      assert.equal(r.ok, true, `应当接受：${good}`);
      assert.equal(r.name, good);
    }
  });
});

describe('listSpaces / resolveSpace', () => {
  it('公共空间是内建虚拟项，路径为「空间父目录/公共空间」，且不落盘到注册表', () => {
    const listed = listSpaces(base);
    assert.equal(listed.spaces.length, 1);
    const pub = listed.spaces[0]!;
    assert.equal(pub.id, PUBLIC_SPACE_ID);
    assert.equal(pub.name, PUBLIC_SPACE_NAME);
    assert.equal(pub.path, publicSpacePath(base));
    assert.equal(path.basename(pub.path), '公共空间');
    assert.equal(path.resolve(path.dirname(pub.path)), path.resolve(base));
    assert.equal(pub.isPublic, true);
    assert.equal(pub.isActive, true);
    assert.equal(pub.exists, true);

    // 公共空间是虚拟项，不该写入注册表文件
    const fp = path.join(home, 'lantern-harness', 'spaces.json');
    if (fs.existsSync(fp)) {
      const reg = JSON.parse(fs.readFileSync(fp, 'utf8')) as { spaces: unknown[] };
      assert.equal(reg.spaces.length, 0);
    }
  });

  it('支持按 id 或名称解析，目录缺失时拒绝解析', () => {
    const space = okSpace(
      createSpace({ name: '按名解析', managedParent: managed, baseRoot: base }),
    );

    assert.equal((resolveSpace(space.id, base) as { ok: boolean }).ok, true);
    assert.equal((resolveSpace('按名解析', base) as { ok: boolean }).ok, true);
    assert.equal((resolveSpace('不存在', base) as { ok: boolean }).ok, false);

    fs.rmSync(space.path, { recursive: true, force: true });
    const gone = resolveSpace(space.id, base) as { ok: boolean; error?: string };
    assert.equal(gone.ok, false);
    assert.match(String(gone.error), /目录不存在/);
  });

  it('listSpaces 反映当前激活项', () => {
    const space = okSpace(createSpace({ name: '激活项', managedParent: managed, baseRoot: base }));
    setActiveSpace(space.id);
    assert.equal(getActiveSpaceId(), space.id);
    assert.equal(listSpaces(base).spaces.find((s) => s.isActive)?.name, '激活项');
  });

  it('换了数据目录后不会列出上一个数据目录里的空间', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-spaces-other-'));
    try {
      prepareSpacesRoot(other);
      const space = okSpace(
        createSpace({ name: '旧池空间', managedParent: managed, baseRoot: base }),
      );
      setActiveSpace(space.id);

      // 切到另一个数据目录：只该看到它自己的公共空间，激活项回到公共空间
      const listed = listSpaces(other);
      assert.deepEqual(
        listed.spaces.map((s) => s.name),
        [PUBLIC_SPACE_NAME],
      );
      assert.equal(listed.activeId, PUBLIC_SPACE_ID);
      assert.equal(getActiveSpaceId(), PUBLIC_SPACE_ID);

      // 切回原目录：空间与激活项都还在
      const back = listSpaces(base);
      assert.ok(back.spaces.some((s) => s.id === space.id));
      assert.equal(back.activeId, space.id);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('整个数据目录改名后按清单身份重定位注册表路径', () => {
    const space = okSpace(createSpace({ name: '改名保留', managedParent: base, baseRoot: base }));
    setActiveSpace(space.id);

    // 模拟用户把整个数据目录换了位置（注册表还记着旧绝对路径）
    const moved = `${base}-moved`;
    fs.renameSync(base, moved);
    try {
      const listed = listSpaces(moved);
      const found = listed.spaces.find((s) => s.id === space.id);
      assert.ok(found, '空间不应因为根目录改名而消失');
      assert.equal(found!.exists, true, '应按清单身份找回目录');
      assert.equal(found!.path, path.join(moved, '改名保留'));
      assert.equal((resolveSpace(space.id, moved) as { ok: boolean }).ok, true);
    } finally {
      fs.renameSync(moved, base);
    }
  });
});

describe('createSpace / renameSpace / copySpace', () => {
  it('新建会落目录并登记；同名（忽略大小写）被拒绝', () => {
    const space = okSpace(createSpace({ name: '空间A', managedParent: managed, baseRoot: base }));
    assert.equal(fs.statSync(space.path).isDirectory(), true);

    const dup = createSpace({ name: '空间a', managedParent: managed, baseRoot: base }) as {
      ok: boolean;
    };
    assert.equal(dup.ok, false, '同名判定应忽略大小写');
  });

  it('目标目录已存在时拒绝新建，避免把无关内容当成数据空间', () => {
    const first = createSpace({ name: '手建目录', managedParent: managed, baseRoot: base });
    assert.equal((first as { ok: boolean }).ok, true);
    const dir = path.join(managed, '手建目录');
    fs.rmSync(dir, { recursive: true, force: true });
    // 目录被手工重建、且清掉登记项后，同名新建仍应因目录存在而拒绝
    fs.mkdirSync(dir, { recursive: true });
    fs.rmSync(path.join(home, 'lantern-harness', 'spaces.json'), { force: true });

    const again = createSpace({ name: '手建目录', managedParent: managed, baseRoot: base }) as {
      ok: boolean;
      error?: string;
    };
    assert.equal(again.ok, false);
    assert.match(String(again.error), /目录已存在/);
  });

  it('重命名同时改目录与登记名；公共空间被拒绝', () => {
    const space = okSpace(createSpace({ name: '旧名', managedParent: managed, baseRoot: base }));
    const renamed = okSpace(renameSpace(space.id, '新名', base));
    assert.equal(renamed.name, '新名');
    assert.equal(path.basename(renamed.path), '新名');
    assert.equal(fs.existsSync(renamed.path), true);
    assert.equal(fs.existsSync(space.path), false);

    const pub = renameSpace(PUBLIC_SPACE_ID, '试试', base) as { ok: boolean; error?: string };
    assert.equal(pub.ok, false);
    assert.match(String(pub.error), /不支持重命名/);
  });

  it('复制连同内容一起复制，且拒绝复制到自身内部', () => {
    const space = okSpace(createSpace({ name: '源空间', managedParent: managed, baseRoot: base }));
    fs.writeFileSync(path.join(space.path, 'marker.txt'), 'hello', 'utf8');

    const copied = okSpace(copySpace(space.id, '副本', base));
    assert.equal(fs.readFileSync(path.join(copied.path, 'marker.txt'), 'utf8'), 'hello');

    assert.equal(
      (copySpace(space.id, '副本', base) as { ok: boolean }).ok,
      false,
      '重名副本应被拒绝',
    );
    assert.throws(() => copyDirSync(space.path, path.join(space.path, 'inner')));
  });

  it('复制与打包都跳过 node_modules / .git 等构建目录', async () => {
    const space = okSpace(
      createSpace({ name: '含构建目录', managedParent: managed, baseRoot: base }),
    );
    fs.mkdirSync(path.join(space.path, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(space.path, 'node_modules', 'pkg', 'index.js'), 'x', 'utf8');
    fs.mkdirSync(path.join(space.path, '.git', 'objects'), { recursive: true });
    fs.writeFileSync(path.join(space.path, '.git', 'objects', 'o'), 'x', 'utf8');
    fs.writeFileSync(path.join(space.path, 'keep.txt'), 'keep', 'utf8');

    const copied = okSpace(copySpace(space.id, '跳过副本', base));
    assert.equal(fs.existsSync(path.join(copied.path, 'keep.txt')), true);
    assert.equal(fs.existsSync(path.join(copied.path, 'node_modules')), false);
    assert.equal(fs.existsSync(path.join(copied.path, '.git')), false);

    const zipFile = path.join(home, 'skip.zip');
    await exportSpaceToZip({ id: space.id, outFile: zipFile, baseRoot: base });
    // 直接读 zip 条目名，避免引入解压工具
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(fs.readFileSync(zipFile));
    const names = Object.keys(zip.files);
    assert.ok(names.includes('keep.txt'));
    assert.equal(
      names.some((n) => n.startsWith('node_modules/') || n.startsWith('.git/')),
      false,
      'zip 不应包含 node_modules / .git',
    );
  });
});

describe('removeSpace 与磁盘删除闸门', () => {
  it('purge=false 只移出列表，数据保留；purge=true 连目录一起删', () => {
    const a = okSpace(createSpace({ name: '待删1', managedParent: managed, baseRoot: base }));
    const b = okSpace(createSpace({ name: '待删2', managedParent: managed, baseRoot: base }));

    const soft = removeSpace({ id: a.id, purge: false, baseRoot: base }) as { purged: boolean };
    assert.equal(soft.purged, false);
    assert.equal(fs.existsSync(a.path), true, '仅移出列表时目录必须保留');

    const hard = removeSpace({ id: b.id, purge: true, baseRoot: base }) as { purged: boolean };
    assert.equal(hard.purged, true);
    assert.equal(fs.existsSync(b.path), false);
  });

  it('公共空间不可删除', () => {
    const out = removeSpace({ id: PUBLIC_SPACE_ID, purge: true, baseRoot: base }) as {
      ok: boolean;
      error?: string;
    };
    assert.equal(out.ok, false);
    assert.match(String(out.error), /不支持删除/);
  });

  it('删除激活中的空间会回落 activeId 到公共空间', () => {
    const space = okSpace(createSpace({ name: '当前项', managedParent: managed, baseRoot: base }));
    setActiveSpace(space.id);
    removeSpace({ id: space.id, purge: true, baseRoot: base });
    assert.equal(getActiveSpaceId(), PUBLIC_SPACE_ID);
  });

  it('托管目录之外的目录若不像数据空间则拒绝物理删除', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-outside-'));
    const fp = path.join(home, 'lantern-harness', 'spaces.json');
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(
      fp,
      JSON.stringify({
        managedParent: managed,
        activeId: PUBLIC_SPACE_ID,
        spaces: [{ id: 'sp_manual', name: '外部目录', path: outside, createdAt: 1, root: base }],
      }),
    );

    const out = removeSpace({ id: 'sp_manual', purge: true, baseRoot: base }) as {
      purged: boolean;
      warning?: string;
    };
    assert.equal(out.purged, false, '不像数据空间的目录不应被物理删除');
    assert.ok(out.warning);
    assert.equal(fs.existsSync(outside), true);

    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('外部登记但带 .lantern 元数据：删除数据时一并清掉空壳目录', () => {
    const dir = path.join(managed, '外部残留');
    fs.mkdirSync(path.join(dir, '.lantern', 'local'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.lantern', 'local', 'sessions.json'), '{}');
    const fp = path.join(home, 'lantern-harness', 'spaces.json');
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(
      fp,
      JSON.stringify({
        managedParent: managed,
        activeId: PUBLIC_SPACE_ID,
        spaces: [
          {
            id: 'sp_meta',
            name: '外部残留',
            path: dir,
            createdAt: 1,
            root: base,
            external: true,
          },
        ],
      }),
    );

    const out = removeSpace({ id: 'sp_meta', purge: true, baseRoot: base }) as {
      purged: boolean;
      warning?: string;
    };
    assert.equal(out.purged, true, '带 .lantern 元数据说明是本应用用过的空间，应允许物理删除');
    assert.equal(fs.existsSync(dir), false);
  });

  it('assertLooksLikeSpace：带标记或位于托管父目录内则放行', () => {
    assert.equal((assertLooksLikeSpace(managed, managed) as { ok: boolean }).ok, true);

    const marker = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-marker-'));
    fs.mkdirSync(path.join(marker, '.lantern', 'local'), { recursive: true });
    assert.equal((assertLooksLikeSpace(marker, managed) as { ok: boolean }).ok, true);

    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-plain-'));
    assert.equal((assertLooksLikeSpace(plain, managed) as { ok: boolean }).ok, false);

    fs.rmSync(marker, { recursive: true, force: true });
    fs.rmSync(plain, { recursive: true, force: true });
  });
});

describe('zip 导出 / 导入往返', () => {
  it('导出后导入，内容与目录结构保持一致', async () => {
    const space = okSpace(createSpace({ name: '打包源', managedParent: managed, baseRoot: base }));

    fs.mkdirSync(path.join(space.path, '需求文档库', '子目录'), { recursive: true });
    fs.writeFileSync(path.join(space.path, '需求文档库', '子目录', 'a.md'), '# a', 'utf8');
    fs.writeFileSync(path.join(space.path, '根文件.txt'), 'root', 'utf8');
    // .DS_Store 不该进包
    fs.writeFileSync(path.join(space.path, '.DS_Store'), 'junk', 'utf8');

    const zipFile = path.join(home, 'out.zip');
    const exp = await exportSpaceToZip({ id: space.id, outFile: zipFile, baseRoot: base });
    assert.equal((exp as { ok: boolean }).ok, true);
    assert.ok(fs.existsSync(zipFile));

    const imported = okSpace(
      await importSpaceFromZip({
        zipFile,
        name: '打包目标',
        managedParent: managed,
        baseRoot: base,
      }),
    );
    assert.equal(
      fs.readFileSync(path.join(imported.path, '需求文档库', '子目录', 'a.md'), 'utf8'),
      '# a',
    );
    assert.equal(fs.readFileSync(path.join(imported.path, '根文件.txt'), 'utf8'), 'root');
    assert.equal(
      fs.existsSync(path.join(imported.path, '.DS_Store')),
      false,
      '.DS_Store 不应被打包',
    );
  });

  it('导入非 zip / 缺失文件都被拒绝', async () => {
    const notZip = path.join(home, 'not.zip');
    fs.writeFileSync(notZip, 'definitely not a zip', 'utf8');
    const bad = await importSpaceFromZip({
      zipFile: notZip,
      managedParent: managed,
      baseRoot: base,
    });
    assert.equal((bad as { ok: boolean }).ok, false);

    const missing = (await importSpaceFromZip({
      zipFile: path.join(home, 'nope.zip'),
      managedParent: managed,
      baseRoot: base,
    })) as { ok: boolean; error?: string };
    assert.equal(missing.ok, false);
    assert.match(String(missing.error), /文件不存在/);
  });

  it('导入名称非法时被拒绝', async () => {
    const space = okSpace(createSpace({ name: '导出源2', managedParent: managed, baseRoot: base }));
    const zipFile = path.join(home, 'out2.zip');
    await exportSpaceToZip({ id: space.id, outFile: zipFile, baseRoot: base });

    const out = await importSpaceFromZip({
      zipFile,
      name: '../escape',
      managedParent: managed,
      baseRoot: base,
    });
    assert.equal((out as { ok: boolean }).ok, false);
  });
});

describe('空间清单 space.json（自包含）', () => {
  it('新建时写入清单；重命名后清单同步更新且 id 不变', () => {
    const space = okSpace(
      createSpace({ name: '清单空间', managedParent: managed, baseRoot: base }),
    );
    assert.equal(fs.existsSync(path.join(space.path, '.lantern', SPACE_MANIFEST_FILE)), true);

    const before = readSpaceManifest(space.path) as {
      ok: boolean;
      manifest?: { id: string; name: string };
    };
    assert.equal(before.ok, true);
    assert.equal(before.manifest!.id, space.id);
    assert.equal(before.manifest!.name, '清单空间');

    const renamed = okSpace(renameSpace(space.id, '清单空间2', base));
    const after = readSpaceManifest(renamed.path) as {
      ok: boolean;
      manifest?: { id: string; name: string };
    };
    assert.equal(after.ok, true);
    assert.equal(after.manifest!.name, '清单空间2');
    assert.equal(after.manifest!.id, space.id, '重命名不应更换 id');
  });

  it('根目录旧清单仍可读；写入或铺骨架后迁进 .lantern/', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-legacy-manifest-'));
    const payload = {
      kind: 'ai-testbench-space',
      schema: 1,
      id: 'sp_legacy_root',
      name: '旧位置',
      createdAt: 1,
    };
    fs.writeFileSync(path.join(dir, SPACE_MANIFEST_FILE), JSON.stringify(payload), 'utf8');

    const read = readSpaceManifest(dir) as {
      ok: boolean;
      manifest?: { id: string; name: string };
    };
    assert.equal(read.ok, true);
    assert.equal(read.manifest!.id, 'sp_legacy_root');
    assert.equal(fs.existsSync(path.join(dir, SPACE_MANIFEST_FILE)), true, '只读时不迁走');

    writeSpaceManifest(dir, { id: 'sp_legacy_root', name: '旧位置', createdAt: 1 });
    assert.equal(fs.existsSync(path.join(dir, SPACE_MANIFEST_FILE)), false);
    assert.equal(fs.existsSync(path.join(dir, '.lantern', SPACE_MANIFEST_FILE)), true);
    const rewritten = JSON.parse(
      fs.readFileSync(path.join(dir, '.lantern', SPACE_MANIFEST_FILE), 'utf8'),
    ) as { kind: string };
    assert.equal(rewritten.kind, 'lantern-harness-space', '写入一律用新 kind');

    fs.writeFileSync(path.join(dir, SPACE_MANIFEST_FILE), JSON.stringify(payload), 'utf8');
    prepareSpaceDir(dir);
    assert.equal(fs.existsSync(path.join(dir, SPACE_MANIFEST_FILE)), false);
    assert.equal(fs.existsSync(path.join(dir, '.lantern', SPACE_MANIFEST_FILE)), true);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('复制 / 导入都改写清单身份，且导入可回退到包内清单名称', async () => {
    const space = okSpace(createSpace({ name: '清单源', managedParent: managed, baseRoot: base }));

    const copied = okSpace(copySpace(space.id, '清单副本', base));
    const cm = readSpaceManifest(copied.path) as { ok: boolean; manifest?: { id: string } };
    assert.equal(cm.ok, true);
    assert.notEqual(cm.manifest!.id, space.id, '副本必须是新身份');

    const zipFile = path.join(home, 'unrelated-file-name.zip');
    await exportSpaceToZip({ id: space.id, outFile: zipFile, baseRoot: base });

    // 先把源空间移出列表：同名唯一是刻意设计，否则导入必然被拒
    removeSpace({ id: space.id, purge: false, baseRoot: base });

    // 不指定名称：应回退到包内清单里的名称，而不是 zip 文件名
    // 用独立父目录导入，避免与源空间残留在磁盘上的同名目录相撞
    const importParent = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-import-parent-'));
    const imported = okSpace(
      await importSpaceFromZip({ zipFile, managedParent: importParent, baseRoot: base }),
    );
    assert.equal(imported.name, '清单源');
    const im = readSpaceManifest(imported.path) as { ok: boolean; manifest?: { id: string } };
    assert.equal(im.ok, true);
    assert.notEqual(im.manifest!.id, space.id);
    fs.rmSync(importParent, { recursive: true, force: true });
  });

  it('缺失 / 损坏 / 异类清单都不会被误认', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-nomanifest-'));
    assert.equal((readSpaceManifest(plain) as { ok: boolean }).ok, false);

    fs.writeFileSync(path.join(plain, SPACE_MANIFEST_FILE), '{ not json', 'utf8');
    assert.equal((readSpaceManifest(plain) as { ok: boolean }).ok, false);

    fs.writeFileSync(
      path.join(plain, SPACE_MANIFEST_FILE),
      JSON.stringify({ kind: 'something-else', id: 'x', name: 'y' }),
      'utf8',
    );
    assert.equal((readSpaceManifest(plain) as { ok: boolean }).ok, false);

    fs.writeFileSync(
      path.join(plain, SPACE_MANIFEST_FILE),
      JSON.stringify({ kind: 'ai-testbench-space', id: '', name: '' }),
      'utf8',
    );
    assert.equal((readSpaceManifest(plain) as { ok: boolean }).ok, false);

    fs.rmSync(plain, { recursive: true, force: true });
  });
});

describe('discoverSpaces 扫描纳入', () => {
  it('纳入带清单的文件夹；重名目录跳过；无清单目录只列为候选', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-discover-'));
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-discover-other-'));

    // 已登记一个「重名空间」（在另一个目录里），用来验证同名跳过
    okSpace(createSpace({ name: '重名空间', managedParent: other, baseRoot: base }));
    const dup = path.join(parent, '重名空间');
    fs.mkdirSync(dup, { recursive: true });
    writeSpaceManifest(dup, { id: 'sp_dup', name: '重名空间', createdAt: 1 });

    // 模拟从别处整体拷进来：带清单、清单名与目录名不一致
    const incoming = path.join(parent, '拷来的空间');
    fs.mkdirSync(path.join(incoming, '.local'), { recursive: true });
    writeSpaceManifest(incoming, { id: 'sp_from_elsewhere', name: '别的名字', createdAt: 123 });

    // 无清单的普通目录
    fs.mkdirSync(path.join(parent, '普通目录'), { recursive: true });

    const out = discoverSpaces({ managedParent: parent }) as {
      added: Array<{ id: string; name: string }>;
      skipped: Array<{ path: string; reason: string }>;
      candidates: Array<{ name: string }>;
    };
    assert.equal(out.added.length, 1);
    assert.equal(out.added[0]!.name, '拷来的空间', '名称以目录名为准');
    assert.equal(out.added[0]!.id, 'sp_from_elsewhere');
    assert.equal(out.skipped.length, 1);
    assert.match(out.skipped[0]!.reason, /同名/);
    assert.deepEqual(
      out.candidates.map((c) => c.name),
      ['普通目录'],
      '普通目录不擅自纳入，等用户确认',
    );

    // 清单会被同步成目录名，避免搬移后身份与登记名不一致
    const m = readSpaceManifest(incoming) as { ok: boolean; manifest?: { name: string } };
    assert.equal(m.manifest!.name, '拷来的空间');

    // 重复扫描是幂等的
    const again = discoverSpaces({ managedParent: parent }) as { added: unknown[] };
    assert.equal(again.added.length, 0);

    for (const d of [parent, other]) fs.rmSync(d, { recursive: true, force: true });
  });

  it('确认纳入的普通文件夹只登记：不写清单、不铺目录、不播种子', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-adopt-'));
    const plain = path.join(parent, '资料文件夹');
    fs.mkdirSync(path.join(plain, '用例管理'), { recursive: true });
    fs.writeFileSync(path.join(plain, '用例管理', 'a.md'), '# a', 'utf8');
    fs.mkdirSync(path.join(plain, '提示词管理'), { recursive: true });

    // 默认只列为候选，不动文件夹
    const scan = discoverSpaces({ managedParent: parent, baseRoot: base }) as {
      added: unknown[];
      candidates: Array<{ path: string; hasContent?: boolean }>;
    };
    assert.equal(scan.added.length, 0);
    assert.equal(scan.candidates[0]!.hasContent, true, '带内容库目录的候选应有标记');
    assert.equal(fs.existsSync(path.join(plain, '.lantern')), false);

    // 用户确认后：登记进列表，仍然不写任何元数据
    const out = discoverSpaces({
      managedParent: parent,
      adopt: ['资料文件夹'],
      baseRoot: base,
    }) as {
      added: Array<{ id: string; name: string; external?: boolean }>;
    };
    assert.equal(out.added.length, 1);
    assert.equal(out.added[0]!.external, true);
    assert.equal(fs.existsSync(path.join(plain, '.lantern')), false, '不能写 space.json 或骨架');
    assert.equal(fs.readFileSync(path.join(plain, '用例管理', 'a.md'), 'utf8'), '# a');

    // 再扫一次：外部空间不会被补写清单
    const again = discoverSpaces({ managedParent: parent, baseRoot: base }) as {
      backfilled: string[];
      added: unknown[];
    };
    assert.deepEqual(again.added, []);
    assert.deepEqual(again.backfilled, []);
    assert.equal(fs.existsSync(path.join(plain, '.lantern')), false);

    // 切到该空间时只补运行时配置：不搬动已有目录、不建内容目录、不播种子
    fs.mkdirSync(path.join(plain, 'config'), { recursive: true });
    fs.writeFileSync(path.join(plain, 'config', 'keep.txt'), 'mine', 'utf8');
    prepareExternalSpaceDir(plain);
    assert.equal(fs.existsSync(path.join(plain, '.lantern', 'config', 'app.defaults.json')), true);
    assert.equal(fs.existsSync(path.join(plain, '.lantern', 'local')), true);
    assert.equal(fs.existsSync(path.join(plain, '.lantern', SPACE_MANIFEST_FILE)), false);
    assert.equal(
      fs.existsSync(path.join(plain, 'config', 'keep.txt')),
      true,
      '不搬动用户的 config/',
    );
    assert.equal(fs.existsSync(path.join(plain, '测试模板库')), false, '不铺没启用的目录');
    assert.equal(
      fs.existsSync(path.join(plain, '提示词管理', '默认提示词.md')),
      false,
      '已有的内容目录也不播种子',
    );

    // 切到该空间后已补过运行时配置（.lantern）：视为本应用用过的空间，
    // 删除数据时一并清掉目录（纯外部文件夹无元数据时仍只移出列表，见 removeSpace 用例）
    const adoptedId = (out.added[0] as { id: string }).id;
    const removed = removeSpace({ id: adoptedId, purge: true, baseRoot: base }) as {
      purged: boolean;
      warning?: string;
    };
    assert.equal(removed.purged, true);
    assert.equal(fs.existsSync(plain), false);

    fs.rmSync(parent, { recursive: true, force: true });
  });

  it('外部纳入的空间在池根整体搬移后按名称恢复路径', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-external-move-'));
    const dir = path.join(root, '资料文件夹');
    fs.mkdirSync(dir, { recursive: true });
    const adopted = discoverSpaces({ managedParent: root, adopt: ['资料文件夹'] }) as {
      added: Array<{ id: string; name: string }>;
    };
    assert.equal(adopted.added.length, 1);

    const moved = `${root}-moved`;
    fs.renameSync(root, moved);
    const listed = listSpaces(moved);
    const found = listed.spaces.find((s) => s.id === adopted.added[0]!.id);
    assert.ok(found, '搬移后仍应在列表里');
    assert.equal(path.resolve(found.path), path.resolve(path.join(moved, '资料文件夹')));
    assert.equal(found.exists, true);

    fs.rmSync(moved, { recursive: true, force: true });
  });

  it('为已登记但缺清单的空间补写清单；id 撞车时换新 id', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-backfill-'));
    const space = okSpace(createSpace({ name: '老空间', managedParent: parent, baseRoot: base }));
    // 模拟升级前创建的空间：目录里有数据但没有清单
    fs.rmSync(path.join(space.path, '.lantern', SPACE_MANIFEST_FILE), { force: true });

    const first = discoverSpaces({ managedParent: parent }) as { backfilled: string[] };
    assert.deepEqual(first.backfilled, ['老空间']);
    assert.equal(fs.existsSync(path.join(space.path, '.lantern', SPACE_MANIFEST_FILE)), true);

    // 把带清单的空间整体复制成另一个目录：清单 id 与原空间相同，必须换新
    const clone = path.join(parent, '克隆空间');
    copyDirSync(space.path, clone);

    const second = discoverSpaces({ managedParent: parent }) as {
      added: Array<{ id: string; name: string }>;
    };
    assert.equal(second.added.length, 1);
    assert.equal(second.added[0]!.name, '克隆空间');
    assert.notEqual(second.added[0]!.id, space.id, 'id 撞车时必须换新');

    fs.rmSync(parent, { recursive: true, force: true });
  });

  it('托管目录不存在时安全返回空结果', () => {
    const missing = path.join(os.tmpdir(), `tb-not-exist-${Date.now()}`);
    const out = discoverSpaces({ managedParent: missing }) as {
      ok: boolean;
      added: unknown[];
      skipped: unknown[];
    };
    assert.equal(out.ok, true);
    assert.deepEqual(out.added, []);
    assert.deepEqual(out.skipped, []);
  });

  it('纳入升级前创建、没有清单的老空间目录，并补写清单', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-legacy-'));

    // 模拟老空间：有 .local 与 config/app.defaults.json，但没有清单
    const legacy = path.join(parent, '老空间目录');
    fs.mkdirSync(path.join(legacy, '.local'), { recursive: true });
    fs.mkdirSync(path.join(legacy, 'config'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'config', 'app.defaults.json'), '{}', 'utf8');

    // 只有 .local（或只有 config）的目录不算数据空间，必须忽略
    const halfBaked = path.join(parent, '只有local');
    fs.mkdirSync(path.join(halfBaked, '.local'), { recursive: true });

    const out = discoverSpaces({ managedParent: parent }) as {
      added: Array<{ id: string; name: string }>;
    };
    assert.equal(out.added.length, 1);
    assert.equal(out.added[0]!.name, '老空间目录');
    assert.equal(fs.existsSync(path.join(legacy, '.lantern', SPACE_MANIFEST_FILE)), true);

    fs.rmSync(parent, { recursive: true, force: true });
  });
});

describe('导出范围：内容库 vs 完整备份', () => {
  it('内容库排除密钥 / 会话 / 记忆 / 缓存，并对模型配置脱敏', async () => {
    const space = okSpace(
      createSpace({ name: '导出范围', managedParent: managed, baseRoot: base }),
    );
    const p = space.path;

    fs.mkdirSync(path.join(p, '需求文档库'), { recursive: true });
    fs.writeFileSync(path.join(p, '需求文档库', 'keep.md'), '# keep', 'utf8');

    fs.writeFileSync(path.join(p, '.env'), 'TW_API_KEY=sk-secret\n', 'utf8');
    fs.mkdirSync(path.join(p, '.lantern', 'local', 'memories'), { recursive: true });
    fs.writeFileSync(path.join(p, '.lantern', 'local', 'memories', 'USER.md'), 'private', 'utf8');
    fs.mkdirSync(path.join(p, '.lantern', 'local', 'spill'), { recursive: true });
    fs.writeFileSync(path.join(p, '.lantern', 'local', 'spill', 'big.txt'), 'x', 'utf8');
    fs.writeFileSync(path.join(p, '.lantern', 'local', 'sessions.json'), '[]', 'utf8');
    fs.writeFileSync(path.join(p, '.lantern', 'local', 'sessions.jsonl'), 'x', 'utf8');
    fs.writeFileSync(path.join(p, '.lantern', 'local', 'session-query.sqlite'), 'x', 'utf8');
    fs.writeFileSync(path.join(p, '.lantern', 'local', 'workspaces.json'), '{}', 'utf8');
    fs.writeFileSync(
      path.join(p, '.lantern', 'local', 'app.config.json'),
      JSON.stringify({
        model: {
          baseUrl: 'https://api.example.com',
          apiKey: 'sk-live',
          providers: [{ id: 'p1', apiKey: 'sk-p1', model: 'm' }],
        },
      }),
      'utf8',
    );

    const JSZip = (await import('jszip')).default;

    const contentZip = path.join(home, 'content.zip');
    await exportSpaceToZip({ id: space.id, outFile: contentZip, baseRoot: base, scope: 'content' });
    const content = await JSZip.loadAsync(fs.readFileSync(contentZip));
    const names = Object.keys(content.files);

    assert.ok(names.includes('需求文档库/keep.md'), '内容目录必须保留');
    for (const gone of [
      '.env',
      '.lantern/local/sessions.json',
      '.lantern/local/sessions.jsonl',
      '.lantern/local/session-query.sqlite',
      '.lantern/local/workspaces.json',
    ]) {
      assert.equal(names.includes(gone), false, `${gone} 不应被打包`);
    }
    assert.equal(
      names.some(
        (n) => n.startsWith('.lantern/local/memories/') || n.startsWith('.lantern/local/spill/'),
      ),
      false,
      '记忆与溢出缓存不应被打包',
    );

    // 模型配置保留（非敏感字段还在），但密钥必须被剔除
    const cfgFile = content.file('.lantern/local/app.config.json');
    assert.ok(cfgFile, '模型配置应保留（脱敏后）');
    const cfgText = await cfgFile!.async('string');
    assert.equal(/sk-live|sk-p1/.test(cfgText), false, '脱敏后不应残留密钥');
    assert.ok(cfgText.includes('api.example.com'), '非敏感配置应当保留');

    // 完整备份不设限：密钥与会话都在
    const fullZip = path.join(home, 'full.zip');
    await exportSpaceToZip({ id: space.id, outFile: fullZip, baseRoot: base });
    const full = await JSZip.loadAsync(fs.readFileSync(fullZip));
    const fullNames = Object.keys(full.files);
    assert.ok(fullNames.includes('.env'));
    assert.ok(fullNames.includes('.lantern/local/sessions.json'));
    assert.ok(fullNames.includes('.lantern/local/memories/USER.md'));
    assert.ok(fullNames.includes('.lantern/local/app.config.json'));
  });
});

describe('space-context 运行时上下文', () => {
  it('首次初始化确定基准根，默认生效目录是公共空间，切换后跟随，reset 回到公共空间', () => {
    __resetSpaceContext();
    ensureSpaceContext(base);
    assert.equal(getDataRoot(), publicSpacePath(base));

    setActiveRoot(managed);
    assert.equal(getDataRoot(), path.resolve(managed));

    // 重复 ensure 不应覆盖已切换的根
    ensureSpaceContext(base);
    assert.equal(getDataRoot(), path.resolve(managed));

    __resetSpaceContext();
    ensureSpaceContext(base);
    assert.equal(getDataRoot(), publicSpacePath(base));
  });

  it('未初始化时 getDataRoot 退化到 cwd 下的公共空间，不抛错', () => {
    __resetSpaceContext();
    assert.equal(getDataRoot(), publicSpacePath(process.cwd()));
  });
});

describe('prepareSpacesRoot：池根、空间池与旧布局迁移', () => {
  it('铺出公共空间骨架，并把池根里的既存内容搬进池内公共空间', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-prepare-'));

    // 旧布局：内容目录、.local 与数据空间自己的 config 直接躺在池根下
    fs.mkdirSync(path.join(root, '需求文档库'), { recursive: true });
    fs.writeFileSync(path.join(root, '需求文档库', 'a.md'), '# a', 'utf8');
    fs.mkdirSync(path.join(root, '.local'), { recursive: true });
    fs.writeFileSync(path.join(root, '.local', 'sessions.json'), '[]', 'utf8');
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config', 'app.defaults.json'), '{"mine":true}', 'utf8');

    prepareSpacesRoot(root);

    const pub = publicSpacePath(root);
    assert.equal(path.basename(pub), '公共空间');
    assert.equal(
      path.resolve(path.dirname(pub)),
      path.resolve(root),
      '用户数据目录下公共空间应直接落在选中的文件夹',
    );
    assert.equal(fs.existsSync(path.join(root, SPACE_POOL_DIR)), false, '不应出现空间池文件夹');
    // 元数据统一收进隐藏目录 .lantern（config 与 local 各自归位）
    for (const name of [
      '.lantern',
      '.lantern/config/app.defaults.json',
      '.lantern/local',
      '需求文档库',
    ]) {
      assert.equal(fs.existsSync(path.join(pub, name)), true, `公共空间缺少 ${name}`);
    }
    // 插件默认关闭：没有内容的空间不应被铺出空的内容目录（提示词管理是内置常开项）
    for (const name of ['用例管理', '测试模板库', '知识库管理']) {
      assert.equal(fs.existsSync(path.join(pub, name)), false, `插件关闭时不应建 ${name}`);
    }
    assert.equal(
      fs.existsSync(path.join(pub, '提示词管理', '默认提示词.md')),
      true,
      '公共空间应始终带上默认提示词',
    );
    // 内容目录在空间根可见，元数据不再与内容混在一起
    assert.equal(fs.existsSync(path.join(pub, 'config')), false, 'config 应改名为 .lantern/config');
    assert.equal(fs.existsSync(path.join(pub, '.local')), false, '.local 应改名为 .lantern/local');
    assert.equal(fs.readFileSync(path.join(pub, '需求文档库', 'a.md'), 'utf8'), '# a');
    assert.equal(fs.existsSync(path.join(root, '需求文档库')), false, '旧目录应被搬走');
    assert.equal(fs.existsSync(path.join(root, '.local')), false, '旧 .local 应被搬走');
    assert.equal(
      fs.readFileSync(path.join(pub, '.lantern', 'local', 'sessions.json'), 'utf8'),
      '[]',
      '既有会话数据必须保留',
    );
    assert.equal(
      fs.readFileSync(path.join(pub, '.lantern', 'config', 'app.defaults.json'), 'utf8'),
      '{"mine":true}',
      '池根里的自定义配置应被搬走，而不是被默认值覆盖',
    );

    // 幂等：重复准备不再改动任何东西
    prepareSpacesRoot(root);
    assert.equal(fs.readFileSync(path.join(pub, '需求文档库', 'a.md'), 'utf8'), '# a');

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('选中的文件夹下已有公共空间时就地收进 .lantern（幂等）', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-prepare-legacy-'));
    const pub = path.join(root, '公共空间');
    fs.mkdirSync(path.join(pub, '.local'), { recursive: true });
    fs.writeFileSync(path.join(pub, '.local', 'sessions.json'), '["keep"]', 'utf8');
    fs.mkdirSync(path.join(pub, '用例管理'), { recursive: true });
    fs.writeFileSync(path.join(pub, '用例管理', 'x.md'), 'x', 'utf8');

    prepareSpacesRoot(root);

    assert.equal(path.resolve(publicSpacePath(root)), path.resolve(pub));
    assert.equal(fs.existsSync(path.join(root, SPACE_POOL_DIR)), false);
    assert.equal(
      fs.readFileSync(path.join(pub, '.lantern', 'local', 'sessions.json'), 'utf8'),
      '["keep"]',
      '旧元数据必须保留',
    );
    assert.equal(fs.readFileSync(path.join(pub, '用例管理', 'x.md'), 'utf8'), 'x');

    prepareSpacesRoot(root);
    assert.equal(fs.readFileSync(path.join(pub, '用例管理', 'x.md'), 'utf8'), 'x');

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('公共空间只清掉未改动过的旧种子提示词，用户自己新增 / 改过的保留', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-retired-seed-'));
    const pub = path.join(root, '公共空间');
    const prompts = path.join(pub, '提示词管理');
    fs.mkdirSync(prompts, { recursive: true });
    // 用户自己新建 / 改过的同名文件：内容与旧种子不同，不能被清掉
    fs.writeFileSync(path.join(prompts, '功能测试用例提示词v1.0.md'), '# 我自己的提示词', 'utf8');
    fs.writeFileSync(path.join(prompts, '默认提示词.md'), '# mine', 'utf8');

    prepareSpacesRoot(root);

    assert.equal(
      fs.readFileSync(path.join(prompts, '功能测试用例提示词v1.0.md'), 'utf8'),
      '# 我自己的提示词',
      '用户自己维护的同名提示词应保留',
    );
    assert.equal(
      fs.readFileSync(path.join(prompts, '默认提示词.md'), 'utf8'),
      '# mine',
      '用户自己保留的默认提示词不受影响',
    );

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('启动时把空间内旧 .tb 收进 .lantern/', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-meta-rename-'));
    const pub = path.join(root, '公共空间');
    fs.mkdirSync(path.join(pub, '.tb', 'local'), { recursive: true });
    fs.mkdirSync(path.join(pub, '.tb', 'config'), { recursive: true });
    fs.writeFileSync(path.join(pub, '.tb', 'local', 'sessions.json'), '["legacy"]', 'utf8');
    fs.writeFileSync(path.join(pub, '.tb', 'config', 'app.defaults.json'), '{"from":"tb"}', 'utf8');
    fs.writeFileSync(
      path.join(pub, '.tb', 'space.json'),
      JSON.stringify({
        kind: 'ai-testbench-space',
        id: 'public',
        name: '公共空间',
        createdAt: 1,
      }),
      'utf8',
    );

    prepareSpacesRoot(root);

    assert.equal(fs.existsSync(path.join(pub, '.tb')), false, '旧 .tb 应被搬走');
    assert.equal(
      fs.readFileSync(path.join(pub, '.lantern', 'local', 'sessions.json'), 'utf8'),
      '["legacy"]',
    );
    assert.equal(
      fs.readFileSync(path.join(pub, '.lantern', 'config', 'app.defaults.json'), 'utf8'),
      '{"from":"tb"}',
    );
    assert.equal(fs.existsSync(path.join(pub, '.lantern', 'space.json')), true);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('把旧的 `<根>/空间池/` 抬到选中的文件夹下（幂等）', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-lift-pool-'));
    const nestedPub = path.join(root, SPACE_POOL_DIR, '公共空间');
    const nestedSide = path.join(root, SPACE_POOL_DIR, '侧空间');
    fs.mkdirSync(path.join(nestedPub, '用例管理'), { recursive: true });
    fs.writeFileSync(path.join(nestedPub, '用例管理', 'a.md'), 'a', 'utf8');
    fs.mkdirSync(nestedSide, { recursive: true });
    fs.writeFileSync(path.join(nestedSide, 'keep.txt'), 'ok', 'utf8');

    prepareSpacesRoot(root);

    const pub = publicSpacePath(root);
    assert.equal(path.resolve(path.dirname(pub)), path.resolve(root));
    assert.equal(fs.readFileSync(path.join(pub, '用例管理', 'a.md'), 'utf8'), 'a');
    assert.equal(fs.readFileSync(path.join(root, '侧空间', 'keep.txt'), 'utf8'), 'ok');
    assert.equal(fs.existsSync(path.join(root, SPACE_POOL_DIR)), false, '空间池容器目录应被拆掉');

    prepareSpacesRoot(root);
    assert.equal(fs.readFileSync(path.join(root, '侧空间', 'keep.txt'), 'utf8'), 'ok');

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('listSpaces 把注册表里旧的 空间池 路径改写成选中文件夹下的路径', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-reg-flatten-'));
    const nested = path.join(root, SPACE_POOL_DIR, '旧空间');
    fs.mkdirSync(nested, { recursive: true });
    prepareSpacesRoot(root);
    const fp = path.join(home, 'lantern-harness', 'spaces.json');
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(
      fp,
      JSON.stringify({
        activeId: 'public',
        spaces: [{ id: 'sp_old', name: '旧空间', path: nested, createdAt: 1 }],
      }),
      'utf8',
    );

    const listed = listSpaces(root);
    const found = listed.spaces.find((s) => s.id === 'sp_old');
    assert.ok(found);
    assert.equal(path.resolve(found!.path), path.resolve(path.join(root, '旧空间')));

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('displaySpacePath 隐去空间池这一层', () => {
    const root = path.join(os.tmpdir(), 'tb-display-root');
    assert.equal(
      displaySpacePath(path.join(root, SPACE_POOL_DIR, '公共空间'), root),
      path.join(root, '公共空间'),
    );
    assert.equal(displaySpacePath(path.join(root, SPACE_POOL_DIR), root), root);
  });

  it('源码仓库 / npm 包根把空间放进空间池，避免和 cli 混放', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-src-pool-'));
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'lantern-harness', bin: { lantern: 'cli/lantern.mjs' } }),
      'utf8',
    );
    fs.mkdirSync(path.join(root, 'cli'), { recursive: true });
    fs.writeFileSync(path.join(root, 'cli', 'lantern.mjs'), '', 'utf8');

    prepareSpacesRoot(root);
    const pub = publicSpacePath(root);
    assert.equal(path.basename(path.dirname(pub)), SPACE_POOL_DIR);
    assert.equal(fs.existsSync(path.join(root, '公共空间')), false);
    assert.equal(fs.existsSync(pub), true);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('源码仓库根误摊的公共空间空壳会收回空间池并删掉', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-src-flat-shell-'));
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'lantern-harness', bin: { lantern: 'cli/lantern.mjs' } }),
      'utf8',
    );
    fs.mkdirSync(path.join(root, 'cli'), { recursive: true });
    fs.writeFileSync(path.join(root, 'cli', 'lantern.mjs'), '', 'utf8');
    prepareSpacesRoot(root);

    const leftover = path.join(root, '公共空间');
    fs.mkdirSync(path.join(leftover, '.lantern', 'local'), { recursive: true });
    fs.writeFileSync(path.join(leftover, '.lantern', 'local', 'stale.txt'), 'stale', 'utf8');

    prepareSpacesRoot(root);
    assert.equal(fs.existsSync(leftover), false, '仓库根不应再留平铺的公共空间空壳');
    assert.equal(fs.existsSync(publicSpacePath(root)), true);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('旧包名 ai-testbench + 旧入口 cli/tbench.mjs 同样把空间放进空间池', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-src-pool-legacy-'));
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'ai-testbench', bin: { tbench: 'cli/tbench.mjs' } }),
      'utf8',
    );
    fs.mkdirSync(path.join(root, 'cli'), { recursive: true });
    fs.writeFileSync(path.join(root, 'cli', 'tbench.mjs'), '', 'utf8');

    prepareSpacesRoot(root);
    const pub = publicSpacePath(root);
    assert.equal(path.basename(path.dirname(pub)), SPACE_POOL_DIR);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('池根里后出现的同名目录逐条目并入，不覆盖也不丢文件', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-prepare-merge-'));
    prepareSpacesRoot(root);
    const pub = publicSpacePath(root);

    // 迁移之后，池根里再出现同名目录（例如用户手动放的）：
    // 既有文件必须保留，新文件也要并进来 —— 两边都不丢
    fs.mkdirSync(path.join(root, '用例管理'), { recursive: true });
    fs.writeFileSync(path.join(root, '用例管理', 'outer.md'), 'outer', 'utf8');
    fs.writeFileSync(path.join(root, '用例管理', 'inner.md'), 'shadowed', 'utf8');
    fs.mkdirSync(path.join(pub, '用例管理'), { recursive: true });
    fs.writeFileSync(path.join(pub, '用例管理', 'inner.md'), 'inner', 'utf8');

    prepareSpacesRoot(root);
    assert.equal(
      fs.readFileSync(path.join(pub, '用例管理', 'inner.md'), 'utf8'),
      'inner',
      '同名文件不得被池根里的版本覆盖',
    );
    assert.equal(
      fs.readFileSync(path.join(pub, '用例管理', 'outer.md'), 'utf8'),
      'outer',
      '池根里的新文件应被并入，而不是丢掉',
    );

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('合并后只剩撞名副本的重复空间会被删掉，有独有内容的则保留', () => {
    // 需要「包根」形态才会走 空间池/ 分支
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-prepare-dupe-'));
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'lantern-harness', bin: { lantern: 'cli/lantern.mjs' } }),
      'utf8',
    );
    fs.mkdirSync(path.join(root, 'cli'), { recursive: true });
    fs.writeFileSync(path.join(root, 'cli', 'lantern.mjs'), '', 'utf8');
    prepareSpacesRoot(root);
    const pub = publicSpacePath(root);
    assert.equal(path.basename(path.dirname(pub)), SPACE_POOL_DIR, '应使用 空间池 布局');

    // 1) 内容与池里完全一致：合并后应整份删掉，不再挂在仓库根
    //    插件默认关闭，先手动放一份内容进池里的公共空间，才能比较「完全一致」
    fs.mkdirSync(path.join(pub, '提示词管理'), { recursive: true });
    fs.writeFileSync(path.join(pub, '提示词管理', '默认提示词.md'), 'seed', 'utf8');
    const dup = path.join(root, '公共空间');
    fs.mkdirSync(path.join(dup, '提示词管理'), { recursive: true });
    fs.writeFileSync(
      path.join(dup, '提示词管理', '默认提示词.md'),
      fs.readFileSync(path.join(pub, '提示词管理', '默认提示词.md'), 'utf8'),
      'utf8',
    );
    prepareSpacesRoot(root);
    assert.equal(fs.existsSync(dup), false, '纯重复副本不应留在池根');

    // 2) 有独有文件：必须保留，不能被当成重复副本删掉
    const dup2 = path.join(root, '公共空间');
    fs.mkdirSync(path.join(dup2, '提示词管理'), { recursive: true });
    fs.writeFileSync(path.join(dup2, '提示词管理', '默认提示词.md'), 'different', 'utf8');
    prepareSpacesRoot(root);
    assert.equal(fs.existsSync(dup2), true, '有独有内容的空间不能删');
    assert.equal(
      fs.readFileSync(path.join(pub, '提示词管理', '默认提示词.md'), 'utf8') === 'different',
      false,
      '同名文件仍不得被覆盖',
    );

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('prepareSpaceDir 只处理单个空间目录，不再往下嵌套公共空间，内容目录按插件开关懒建', () => {
    const space = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-spacedir-'));
    prepareSpaceDir(space);
    assert.equal(fs.existsSync(path.join(space, '.lantern', 'config', 'app.defaults.json')), true);
    assert.equal(fs.existsSync(path.join(space, '.lantern', 'local')), true);
    assert.equal(fs.existsSync(path.join(space, 'config')), false, '不应在空间根留下 config');
    assert.equal(fs.existsSync(path.join(space, '.local')), false, '不应在空间根留下 .local');
    assert.equal(fs.existsSync(path.join(space, '公共空间')), false, '单空间目录不应再嵌套');
    // 插件全关时不铺内容目录；提示词管理例外：每个空间都要有默认提示词
    for (const dirName of Object.values(DOC_ROOT_DIRS).map((d) => d.dirName)) {
      if (dirName === DOC_ROOT_DIRS.prompts.dirName) continue;
      assert.equal(fs.existsSync(path.join(space, dirName)), false, `插件关闭时不应建 ${dirName}`);
    }
    assert.equal(
      fs.existsSync(path.join(space, DOC_ROOT_DIRS.prompts.dirName, '默认提示词.md')),
      true,
      '新建空间应始终带上默认提示词',
    );

    // 打开提示词管理后：补建目录并播下默认提示词
    fs.mkdirSync(path.join(space, '.lantern', 'local'), { recursive: true });
    fs.writeFileSync(
      path.join(space, '.lantern', 'local', 'app.config.json'),
      JSON.stringify({ plugins: { prompts: true, templates: true } }),
      'utf8',
    );
    prepareSpaceDir(space);
    assert.equal(
      fs.existsSync(path.join(space, '提示词管理', '默认提示词.md')),
      true,
      '启用提示词管理后应播种默认提示词',
    );
    assert.equal(
      fs.existsSync(path.join(space, '提示词管理', '功能测试用例提示词v1.0.md')),
      false,
      '新空间不应带上公共空间的其它提示词',
    );
    assert.equal(
      fs.existsSync(path.join(space, '知识库管理', '功能测试用例编写规范.md')),
      false,
      '新空间不应同步公共空间知识库文件',
    );
    assert.equal(writeSpaceSystemPrompt(space, '  你是本空间助手。\n'), true, '非空提示词应当写入');
    assert.equal(
      fs.readFileSync(path.join(space, '提示词管理', '默认提示词.md'), 'utf8').trim(),
      '你是本空间助手。',
      '创建时生成的提示词应覆盖种子',
    );
    {
      const promptFile = path.join(space, '提示词管理', '默认提示词.md');
      const fileSt = fs.statSync(promptFile);
      const dirSt = fs.statSync(path.dirname(promptFile));
      const born = Number(fileSt.birthtimeMs) || 0;
      const dirBorn = Number(dirSt.birthtimeMs) || 0;
      if (born && dirBorn) {
        assert.ok(
          born + 50 >= dirBorn,
          '默认提示词的创建时间不应早于所在目录（不能沿用种子文件时间）',
        );
      }
    }
    assert.equal(writeSpaceSystemPrompt(space, '   '), false, '空串不得覆盖已有提示词');
    assert.equal(
      fs.readFileSync(path.join(space, '提示词管理', '默认提示词.md'), 'utf8').trim(),
      '你是本空间助手。',
    );
    // 模板库按分类分层，子目录里的种子同样要落位
    assert.equal(
      fs.existsSync(path.join(space, '测试模板库', '功能测试用例', '功能测试用例模板.xlsx')),
      true,
      '模板库分层种子应被播种',
    );

    // 用户改动过的文件不被覆盖
    fs.mkdirSync(path.join(space, '知识库管理'), { recursive: true });
    const customKb = path.join(space, '知识库管理', '本空间笔记.md');
    fs.writeFileSync(customKb, 'mine', 'utf8');
    prepareSpaceDir(space);
    assert.equal(fs.readFileSync(customKb, 'utf8'), 'mine', '已存在的文件不得被覆盖');

    fs.rmSync(space, { recursive: true, force: true });
  });

  it('启用内容库插件后按需补建目录并播种', () => {
    const space = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-lazy-dir-'));
    prepareSpaceDir(space);
    assert.equal(fs.existsSync(path.join(space, '用例管理')), false);
    assert.equal(isContentRootEnabled(space, '用例管理'), false);

    fs.mkdirSync(path.join(space, '.lantern', 'local'), { recursive: true });
    fs.writeFileSync(
      path.join(space, '.lantern', 'local', 'app.config.json'),
      JSON.stringify({ plugins: { cases: true } }),
      'utf8',
    );
    assert.equal(isContentRootEnabled(space, '用例管理'), true);
    const created = ensureContentDirs(space, ['cases']);
    assert.deepEqual(created, ['用例管理']);
    assert.equal(fs.existsSync(path.join(space, '用例管理')), true);
    assert.equal(fs.existsSync(path.join(space, '知识库管理')), false, '没启用的插件仍不建目录');
    assert.deepEqual(ensureContentDirs(space, ['cases']), [], '已存在的目录不重复建');

    fs.rmSync(space, { recursive: true, force: true });
  });

  it('启动时把池内其它空间根目录的旧清单收进 .lantern/', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-pool-manifest-'));
    const sibling = path.join(root, '侧空间');
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(
      path.join(sibling, SPACE_MANIFEST_FILE),
      JSON.stringify({
        kind: 'ai-testbench-space',
        id: 'sp_side',
        name: '侧空间',
        createdAt: 1,
      }),
      'utf8',
    );

    prepareSpacesRoot(root);
    assert.equal(fs.existsSync(path.join(sibling, SPACE_MANIFEST_FILE)), false);
    assert.equal(fs.existsSync(path.join(sibling, '.lantern', SPACE_MANIFEST_FILE)), true);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
