import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  assistantDir,
  createBusinessAssistantService,
  expandUserMenuAllowlist,
  parseUserMenuCatalog,
} from '../../lh-plugins/business-map/assistant.mjs';

const system = {
  id: 'sys_assistant',
  name: '助手测试系统',
  description: '测试 AI 会话',
  entryUrl: 'https://example.com',
  sourceDir: '',
  directories: [],
  functions: [],
  flows: [],
};

const settings = {
  baseURL: 'https://model.example/v1',
  model: 'fake-model',
  apiKey: 'SECRET_NOT_PERSISTED',
};

async function waitFor(
  service: ReturnType<typeof createBusinessAssistantService>,
  root: string,
  status: string,
) {
  for (let index = 0; index < 100; index += 1) {
    const session = service.get(root, system);
    if (session.status === status) return session;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`会话没有进入 ${status}`);
}

afterEach(() => {
  // Each test owns and removes its temp directory in its body.
});

describe('业务地图持久化 AI 会话', () => {
  it('解析用户提供的层级菜单清单并忽略说明性文字', () => {
    const parsed = parseUserMenuCatalog(`按我提供的菜单清单识别功能目录：
- 工单受理
  - 新建工单
    - 受理详情
- 派单处理
  - 派单查询
  - 派单查询 > 全部派单

网页扫描只用于补页面证据，不要自动增加其他目录。`);
    assert.equal(parsed.requested, true);
    assert.deepEqual(
      parsed.menus.map((item: { path: string[] }) => item.path),
      [
        ['工单受理'],
        ['工单受理', '新建工单'],
        ['工单受理', '新建工单', '受理详情'],
        ['派单处理'],
        ['派单处理', '派单查询'],
        ['派单处理', '派单查询', '全部派单'],
      ],
    );
  });

  it('用户直接粘贴无列表符号的缩进菜单也能识别', () => {
    const parsed = parseUserMenuCatalog(`菜单清单：
工单受理
  新建工单
  留言查询

网页扫描只用于补充页面证据。`);
    assert.equal(parsed.requested, true);
    assert.deepEqual(
      parsed.menus.map((item: { path: string[] }) => item.path),
      [['工单受理'], ['工单受理', '新建工单'], ['工单受理', '留言查询']],
    );
  });

  it('平面白名单让一级菜单带出子菜单，并提升非一级独立菜单', () => {
    const parsed = parseUserMenuCatalog(`按我提供的菜单清单识别：
- 工单受理
- 工单查询

网页扫描只用于补充页面证据。`);
    const expanded = expandUserMenuAllowlist(parsed.menus, [
      { label: '首页', path: ['首页'], depth: 0, order: 0 },
      { label: '工单受理', path: ['工单受理'], depth: 0, order: 1 },
      { label: '新建工单', path: ['工单受理', '新建工单'], depth: 1, order: 2 },
      { label: '派单处理', path: ['派单处理'], depth: 0, order: 3 },
      { label: '工单查询', path: ['派单处理', '工单查询'], depth: 1, order: 4 },
      { label: '派单明细', path: ['派单处理', '工单查询', '派单明细'], depth: 2, order: 5 },
    ]);
    assert.deepEqual(
      expanded.map((item: { path: string[] }) => item.path),
      [['工单受理'], ['工单受理', '新建工单'], ['工单查询'], ['工单查询', '派单明细']],
    );
  });

  it('第一阶段使用页面证据生成目录草案并在应用后开放流程', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-assistant-'));
    const appliedRevisions: number[] = [];
    const service = createBusinessAssistantService({
      pages: async () => ({
        pages: [
          {
            id: 'pg_1',
            title: '新建工单',
            url: 'https://example.com/new',
            menuPath: ['工单受理', '新建工单'],
          },
        ],
        evidence: [
          {
            id: 'src_page',
            type: 'page',
            title: '新建工单',
            ref: 'https://example.com/new',
            content: '新建工单页面用于登记诉求并提交工单',
          },
        ],
        issues: [],
      }),
      applyDirectoryProposal: (
        _root: string,
        _systemId: string,
        proposal: unknown,
        revision: number,
      ) => {
        appliedRevisions.push(revision);
        return {
          store: { revision: revision + 1, systems: [] },
          applied: { directories: 1, functions: 1, flows: 0 },
        };
      },
      applyFlowProposal: (
        _root: string,
        _systemId: string,
        proposal: { flows: unknown[] },
        revision: number,
      ) => ({
        store: { revision: revision + 1, systems: [] },
        applied: { directories: 0, functions: 0, flows: proposal.flows.length },
      }),
      model: async () => ({
        value: {
          message: '已识别工单受理目录。',
          directories: [
            {
              key: 'd1',
              parentKey: '',
              name: '工单受理',
              menuPath: ['工单受理'],
            },
          ],
          functions: [
            {
              name: '新建工单',
              directoryKey: 'd1',
              purpose: '登记诉求并提交工单',
              entry: '/new',
              menuPath: ['工单受理', '新建工单'],
              evidence: [
                {
                  sourceId: 'src_page',
                  quote: '新建工单页面用于登记诉求并提交工单',
                },
              ],
            },
          ],
          warnings: [],
        },
        usage: { total_tokens: 10 },
      }),
    });
    try {
      assert.throws(
        () => service.start(root, system, { phase: 'flow', message: '识别流程' }, settings),
        /先识别并应用功能目录/,
      );
      service.start(root, system, { phase: 'directory', message: '识别功能目录' }, settings);
      const ready = await waitFor(service, root, 'awaiting_confirmation');
      assert.equal(ready.proposal?.kind, 'directory');
      assert.equal(ready.proposal?.functions.length, 1);
      assert.ok(ready.events.some((event: { title: string }) => event.title === 'scan_navigation'));
      const saved = fs.readFileSync(
        path.join(root, '.lantern', 'local', 'business-map', 'assistant', `${system.id}.json`),
        'utf8',
      );
      assert.ok(!saved.includes(settings.apiKey));

      const result = await service.apply(root, system, { revision: 1 });
      assert.equal(result.session.directoryApplied, true);
      assert.equal(result.session.phase, 'flow');
      assert.equal(appliedRevisions[0], 1);
    } finally {
      service.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('使用真实菜单清单补齐目录并保持菜单顺序', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-assistant-menu-'));
    const service = createBusinessAssistantService({
      pages: async () => ({
        pages: [
          {
            id: 'pg_menu',
            title: '工单系统',
            url: 'https://example.com',
          },
        ],
        evidence: [
          {
            id: 'src_menu',
            type: 'page',
            title: '工单系统',
            ref: 'https://example.com',
            content: '首页、工单查询、工单受理、新建工单和派单处理',
          },
        ],
        issues: [],
        navigation: [
          { label: '首页', path: ['首页'], depth: 0, order: 0 },
          { label: '工单查询', path: ['工单查询'], depth: 0, order: 1 },
          { label: '工单受理', path: ['工单受理'], depth: 0, order: 2 },
          { label: '新建工单', path: ['工单受理', '新建工单'], depth: 1, order: 3 },
          { label: '派单处理', path: ['派单处理'], depth: 0, order: 4 },
        ],
      }),
      applyDirectoryProposal: () => ({ store: {}, applied: {} }),
      applyFlowProposal: () => ({ store: {}, applied: {} }),
      model: async () => ({
        value: {
          message: '目录草案',
          directories: [
            { key: 'd1', parentKey: '', name: '首页', menuPath: ['首页'] },
            { key: 'd2', parentKey: '', name: '工单受理', menuPath: ['工单受理'] },
          ],
          functions: [
            {
              name: '新建工单',
              directoryKey: 'd2',
              purpose: '登记工单',
              entry: 'https://example.com/new',
              menuPath: ['工单受理', '新建工单'],
              evidence: [{ sourceId: 'src_menu', quote: '新建工单和派单处理' }],
            },
          ],
          warnings: [],
        },
        usage: {},
      }),
    });
    try {
      service.start(root, system, { phase: 'directory', message: '识别菜单' }, settings);
      const ready = await waitFor(service, root, 'awaiting_confirmation');
      assert.deepEqual(
        ready.proposal?.directories.map((directory: { name: string }) => directory.name),
        ['工单受理'],
      );
      assert.deepEqual(ready.proposal?.directories[0].menuPath, ['工单受理']);
      assert.deepEqual(
        ready.proposal?.functions.map(
          (fn: { name: string; directoryKey: string; menuRoot?: boolean }) => ({
            name: fn.name,
            directoryKey: fn.directoryKey,
            menuRoot: fn.menuRoot === true,
          }),
        ),
        [
          { name: '首页', directoryKey: '', menuRoot: true },
          { name: '工单查询', directoryKey: '', menuRoot: true },
          { name: '新建工单', directoryKey: ready.proposal?.directories[0].key, menuRoot: false },
          { name: '派单处理', directoryKey: '', menuRoot: true },
        ],
      );
      assert.ok(ready.proposal?.warnings.some((warning: string) => warning.includes('叶子菜单')));
    } finally {
      service.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('AI 改名菜单或按业务语义归组时仍按真实 menuPath 一比一还原', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-assistant-exact-menu-'));
    let prompt = '';
    const service = createBusinessAssistantService({
      pages: async () => ({
        pages: [
          {
            id: 'pg_exact_menu',
            title: '工单系统',
            url: 'https://example.com/work-order',
          },
        ],
        evidence: [
          {
            id: 'src_exact_menu',
            type: 'page',
            title: '工单系统',
            ref: 'https://example.com/work-order',
            content: '工单指导审核页面用于复核；诉求单受理页面用于登记诉求单。',
          },
        ],
        navigation: [
          { label: '工单指导审核', path: ['工单指导审核'], depth: 0, order: 0 },
          { label: '诉求单受理', path: ['诉求单受理'], depth: 0, order: 1 },
        ],
        issues: [],
      }),
      applyDirectoryProposal: () => ({ store: {}, applied: {} }),
      applyFlowProposal: () => ({ store: {}, applied: {} }),
      model: async (_settings: unknown, messages: Array<{ content: string }>) => {
        prompt = messages.map((message) => message.content).join('\n');
        return {
          value: {
            message: '按业务语义整理了目录。',
            directories: [
              {
                key: 'guide',
                parentKey: '',
                name: '工单指导与回复',
                menuPath: ['工单指导审核'],
              },
              {
                key: 'intake',
                parentKey: '',
                name: '诉求单管理',
                menuPath: ['诉求单受理'],
              },
            ],
            functions: [
              {
                name: '工单指导审核',
                directoryKey: 'guide',
                purpose: '复核工单指导',
                entry: '/guide/review',
                menuPath: ['工单指导审核'],
                evidence: [
                  {
                    sourceId: 'src_exact_menu',
                    quote: '工单指导审核页面用于复核',
                  },
                ],
              },
              {
                name: '诉求单受理',
                directoryKey: 'intake',
                purpose: '登记诉求单',
                entry: '/request/intake',
                menuPath: ['诉求单受理'],
                evidence: [
                  {
                    sourceId: 'src_exact_menu',
                    quote: '诉求单受理页面用于登记诉求单',
                  },
                ],
              },
            ],
            warnings: [],
          },
          usage: {},
        };
      },
    });
    try {
      service.start(root, system, { phase: 'directory', message: '识别菜单' }, settings);
      const ready = await waitFor(service, root, 'awaiting_confirmation');
      assert.deepEqual(
        ready.proposal?.directories.map((directory: { name: string }) => directory.name),
        [],
      );
      assert.deepEqual(
        ready.proposal?.functions.map(
          (fn: { name: string; directoryKey: string; menuRoot?: boolean }) => ({
            name: fn.name,
            directoryKey: fn.directoryKey,
            menuRoot: fn.menuRoot === true,
          }),
        ),
        [
          { name: '工单指导审核', directoryKey: '', menuRoot: true },
          { name: '诉求单受理', directoryKey: '', menuRoot: true },
        ],
      );
      assert.match(prompt, /hasChildren=false 的叶子菜单对应功能/);
      const guide = ready.proposal?.functions.find(
        (fn: { name: string }) => fn.name === '工单指导审核',
      );
      assert.equal(guide?.purpose, '复核工单指导');
      assert.equal(guide?.entry, '/guide/review');
      assert.equal(guide?.evidence[0].type, 'page');
      assert.equal(guide?.evidence[0].ref, 'https://example.com/work-order');
      assert.equal(guide?.evidence[0].note, '工单指导审核页面用于复核');
    } finally {
      service.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('用户菜单清单优先时不回填网页扫描到的错误菜单', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-assistant-user-menu-'));
    let prompt = '';
    const service = createBusinessAssistantService({
      pages: async () => ({
        pages: [
          {
            id: 'pg_user_menu',
            title: '派单查询',
            url: 'https://example.com/dispatch/query',
          },
        ],
        evidence: [
          {
            id: 'src_user_menu',
            type: 'page',
            title: '派单查询',
            ref: 'https://example.com/dispatch/query',
            content: '派单查询页面用于查询已处理和待处理的派单记录',
          },
        ],
        navigation: [
          { label: '错误目录', path: ['错误目录'], depth: 0, order: 0 },
          { label: '系统设置', path: ['系统设置'], depth: 0, order: 1 },
        ],
        issues: [],
      }),
      applyDirectoryProposal: () => ({ store: {}, applied: {} }),
      applyFlowProposal: () => ({ store: {}, applied: {} }),
      model: async (_settings: unknown, messages: Array<{ content: string }>) => {
        prompt = messages.map((message) => message.content).join('\n');
        return {
          value: {
            message: '按用户菜单整理完成。',
            directories: [
              { key: 'd1', parentKey: '', name: '工单受理', menuPath: ['工单受理'] },
              { key: 'd2', parentKey: '', name: '派单处理', menuPath: ['派单处理'] },
              { key: 'wrong', parentKey: '', name: '错误目录', menuPath: ['错误目录'] },
            ],
            functions: [
              {
                name: '派单查询',
                directoryKey: 'd2',
                purpose: '查询派单记录',
                entry: '/dispatch/query',
                menuPath: ['派单处理', '派单查询'],
                evidence: [
                  {
                    sourceId: 'src_user_menu',
                    quote: '派单查询页面用于查询已处理和待处理的派单记录',
                  },
                ],
              },
              {
                name: '错误功能',
                directoryKey: 'wrong',
                purpose: '不应进入草案',
                entry: '/wrong',
                menuPath: ['错误目录', '错误功能'],
                evidence: [
                  {
                    sourceId: 'src_user_menu',
                    quote: '派单查询页面用于查询已处理和待处理的派单记录',
                  },
                ],
              },
            ],
            warnings: [],
          },
          usage: {},
        };
      },
    });
    try {
      service.start(
        root,
        system,
        {
          phase: 'directory',
          message: `按我提供的菜单清单识别功能目录：
- 工单受理
  - 新建工单
- 派单处理
  - 派单查询`,
        },
        settings,
      );
      const ready = await waitFor(service, root, 'awaiting_confirmation');
      assert.deepEqual(
        ready.proposal?.directories.map((directory: { name: string }) => directory.name),
        ['工单受理', '派单处理'],
      );
      assert.deepEqual(
        ready.proposal?.functions
          .map((fn: { name: string }) => fn.name)
          .sort((left: string, right: string) => left.localeCompare(right, 'zh-CN')),
        ['派单查询', '新建工单'],
      );
      assert.match(prompt, /"menuCatalogSource":"user"/);
      assert.ok(
        ready.events.some((event: { title: string }) => event.title === '已锁定用户菜单清单'),
      );
      assert.equal(ready.userMenuCatalog.length, 4);
      service.start(
        root,
        system,
        { phase: 'directory', message: '补充派单查询的页面入口，其他保持不变' },
        settings,
      );
      const refined = await waitFor(service, root, 'awaiting_confirmation');
      assert.deepEqual(refined.userMenuCatalog, ready.userMenuCatalog);
      assert.deepEqual(
        refined.proposal?.directories.map((directory: { name: string }) => directory.name),
        ['工单受理', '派单处理'],
      );
      assert.match(prompt, /"menuCatalogSource":"user"/);

      service.start(
        root,
        system,
        { phase: 'directory', message: '按我提供的菜单清单识别：\n- 系统设置' },
        settings,
      );
      const replaced = await waitFor(service, root, 'awaiting_confirmation');
      assert.deepEqual(
        replaced.userMenuCatalog.map((item: { label: string }) => item.label),
        ['系统设置'],
      );
    } finally {
      service.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('同级叶子菜单按采集顺序排序，保留模型生成的入口和证据', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-assistant-leaf-order-'));
    const service = createBusinessAssistantService({
      pages: async () => ({
        pages: [{ id: 'p', title: '管理', url: 'https://example.com' }],
        evidence: [{ id: 's', content: '菜单甲展示记录，菜单乙管理记录。' }],
        navigation: [
          { label: '管理', path: ['管理'], order: 0 },
          { label: '菜单甲', path: ['管理', '菜单甲'], order: 1 },
          { label: '菜单乙', path: ['管理', '菜单乙'], order: 2 },
          { label: '菜单丙', path: ['管理', '菜单丙'], order: 3 },
        ],
        issues: [],
      }),
      applyDirectoryProposal: () => ({ store: {}, applied: {} }),
      applyFlowProposal: () => ({ store: {}, applied: {} }),
      model: async () => ({
        value: {
          directories: [{ key: 'd', name: '管理', parentKey: '', menuPath: ['管理'] }],
          functions: ['菜单乙', '菜单甲'].map((name) => ({
            name,
            directoryKey: 'd',
            menuPath: ['管理', name],
            purpose: name,
            entry: `/${name}`,
            evidence: [{ sourceId: 's', quote: '菜单甲展示记录' }],
          })),
        },
        usage: {},
      }),
    });
    try {
      service.start(root, system, { message: '识别菜单' }, settings);
      const ready = await waitFor(service, root, 'awaiting_confirmation');
      assert.deepEqual(
        ready.proposal?.functions.map((fn: { name: string }) => fn.name),
        ['菜单甲', '菜单乙', '菜单丙'],
      );
      assert.equal(ready.proposal?.functions[0].entry, '/菜单甲');
      assert.equal(ready.proposal?.functions[0].evidence[0].type, 'page');
    } finally {
      service.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('用户菜单清单模式没有解析到菜单时立即提示输入格式', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-assistant-user-menu-empty-'));
    const service = createBusinessAssistantService({
      pages: async () => ({ pages: [], evidence: [], issues: [] }),
      applyDirectoryProposal: () => ({ store: {}, applied: {} }),
      applyFlowProposal: () => ({ store: {}, applied: {} }),
      model: async () => ({ value: {}, usage: {} }),
    });
    try {
      assert.throws(
        () =>
          service.start(
            root,
            system,
            { phase: 'directory', message: '按我提供的菜单清单识别功能目录' },
            settings,
          ),
        /没有读取到层级菜单/,
      );
    } finally {
      service.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('服务重启后保留历史并把运行中会话标记为中断', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-assistant-restart-'));
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = createBusinessAssistantService({
      pages: async () => {
        await gate;
        return { pages: [], evidence: [], issues: [] };
      },
      applyDirectoryProposal: () => ({ store: {}, applied: {} }),
      applyFlowProposal: () => ({ store: {}, applied: {} }),
      model: async () => ({ value: {}, usage: {} }),
    });
    try {
      first.start(root, system, { phase: 'directory', message: '开始识别' }, settings);
      await new Promise((resolve) => setTimeout(resolve, 20));
      first.close();
      release();

      const second = createBusinessAssistantService({
        pages: async () => ({ pages: [], evidence: [], issues: [] }),
        applyDirectoryProposal: () => ({ store: {}, applied: {} }),
        applyFlowProposal: () => ({ store: {}, applied: {} }),
        model: async () => ({ value: {}, usage: {} }),
      });
      try {
        const session = second.get(root, system);
        assert.equal(session.status, 'interrupted');
        assert.ok(session.messages.some((message: { role: string }) => message.role === 'user'));
        assert.ok(session.events.length > 0);
      } finally {
        second.close();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('模型长时间无响应时持续推送等待进度并超时停止', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-assistant-timeout-'));
    const service = createBusinessAssistantService({
      pages: async () => ({
        pages: [
          {
            id: 'pg_timeout',
            title: '超时测试页',
            url: 'https://example.com/timeout',
          },
        ],
        evidence: [
          {
            id: 'src_timeout',
            type: 'page',
            title: '超时测试页',
            ref: 'https://example.com/timeout',
            content: '用于测试模型超时的页面正文',
          },
        ],
        issues: [],
      }),
      applyDirectoryProposal: () => ({ store: {}, applied: {} }),
      applyFlowProposal: () => ({ store: {}, applied: {} }),
      model: async (_settings: unknown, _messages: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            {
              once: true,
            },
          );
        }),
      modelTimeoutMs: 40,
      modelHeartbeatMs: 8,
    });
    try {
      service.start(root, system, { phase: 'directory', message: '测试模型超时' }, settings);
      const failed = await waitFor(service, root, 'error');
      assert.equal(failed.status, 'error');
      assert.ok(
        failed.events.some((event: { title: string }) =>
          event.title.includes('模型正在生成识别草案（已等待'),
        ),
      );
      assert.ok(
        failed.events.some((event: { detail?: string }) => event.detail?.includes('秒内没有响应')),
      );
      assert.equal(failed.fallback?.available, true);
      assert.equal(failed.fallback?.recommendedAction, 'client_fallback');
      assert.ok(failed.fallback?.promptChars > 0);
      const fallback = service.context(root, system, { maxChars: 10_000 });
      assert.equal(fallback.fallback.canGenerateDirectory, true);
      assert.equal(fallback.sources[0].sourceId, 'src_timeout');
      assert.match(fallback.sources[0].content, /模型超时/);
    } finally {
      service.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('检测到登录页时让已保存登录态失效', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-assistant-login-expired-'));
    let invalidated = 0;
    const service = createBusinessAssistantService({
      pages: async () => ({
        pages: [],
        evidence: [],
        navigation: [],
        issues: ['登录态失效：检测到登录页面，请更新登录态后重试'],
      }),
      applyDirectoryProposal: () => ({ store: {}, applied: {} }),
      applyFlowProposal: () => ({ store: {}, applied: {} }),
      invalidateLogin: async () => {
        invalidated += 1;
      },
      model: async () => ({ value: {}, usage: {} }),
    });
    try {
      service.start(root, system, { phase: 'directory', message: '测试登录失效' }, settings);
      const failed = await waitFor(service, root, 'error');
      assert.equal(invalidated, 1);
      assert.equal(failed.fallback?.available, false);
      assert.equal(failed.fallback?.recommendedAction, 'retry_login');
      const fallback = service.context(root, system);
      assert.equal(fallback.fallback.available, false);
      assert.equal(fallback.fallback.canGenerateDirectory, false);
      assert.deepEqual(fallback.sources, []);
    } finally {
      service.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('旧 codex_fallback 会话值兼容映射为 client_fallback', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-assistant-legacy-fallback-'));
    const service = createBusinessAssistantService({
      pages: async () => ({ pages: [], evidence: [], issues: [] }),
      applyDirectoryProposal: () => ({ store: {}, applied: {} }),
      applyFlowProposal: () => ({ store: {}, applied: {} }),
      model: async () => ({ value: {}, usage: {} }),
    });
    try {
      const file = path.join(assistantDir(root), `${system.id}.json`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          systemId: system.id,
          phase: 'directory',
          status: 'error',
          runId: '',
          seq: 1,
          messages: [],
          events: [],
          progress: { label: '失败', current: 0, total: 0, percent: 0 },
          proposal: null,
          fallback: {
            available: true,
            recommendedAction: 'codex_fallback',
            reason: '旧值',
            pageCount: 1,
            menuCount: 1,
            evidenceCount: 1,
            sourceChars: 10,
            promptChars: 100,
            promptApproxTokens: 34,
            model: 'legacy-model',
            issues: [],
            updatedAt: '2026-11-24T00:00:00.000Z',
          },
          directoryApplied: false,
          flowApplied: false,
        }),
      );
      assert.equal(service.get(root, system).fallback?.recommendedAction, 'client_fallback');
    } finally {
      service.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('模型没有业务功能时仍保留真实叶子菜单，不生成空目录', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-assistant-empty-'));
    const service = createBusinessAssistantService({
      pages: async () => ({
        pages: [{ id: 'pg_empty', title: '新建工单', url: 'https://example.com/new' }],
        evidence: [
          {
            id: 'src_empty',
            type: 'page',
            title: '新建工单',
            ref: 'https://example.com/new',
            content: '新建工单页面用于登记诉求',
          },
        ],
        navigation: [{ label: '工单受理', path: ['工单受理'], order: 0 }],
        issues: [],
      }),
      applyDirectoryProposal: () => ({ store: {}, applied: {} }),
      applyFlowProposal: () => ({ store: {}, applied: {} }),
      model: async () => ({
        value: { message: '没有可用功能', directories: [], functions: [], warnings: [] },
        usage: {},
      }),
    });
    try {
      service.start(root, system, { phase: 'directory', message: '测试空草案' }, settings);
      const ready = await waitFor(service, root, 'awaiting_confirmation');
      assert.deepEqual(
        ready.proposal?.directories.map((directory: { name: string }) => directory.name),
        [],
      );
      assert.deepEqual(
        ready.proposal?.functions.map((fn: { name: string; menuRoot?: boolean }) => ({
          name: fn.name,
          menuRoot: fn.menuRoot === true,
        })),
        [{ name: '工单受理', menuRoot: true }],
      );
    } finally {
      service.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('模型上下文会去掉多页重复导航，只保留页面特定内容', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-assistant-compact-'));
    let prompt = '';
    const service = createBusinessAssistantService({
      pages: async () => ({
        pages: [
          { id: 'pg_1', title: '新建工单', url: 'https://example.com/new' },
          { id: 'pg_2', title: '派单处理', url: 'https://example.com/dispatch' },
          { id: 'pg_3', title: '退单处理', url: 'https://example.com/return' },
        ],
        evidence: [
          {
            id: 'src_1',
            type: 'page',
            title: '新建工单',
            ref: 'https://example.com/new',
            content: '公共左侧导航\n新建工单页面用于登记诉求',
          },
          {
            id: 'src_2',
            type: 'page',
            title: '派单处理',
            ref: 'https://example.com/dispatch',
            content: '公共左侧导航\n派单页面用于选择承办单位',
          },
          {
            id: 'src_3',
            type: 'page',
            title: '退单处理',
            ref: 'https://example.com/return',
            content: '公共左侧导航\n退单页面用于补充退单原因',
          },
        ],
        navigation: [],
        issues: [],
      }),
      applyDirectoryProposal: () => ({ store: {}, applied: {} }),
      applyFlowProposal: () => ({ store: {}, applied: {} }),
      model: async (_settings: unknown, messages: Array<{ content: string }>) => {
        prompt = messages.map((message) => message.content).join('\n');
        return {
          value: {
            message: 'ok',
            directories: [{ key: 'd1', parentKey: '', name: '工单受理', menuPath: ['工单受理'] }],
            functions: [
              {
                name: '新建工单',
                directoryKey: 'd1',
                purpose: '登记诉求',
                entry: 'https://example.com/new',
                menuPath: ['工单受理', '新建工单'],
                evidence: [{ sourceId: 'src_1', quote: '新建工单页面用于登记诉求' }],
              },
            ],
            warnings: [],
          },
          usage: {},
        };
      },
    });
    try {
      service.start(root, system, { phase: 'directory', message: '测试压缩' }, settings);
      await waitFor(service, root, 'awaiting_confirmation');
      assert.doesNotMatch(prompt, /公共左侧导航/);
      assert.match(prompt, /新建工单页面用于登记诉求/);
      assert.match(prompt, /派单页面用于选择承办单位/);
      assert.match(prompt, /退单页面用于补充退单原因/);
    } finally {
      service.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
