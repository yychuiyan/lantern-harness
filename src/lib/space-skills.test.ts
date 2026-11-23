import type { SpaceSkill } from './space-skills';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import {
  migrateSpaceSkills,
  listSpaceSkills,
  getSpaceSkill,
  updateSpaceSkill,
  migratedPromptPath,
  loadSpaceSkill,
  syncPluginSkills,
  setSpaceSkillGroupEnabled,
  restoreSpaceSkill,
  createSpaceSkill,
  ensureSpaceSkillSeed,
  SPACE_SKILL_CATALOG,
} from '../../builtin/session/space-skills.mjs';
import { validateSkillOutput } from '../../builtin/session/skill-validation.mjs';
import {
  pluginPromptPath,
  readPluginPrompt,
  ensurePluginPrompt,
} from '../../lh-plugins/plugin-prompts.mjs';
import { spaceLocalFile } from '../../builtin/session/space-layout.mjs';
function fixture(run: (root: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-skills-'));
  try {
    fs.mkdirSync(path.join(root, '提示词管理'));
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
function source(root: string, name: string, body: string) {
  fs.writeFileSync(path.join(root, '提示词管理', name), body);
}
test('迁移原文完全保留、变体分组、重入幂等，并将已有业务读取指向canonical', () =>
  fixture((root) => {
    source(root, '默认提示词.md', '基础规则\n');
    source(root, '功能测试用例提示词.md', '自定义规则\n');
    source(root, '功能测试用例提示词_按需求合并场景.md', '合并规则\n');
    assert.equal(migrateSpaceSkills(root).added.length, 3);
    assert.equal(migrateSpaceSkills(root).added.length, 0);
    const index = JSON.parse(
      fs.readFileSync(path.join(root, '技能管理', 'index.json'), 'utf8'),
    ) as { version: number };
    assert.equal(index.version, 3);
    const list = listSpaceSkills(root);
    assert.equal(new Set(list.map((x: SpaceSkill) => x.group)).size, 2);
    const entry = list.find((x: SpaceSkill) => x.legacyPath === '功能测试用例提示词.md')!;
    assert.deepEqual(entry.pluginRefs, ['caseGen']);
    assert.equal(entry.source, 'bundled');
    assert.equal(entry.system, true);
    const skill = getSpaceSkill(root, entry.id);
    assert.equal(skill.content, '自定义规则\n');
    updateSpaceSkill(root, entry.id, { hash: skill.hash, content: '新规则\n' });
    assert.equal(readPluginPrompt('功能测试用例提示词.md', root), '新规则\n');
    assert.equal(
      fs.readFileSync(path.join(root, '提示词管理', '功能测试用例提示词.md'), 'utf8'),
      '自定义规则\n',
    );
    assert.equal(
      pluginPromptPath('功能测试用例提示词.md', root),
      migratedPromptPath(root, '功能测试用例提示词.md'),
    );
  }));
test('并发保存检测、历史恢复与空间隔离', () =>
  fixture((root) => {
    source(root, '用户技能.md', 'v1');
    migrateSpaceSkills(root);
    const entry = listSpaceSkills(root)[0],
      old = getSpaceSkill(root, entry.id);
    const next = updateSpaceSkill(root, entry.id, { hash: old.hash, content: 'v2' });
    assert.throws(
      () => updateSpaceSkill(root, entry.id, { hash: old.hash, content: '冲突' }),
      /已修改/,
    );
    const restored = restoreSpaceSkill(root, entry.id, 1, next.hash);
    assert.equal(restored.content, 'v1');
    assert.equal(restored.version, 3);
    fixture((other) => {
      assert.equal(listSpaceSkills(other).length, 0);
      assert.equal(loadSpaceSkill(other, entry.id), null);
    });
  }));
test('插件生命周期不覆盖修改，基础规则不可停用', () =>
  fixture((root) => {
    source(root, '默认提示词.md', '默认');
    source(root, '业务地图识别提示词.md', '我的取证口径');
    migrateSpaceSkills(root);
    const base = listSpaceSkills(root).find((x: SpaceSkill) => x.foundation)!;
    assert.throws(
      () =>
        updateSpaceSkill(root, base.id, {
          hash: getSpaceSkill(root, base.id).hash,
          enabled: false,
        }),
      /不可停用/,
    );
    assert.throws(() => setSpaceSkillGroupEnabled(root, base.group, false), /不可停用/);
    const config = spaceLocalFile(root, 'app.config.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ plugins: { businessMap: true } }));
    syncPluginSkills(root, 'businessMap', true);
    const entry = listSpaceSkills(root).find((x: SpaceSkill) => x.owner === 'businessMap')!;
    assert.deepEqual(entry.pluginRefs, ['businessMap']);
    assert.equal(entry.pluginActive, true);
    assert.equal(loadSpaceSkill(root, entry.key)?.ok, true);
    assert.equal(
      updateSpaceSkill(root, entry.id, {
        hash: getSpaceSkill(root, entry.id).hash,
        enabled: false,
      }).enabled,
      false,
    );
    assert.equal(loadSpaceSkill(root, entry.key)?.ok, false);
    fs.writeFileSync(config, JSON.stringify({ plugins: { businessMap: false } }));
    syncPluginSkills(root, 'businessMap', false);
    assert.equal(loadSpaceSkill(root, entry.key)?.ok, false);
    fs.writeFileSync(config, JSON.stringify({ plugins: { businessMap: true } }));
    syncPluginSkills(root, 'businessMap', true);
    assert.equal(loadSpaceSkill(root, entry.key)?.ok, false);
    assert.equal(getSpaceSkill(root, entry.id).content, '我的取证口径');
  }));
test('同一技能的变体统一启停，插件引用和内容版本不受开关影响', () =>
  fixture((root) => {
    source(root, '功能测试用例提示词.md', '规则一');
    source(root, '功能测试用例提示词_按需求合并场景.md', '规则二');
    migrateSpaceSkills(root);
    const group = listSpaceSkills(root)[0].group;
    const before = listSpaceSkills(root).filter((x: SpaceSkill) => x.group === group);
    const versions = before.map((x: SpaceSkill) => x.version);
    const off = setSpaceSkillGroupEnabled(root, group, false);
    const disabled = off.filter((x: SpaceSkill) => x.group === group);
    assert.ok(disabled.every((x: SpaceSkill) => !x.enabled));
    assert.deepEqual(
      disabled.map((x: SpaceSkill) => x.version),
      versions,
    );
    assert.ok(disabled.every((x: SpaceSkill) => x.pluginRefs[0] === 'caseGen'));
    const on = setSpaceSkillGroupEnabled(root, group, true);
    assert.ok(on.filter((x: SpaceSkill) => x.group === group).every((x: SpaceSkill) => x.enabled));
  }));
test('全量目录技能均可读、可加载，旧引用和资源包完整', () =>
  fixture((root) => {
    const catalog = SPACE_SKILL_CATALOG as Record<string, readonly string[]>;
    for (const file of Object.keys(catalog)) {
      source(root, file, `# ${file}\n只属于 ${file} 的规则\n`);
    }
    migrateSpaceSkills(root);
    const skills = listSpaceSkills(root);
    assert.equal(skills.length, Object.keys(catalog).length);
    assert.equal(new Set(skills.map((x: SpaceSkill) => x.group)).size, 16);
    for (const entry of skills) {
      const expectedRef = catalog[String(entry.legacyPath)]?.[2] || '';
      assert.deepEqual(entry.pluginRefs, expectedRef ? [expectedRef] : []);
      const detail = getSpaceSkill(root, entry.id);
      assert.match(detail.content, new RegExp(entry.legacyPath.replaceAll('.', '\\.')));
      assert.match(detail.instructions, new RegExp(entry.name.replaceAll('.', '\\.')));
      assert.equal(readPluginPrompt(entry.legacyPath, root), detail.content);
      assert.ok(detail.resources.includes('SKILL.md'));
      assert.ok(detail.resources.includes('references/business-rules.md'));
      assert.equal(detail.resources.includes('skill.json'), false);
      if (!entry.foundation) {
        assert.ok(detail.resources.includes('scripts/validate.mjs'));
        assert.equal(loadSpaceSkill(root, entry.key)?.ok, true);
        const script = path.join(
          path.dirname(migratedPromptPath(root, entry.legacyPath)!),
          '..',
          'scripts',
          'validate.mjs',
        );
        const output = execFileSync(process.execPath, [script], {
          input: JSON.stringify({
            rows: [{ id: 'C1', sourceRefs: ['R1'] }],
            columns: ['id', 'sourceRefs'],
            sourceIds: ['R1'],
          }),
        }).toString();
        assert.equal(JSON.parse(output).ok, true);
      }
    }
    const groups = [...new Set(skills.map((x: SpaceSkill) => x.group))];
    for (const group of groups) {
      const entries = skills.filter((x: SpaceSkill) => x.group === group);
      if (entries.some((x: SpaceSkill) => x.foundation)) continue;
      setSpaceSkillGroupEnabled(root, group, false);
      assert.ok(
        listSpaceSkills(root)
          .filter((x: SpaceSkill) => x.group === group)
          .every((x: SpaceSkill) => !x.enabled),
      );
      setSpaceSkillGroupEnabled(root, group, true);
      assert.ok(
        listSpaceSkills(root)
          .filter((x: SpaceSkill) => x.group === group)
          .every((x: SpaceSkill) => x.enabled),
      );
    }
  }));
test('新插件补种自动成为技能，已有修改不被种子覆盖', () =>
  fixture((root) => {
    ensurePluginPrompt('业务地图识别提示词.md', '种子正文', root);
    assert.equal(listSpaceSkills(root).length, 1);
    const entry = listSpaceSkills(root)[0],
      current = getSpaceSkill(root, entry.id);
    updateSpaceSkill(root, entry.id, { hash: current.hash, content: '用户修改' });
    ensurePluginPrompt('业务地图识别提示词.md', '新种子正文', root);
    assert.equal(readPluginPrompt('业务地图识别提示词.md', root), '用户修改');
  }));
test('插件种子升级同步到技能正文并提升版本', () =>
  fixture((root) => {
    ensurePluginPrompt('业务地图识别提示词.md', '第一版业务规则\n', root);
    const before = listSpaceSkills(root)[0];
    assert.equal(readPluginPrompt('业务地图识别提示词.md', root), '第一版业务规则\n');

    const upgraded = ensurePluginPrompt('业务地图识别提示词.md', '第二版业务规则\n', root);
    const after = listSpaceSkills(root)[0];
    assert.equal(upgraded.updated, true);
    assert.equal(readPluginPrompt('业务地图识别提示词.md', root), '第二版业务规则\n');
    assert.equal(after.version, before.version + 1);
  }));
test('通用技能种子同步：未改过自动升级，用户改过保持原样', () =>
  fixture((root) => {
    const created = ensureSpaceSkillSeed(root, '功能测试用例提示词.md', '# 第一版\n', 'caseGen');
    assert.equal(created.created, true);
    let entry = listSpaceSkills(root).find(
      (skill: SpaceSkill) => skill.legacyPath === '功能测试用例提示词.md',
    );
    assert.ok(entry);
    assert.ok(entry.pluginRefs.includes('caseGen'));
    assert.equal(getSpaceSkill(root, entry.id).content, '# 第一版\n');

    const upgraded = ensureSpaceSkillSeed(root, '功能测试用例提示词.md', '# 第二版\n', 'caseGen');
    entry = listSpaceSkills(root).find(
      (skill: SpaceSkill) => skill.legacyPath === '功能测试用例提示词.md',
    );
    assert.equal(upgraded.updated, true);
    assert.equal(getSpaceSkill(root, entry!.id).content, '# 第二版\n');

    const current = getSpaceSkill(root, entry!.id);
    updateSpaceSkill(root, entry!.id, {
      hash: current.hash,
      content: '# 用户修改版\n',
    });
    const kept = ensureSpaceSkillSeed(root, '功能测试用例提示词.md', '# 第三版\n', 'caseGen');
    assert.equal(kept.updated, false);
    assert.equal(getSpaceSkill(root, entry!.id).content, '# 用户修改版\n');
  }));
test('独立校验脚本确实可运行并报告错误，不执行模型', () =>
  fixture((root) => {
    source(root, '接口测试用例提示词.md', '规则');
    migrateSpaceSkills(root);
    const entry = listSpaceSkills(root)[0];
    const script = path.join(
      path.dirname(migratedPromptPath(root, entry.legacyPath)!),
      '..',
      'scripts',
      'validate.mjs',
    );
    const output = execFileSync(process.execPath, [script], {
      input: JSON.stringify({
        rows: [{ id: 'C1', sourceRefs: ['R1'] }],
        columns: ['id', 'sourceRefs'],
        sourceIds: ['R1'],
      }),
    }).toString();
    assert.equal(JSON.parse(output).ok, true);
  }));
test('校验表头、编号、引用、枚举、优先级、分数和统计；缺少上下文不假装已验证', () => {
  const result = validateSkillOutput({
    rows: [
      { id: 'x', sourceRefs: ['fake'], priority: 'P8', score: 101, status: 'bad' },
      { id: 'x', sourceRefs: [] },
    ],
    columns: ['id', 'sourceRefs', 'status'],
    sourceIds: ['real'],
    enums: { status: ['ok'] },
    stats: { total: 3, passed: 1, failed: 1 },
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 7);
  const warning = validateSkillOutput({ rows: [] });
  assert.ok(warning.warnings.length >= 2);
  assert.equal(validateSkillOutput({}).ok, false);
});
test('自定义技能可创建，路径和迁移符号链接受限', () =>
  fixture((root) => {
    const skill = createSpaceSkill(root, '技能一', '我的规则');
    assert.equal(skill.content, '我的规则');
    assert.ok(loadSpaceSkill(root, skill.id)?.ok);
    assert.throws(() => createSpaceSkill(root, '../escape', '规则'), /名称无效/);
    assert.throws(() => getSpaceSkill(root, '../escape'), /不存在/);
    const outside = path.join(root, 'external.md');
    fs.writeFileSync(outside, '外部数据');
    fs.symlinkSync(outside, path.join(root, '提示词管理', 'symlink.md'));
    assert.equal(migrateSpaceSkills(root).added.length, 0);
  }));

test('完整技能包导出导入不执行脚本，拒绝越界资源；迁移可安全回退', async () => {
  const { exportSpaceSkill, importSpaceSkill, rollbackSkillMigration } =
    await import('../../builtin/session/space-skills.mjs');
  fixture((root) => {
    source(root, '用户技能.md', '旧正文');
    migrateSpaceSkills(root);
    const original = listSpaceSkills(root)[0];
    const bundle = exportSpaceSkill(root, original.id);
    const imported = importSpaceSkill(root, bundle);
    assert.equal(imported.content, '旧正文');
    assert.throws(
      () =>
        importSpaceSkill(root, {
          schemaVersion: 1,
          name: 'bad',
          files: { 'SKILL.md': 'x', '../escape.md': 'no' },
        }),
      /路径/,
    );
    const current = getSpaceSkill(root, original.id);
    updateSpaceSkill(root, original.id, { hash: current.hash, content: '修改后正文' });
    assert.equal(rollbackSkillMigration(root).restored, 1);
    assert.equal(readPluginPrompt('用户技能.md', root), '修改后正文');
    assert.equal(listSpaceSkills(root).length, 1);
    assert.equal(listSpaceSkills(root)[0].id, imported.id);
  });
});

test('空间编辑的基础规则与技能编辑共用正文，新建技能兼容旧选择器路径', async () => {
  const { readSpaceSystemPrompt, writeSpaceSystemPrompt } = await import('../../cli/data-root.mjs');
  fixture((root) => {
    source(root, '默认提示词.md', '最初规则');
    migrateSpaceSkills(root);
    assert.equal(readSpaceSystemPrompt(root), '最初规则');
    writeSpaceSystemPrompt(root, '空间编辑后的规则');
    const foundation = listSpaceSkills(root).find((x: SpaceSkill) => x.foundation)!;
    assert.equal(getSpaceSkill(root, foundation.id).content.trim(), '空间编辑后的规则');
    const custom = createSpaceSkill(root, '可关联技能', '自定义规则');
    assert.ok(custom.legacyPath);
    assert.ok(fs.existsSync(path.join(root, '提示词管理', custom.legacyPath)));
    assert.equal(readPluginPrompt(custom.legacyPath, root), '自定义规则');
  });
});

test('先迁技能再升级旧Playwright文件名，仍保留旧别名与用户正文', async () => {
  const { migrateLegacyPluginPrompts } = await import('../../lh-plugins/plugin-prompts.mjs');
  fixture((root) => {
    source(root, 'Playwright提示词.md', '旧版自定义正文');
    migrateSpaceSkills(root);
    const original = listSpaceSkills(root)[0];
    migrateLegacyPluginPrompts(root);
    assert.equal(readPluginPrompt('Playwright提示词.md', root), '旧版自定义正文');
    assert.equal(readPluginPrompt('自动化执行提示词.md', root), '旧版自定义正文');
    assert.ok(fs.existsSync(path.join(root, '提示词管理', original.legacyPath)));
    assert.equal(migrateSpaceSkills(root).added.length, 0);
  });
});

test('旧 prompts/instructions.md 与 skill.json 自动迁移为标准 references 布局', () =>
  fixture((root) => {
    source(root, '需求分析提示词.md', '标准业务规则\n');
    migrateSpaceSkills(root);
    const entry = listSpaceSkills(root)[0];
    const dir = path.dirname(path.dirname(migratedPromptPath(root, entry.legacyPath)!));
    const standard = path.join(dir, 'references', 'business-rules.md');
    const legacy = path.join(dir, 'prompts', 'instructions.md');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.renameSync(standard, legacy);
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      fs
        .readFileSync(path.join(dir, 'SKILL.md'), 'utf8')
        .replace('references/business-rules.md', 'prompts/instructions.md'),
    );
    fs.writeFileSync(path.join(dir, 'skill.json'), '{}');

    migrateSpaceSkills(root);

    assert.ok(fs.existsSync(standard));
    assert.equal(fs.existsSync(path.join(dir, 'prompts')), false);
    assert.equal(fs.existsSync(path.join(dir, 'skill.json')), false);
    assert.match(
      fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'),
      /references\/business-rules\.md/,
    );
    assert.equal(readPluginPrompt(entry.legacyPath, root), '标准业务规则\n');
  }));
