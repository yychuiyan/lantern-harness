import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  prepareStorePath,
  readableStorePath,
  taskStorePath,
  todoStorePath,
} from '../../lh-plugins/lh-work-store.mjs';
import { spaceLocalFile } from '../../builtin/session/space-layout.mjs';

describe('lh-work-store', () => {
  let tmp = '';

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-work-store-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('数据放在跟菜单对应的空间文件夹里', () => {
    assert.equal(todoStorePath(tmp), path.join(tmp, '待办事项', '待办.json'));
    assert.equal(taskStorePath(tmp), path.join(tmp, '任务管理', '任务.json'));
  });

  it('首次读写把 .lantern/local 里的旧数据搬出来', () => {
    const legacy = spaceLocalFile(tmp, 'todos.json');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, '{"version":1,"items":[]}\n', 'utf8');

    const fp = prepareStorePath(tmp, 'todos');
    assert.equal(fp, todoStorePath(tmp));
    assert.equal(fs.existsSync(fp), true);
    assert.equal(fs.existsSync(legacy), false);
    assert.equal(fs.readFileSync(fp, 'utf8'), '{"version":1,"items":[]}\n');
  });

  it('新旧位置都有时以新位置为准，不覆盖现有数据', () => {
    const next = todoStorePath(tmp);
    const legacy = spaceLocalFile(tmp, 'todos.json');
    fs.mkdirSync(path.dirname(next), { recursive: true });
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(next, '{"version":1,"items":["new"]}\n', 'utf8');
    fs.writeFileSync(legacy, '{"version":1,"items":["old"]}\n', 'utf8');

    assert.equal(prepareStorePath(tmp, 'todos'), next);
    assert.equal(fs.readFileSync(next, 'utf8'), '{"version":1,"items":["new"]}\n');
  });

  it('只读引用优先新位置，找不到时回退旧位置', () => {
    const legacy = spaceLocalFile(tmp, 'tasks.json');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, '{}', 'utf8');
    assert.equal(readableStorePath(tmp, 'tasks'), legacy);
  });
});
