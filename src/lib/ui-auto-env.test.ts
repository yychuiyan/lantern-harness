import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  envExampleFile,
  envFileName,
  envFilePath,
  envTaskMismatch,
  isExampleFileName,
  isSkeletonEnv,
  isSecretKey,
  maskEnvEntries,
  mergeEnvText,
  migrateLegacyExampleFile,
  parseEnvText,
  patchEnvText,
  readEnvKeyMatrix,
  readEnvSchema,
  sanitizeEnvName,
  scanEnvFiles,
  validateEnvEntries,
} from '../../lh-plugins/uiauto-env.mjs';

/** 临时项目目录：测试 schema / 跨环境矩阵用 */
const TMP_ROOTS: string[] = [];
function makeProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-env-'));
  TMP_ROOTS.push(dir);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf8');
  }
  return dir;
}
after(() => {
  for (const dir of TMP_ROOTS) fs.rmSync(dir, { recursive: true, force: true });
});

const ORIGINAL = [
  '# 团队共用默认值',
  'ENV=dev',
  '',
  'BASE_URL=https://dev.example.com',
  'ADMIN_USERNAME=admin',
  'ADMIN_PASSWORD=secret',
  'CUSTOM_FLAG=1 # 保留这行注释',
  '',
  'export LEGACY=yes',
  '',
].join('\n');

describe('parseEnvText', () => {
  it('识别 KEY / export KEY，忽略注释与空行', () => {
    const parsed = parseEnvText(ORIGINAL);
    assert.deepEqual(
      parsed.entries.map((entry: { key: string }) => entry.key),
      ['ENV', 'BASE_URL', 'ADMIN_USERNAME', 'ADMIN_PASSWORD', 'CUSTOM_FLAG', 'LEGACY'],
    );
    assert.equal(
      parsed.entries.find((entry: { key: string }) => entry.key === 'CUSTOM_FLAG').value,
      '1',
    );
  });

  it('引号里的 # 不算注释，未加引号的才算', () => {
    const parsed = parseEnvText('A="p#ss" # 注释\nB=plain # 注释\nC=\n');
    const valueOf = (key: string) =>
      parsed.entries.find((entry: { key: string }) => entry.key === key)?.value;
    assert.equal(valueOf('A'), 'p#ss');
    assert.equal(valueOf('B'), 'plain');
    assert.equal(valueOf('C'), '');
  });
});

describe('patchEnvText', () => {
  it('只改命中的行，注释 / 空行 / 未知变量原样保留', () => {
    const next = patchEnvText(ORIGINAL, { BASE_URL: 'https://test.example.com' });
    assert.match(next, /BASE_URL=https:\/\/test\.example\.com\n/);
    assert.match(next, /# 团队共用默认值/);
    assert.match(next, /CUSTOM_FLAG=1 # 保留这行注释/);
    assert.match(next, /export LEGACY=yes/);
    // 未提交的 key 一个都没变
    assert.match(next, /ADMIN_PASSWORD=secret/);
    const lines = next.split('\n');
    assert.equal(lines.filter((line) => line.startsWith('BASE_URL=')).length, 1);
  });

  it('保留行尾注释与 export 前缀', () => {
    const next = patchEnvText(ORIGINAL, { CUSTOM_FLAG: '2', LEGACY: 'no' });
    assert.match(next, /CUSTOM_FLAG=2 # 保留这行注释/);
    assert.match(next, /export LEGACY=no/);
  });

  it('缺失的 key 追加到末尾，保留结尾换行', () => {
    const next = patchEnvText(ORIGINAL, { NEW_KEY: 'v' });
    assert.ok(next.endsWith('\n'));
    assert.match(next, /\nNEW_KEY=v\n$/);
  });

  it('remove 整行删掉，结尾换行不变', () => {
    const next = patchEnvText(ORIGINAL, {}, ['CUSTOM_FLAG']);
    assert.doesNotMatch(next, /CUSTOM_FLAG/);
    assert.ok(next.endsWith('\n'));
  });

  it('值里有空格 / # 时自动加引号，读回来还是原值', () => {
    const next = patchEnvText('A=1\n', { LOGIN_API_BODY: '{"user":"a b"}' });
    // JSON 里的双引号不用转义：用单引号包住，dotenv 会原样读出来
    assert.match(next, /LOGIN_API_BODY='\{"user":"a b"\}'/);
    const parsed = parseEnvText(next);
    assert.equal(
      parsed.entries.find((entry: { key: string }) => entry.key === 'LOGIN_API_BODY').value,
      '{"user":"a b"}',
    );
  });

  it('原文件没有结尾换行时也不额外加', () => {
    const next = patchEnvText('A=1', { A: '2' });
    assert.equal(next, 'A=2');
  });
});

describe('maskEnvEntries', () => {
  it('密钥只回 hasValue，不回明文', () => {
    const masked = maskEnvEntries(parseEnvText(ORIGINAL).entries);
    const password = masked.find((entry: { key: string }) => entry.key === 'ADMIN_PASSWORD');
    assert.equal(password.value, '');
    assert.equal(password.hasValue, true);
    assert.equal(password.secret, true);
    // 非密钥照常回显
    const baseURL = masked.find((entry: { key: string }) => entry.key === 'BASE_URL');
    assert.equal(baseURL.value, 'https://dev.example.com');
  });

  it('自定义变量名像密钥也打码', () => {
    assert.equal(isSecretKey('GITHUB_TOKEN'), true);
    assert.equal(isSecretKey('CUSTOM_FLAG'), false);
    const masked = maskEnvEntries([{ key: 'GITHUB_TOKEN', value: 'abc' }]);
    assert.equal(masked[0].value, '');
    assert.equal(masked[0].hasValue, true);
  });
});

describe('环境名与文件路径', () => {
  it('只接受小写字母开头的短名', () => {
    assert.equal(sanitizeEnvName('uat'), 'uat');
    assert.equal(sanitizeEnvName('uat2'), 'uat2');
    assert.equal(sanitizeEnvName('uat-2'), 'uat-2');
    assert.equal(sanitizeEnvName(''), '');
    assert.equal(sanitizeEnvName('../x'), '');
    assert.equal(sanitizeEnvName('DEV'), '');
    assert.equal(sanitizeEnvName('a'.repeat(21)), '');
  });

  it('越界环境名不给路径', () => {
    const dir = path.resolve('/tmp/project');
    assert.equal(envFilePath(dir, '../x'), '');
    assert.equal(envFileName(''), '.env');
    assert.equal(envFilePath(dir, 'uat'), path.join(dir, '.env.uat'));
  });

  it('骨架自带的环境不给删：.env 与 .env.prod', () => {
    assert.equal(isSkeletonEnv(''), true);
    assert.equal(isSkeletonEnv('prod'), true);
    assert.equal(isSkeletonEnv('uat'), false);
    assert.equal(isSkeletonEnv('dev'), false);
  });
});

describe('模板文件识别', () => {
  it('只认 .env.example 与按环境拆的变体', () => {
    assert.equal(isExampleFileName('.env.example'), true);
    assert.equal(isExampleFileName('.env.uat.example'), true);
    assert.equal(isExampleFileName('.env.uat'), false);
    assert.equal(isExampleFileName('x.example'), false);
    assert.equal(isExampleFileName('ENV.example'), false);
  });

  it('优先用共用模板，没有再退到按环境的', () => {
    const withShared = makeProject({ '.env.example': 'A=1\n', '.env.uat.example': 'B=2\n' });
    assert.equal(path.basename(envExampleFile(withShared)), '.env.example');
    const onlyUat = makeProject({ '.env.uat.example': 'B=2\n' });
    assert.equal(path.basename(envExampleFile(onlyUat)), '.env.uat.example');
    assert.equal(envExampleFile(makeProject({})), '');
  });

  it('老骨架的 .env.dev.example / .env.test.example 归一到 .env.example', () => {
    const dir = makeProject({ '.env.dev.example': '# 开发环境\nENV=dev\nBASE_URL=http://x\n' });
    assert.equal(migrateLegacyExampleFile(dir), '.env.dev.example');
    assert.equal(path.basename(envExampleFile(dir)), '.env.example');
    assert.equal(fs.existsSync(path.join(dir, '.env.dev.example')), false);
    const text = fs.readFileSync(path.join(dir, '.env.example'), 'utf8');
    // 模板不留具体环境名：新建环境时按文件名重写
    assert.match(text, /\nENV=\n/);
    assert.doesNotMatch(text, /ENV=dev/);
    // 已经有 .env.example 时不动任何文件
    const shared = makeProject({ '.env.example': 'A=1\n', '.env.uat.example': 'B=2\n' });
    assert.equal(migrateLegacyExampleFile(shared), '');
    assert.equal(fs.existsSync(path.join(shared, '.env.uat.example')), true);
  });
});

describe('readEnvSchema', () => {
  it('分组标题与字段说明来自注释，占位符不展示', () => {
    const dir = makeProject({
      '.env.example': [
        '# 被测地址',
        'BASE_URL=https://dev.example.com',
        '',
        '# 登录账号',
        '# 管理员账号',
        'ADMIN_USERNAME=',
        'ADMIN_PASSWORD={{password}}',
        '',
        '# 手机号',
        'MOBILE=${mobile}',
        '',
      ].join('\n'),
    });
    const schema = readEnvSchema(dir);
    assert.equal(schema.source, '.env.example');
    assert.deepEqual(schema.keys, ['BASE_URL', 'ADMIN_USERNAME', 'ADMIN_PASSWORD', 'MOBILE']);
    // 单 key 分组：标题直接当字段名
    assert.equal(schema.blocks[0].title, '');
    assert.equal(schema.blocks[0].keys[0].label, '被测地址');
    assert.equal(schema.blocks[0].keys[0].placeholder, 'https://dev.example.com');
    // 多 key 分组：标题当组名，紧贴的注释当字段说明
    assert.equal(schema.blocks[1].title, '登录账号');
    assert.equal(schema.blocks[1].keys[0].hint, '管理员账号');
    // `{{...}}` / `${...}` 只当占位符，不进 placeholder
    assert.equal(schema.blocks[1].keys[1].placeholder, '');
    assert.equal(schema.blocks[2].keys[0].placeholder, '');
  });

  it('没有模板时返回空 schema', () => {
    const schema = readEnvSchema(makeProject({}));
    assert.equal(schema.source, '');
    assert.deepEqual(schema.blocks, []);
    assert.deepEqual(schema.keys, []);
  });

  it('注释掉的可选字段也收进 schema，并标 optional', () => {
    const dir = makeProject({
      '.env.example': [
        '# 可选：接口登录',
        '# LOGIN_API_PATH=/api/auth/login',
        '# LOGIN_API_BODY={"username":"{{username}}"}',
        '',
      ].join('\n'),
    });
    const schema = readEnvSchema(dir);
    assert.deepEqual(schema.keys, ['LOGIN_API_PATH', 'LOGIN_API_BODY']);
    assert.equal(schema.blocks[0].title, '可选：接口登录');
    assert.equal(schema.blocks[0].keys[0].optional, true);
    assert.equal(schema.blocks[0].keys[0].placeholder, '/api/auth/login');
    // 含模板变量的不当示例值
    assert.equal(schema.blocks[0].keys[1].placeholder, '');
  });
});

describe('readEnvKeyMatrix', () => {
  it('反查 key 出现在哪些环境，排除模板与当前环境', () => {
    const dir = makeProject({
      '.env.dev': 'ENV=dev\nSIP_HOST=1\nBASE_URL=https://dev\n',
      '.env.uat': 'ENV=uat\nSIP_HOST=2\nCHECK_IN_CODE=a\nBASE_URL=https://uat\n',
      '.env.uat.example': 'SIP_HOST=\n',
      '.env': 'BASE_URL=https://default\n',
    });
    const matrix = readEnvKeyMatrix(dir, 'dev') as {
      keyEnvs: Record<string, string[]>;
      envKeys: Record<string, string[]>;
    };
    assert.deepEqual(matrix.keyEnvs.SIP_HOST, ['uat']);
    assert.deepEqual(matrix.keyEnvs.CHECK_IN_CODE, ['uat']);
    assert.deepEqual(matrix.keyEnvs.BASE_URL, ['', 'uat']);
    // ENV 不作为跨环境候选
    assert.equal(matrix.keyEnvs.ENV, undefined);
    // 模板不参与
    assert.equal(matrix.envKeys['uat.example'], undefined);
  });

  it('值为空的 key 不算「已配置」', () => {
    const dir = makeProject({ '.env.uat': 'SIP_HOST=\nSIP_PORT=5060\n' });
    const matrix = readEnvKeyMatrix(dir, 'dev') as { keyEnvs: Record<string, string[]> };
    assert.equal(matrix.keyEnvs.SIP_HOST, undefined);
    assert.deepEqual(matrix.keyEnvs.SIP_PORT, ['uat']);
  });
});

describe('scanEnvFiles', () => {
  it('模板不算环境，共用 .env 的 env 是空串', () => {
    const dir = makeProject({
      '.env': 'BASE_URL=x\n',
      '.env.dev': 'ENV=dev\n',
      '.env.uat.example': 'SIP_HOST=\n',
    });
    assert.deepEqual(scanEnvFiles(dir), [
      { env: '', file: '.env' },
      { env: 'dev', file: '.env.dev' },
    ]);
  });
});

describe('validateEnvEntries', () => {
  it('BASE_URL 协议与结尾斜杠', () => {
    const bad = validateEnvEntries({ BASE_URL: 'dev.example.com' });
    assert.equal(
      bad.errors.some((item: { key: string }) => item.key === 'BASE_URL'),
      true,
    );
    const slash = validateEnvEntries({ BASE_URL: 'https://dev.example.com/' });
    assert.equal(
      slash.warnings.some((item: { key: string }) => item.key === 'BASE_URL'),
      true,
    );
  });

  it('账号与密码要成对（不认具体角色名）', () => {
    const result = validateEnvEntries({ SEAT_USERNAME: 'a', SEAT_PASSWORD: '' });
    assert.equal(
      result.warnings.some((item: { key: string }) => item.key === 'SEAT_PASSWORD'),
      true,
    );
    const paired = validateEnvEntries({ SEAT_USERNAME: 'a', SEAT_PASSWORD: 'b' });
    assert.equal(
      paired.warnings.some((item: { key: string }) => item.key === 'SEAT_PASSWORD'),
      false,
    );
  });

  it('业务字段不再被平台校验（模板说了算）', () => {
    const result = validateEnvEntries({ LOGIN_API_PATH: 'api/login' });
    assert.equal(result.warnings.length, 0);
  });

  it('prod 没开 ALLOW_PROD 只警告，不拦着保存（运行由 env-loader 拒绝）', () => {
    const result = validateEnvEntries({ ENV: 'prod' }, 'prod');
    assert.equal(result.errors.length, 0);
    assert.equal(
      result.warnings.some((item: { key: string }) => item.key === 'ALLOW_PROD'),
      true,
    );
    const allowed = validateEnvEntries({ ALLOW_PROD: 'true' }, 'prod');
    assert.equal(allowed.errors.length, 0);
    assert.equal(
      allowed.warnings.some((item: { key: string }) => item.key === 'ALLOW_PROD'),
      false,
    );
  });

  it('prod 缺 BASE_URL 或指向本机时提示（运行期由 env-loader 硬拒）', () => {
    const missing = validateEnvEntries({ ALLOW_PROD: 'true' }, 'prod');
    assert.equal(missing.errors.length, 0);
    assert.equal(
      missing.warnings.some((item: { key: string }) => item.key === 'BASE_URL'),
      true,
    );

    const loopback = validateEnvEntries(
      { ALLOW_PROD: 'true', BASE_URL: 'http://127.0.0.1:5173' },
      'prod',
    );
    const loopbackWarn = loopback.warnings.find((item: { key: string }) => item.key === 'BASE_URL');
    assert.ok(loopbackWarn, '本机地址在 prod 下要提示');
    assert.match(String(loopbackWarn.message), /本机/);

    const good = validateEnvEntries(
      { ALLOW_PROD: 'true', BASE_URL: 'https://prod.example.com' },
      'prod',
    );
    assert.equal(
      good.warnings.some((item: { key: string }) => item.key === 'BASE_URL'),
      false,
    );

    // test 环境照旧不提示：本地就打本机地址是正常用法
    const local = validateEnvEntries({ BASE_URL: 'http://localhost:5173' }, 'test');
    assert.equal(
      local.warnings.some((item: { key: string }) => item.key === 'BASE_URL'),
      false,
    );
  });
});

describe('mergeEnvText', () => {
  it('已有 key 只换值，新增 key 连注释一起追加', () => {
    const result = mergeEnvText(
      ORIGINAL,
      [
        '# SIP 自动应答（UDP）',
        'SIP_HOST=10.0.0.1',
        'SIP_PORT=5060',
        'BASE_URL=https://next.dev',
      ].join('\n'),
    );
    assert.equal(result.updated, 1);
    assert.equal(result.created, 2);
    assert.match(result.text, /BASE_URL=https:\/\/next\.dev/);
    assert.match(result.text, /# SIP 自动应答（UDP）\nSIP_HOST=10\.0\.0\.1\nSIP_PORT=5060/);
    // 原有注释保留
    assert.match(result.text, /CUSTOM_FLAG=1 # 保留这行注释/);
  });

  it('空行隔开的注释是分节标题，紧贴的注释是字段说明', () => {
    const text = [
      '# SIP 自动应答（UDP）',
      'CHECK_IN_CALL_URL=',
      '# 签入坐席工号',
      'CHECK_IN_CODE=1',
      '',
      '# 签入、内部呼叫',
      'CHECK_IN_STATUS=4',
    ].join('\n');
    const parsed = parseEnvText(mergeEnvText('', text).text);
    assert.equal(parsed.entries[0].section, 'SIP 自动应答（UDP）');
    assert.equal(parsed.entries[0].comment, '');
    assert.equal(parsed.entries[1].section, '');
    assert.equal(parsed.entries[1].comment, '签入坐席工号');
    assert.equal(parsed.entries[2].section, '签入、内部呼叫');
  });

  it('粘贴里留空不覆盖已有值', () => {
    const result = mergeEnvText('SIP_HOST=10.0.0.9\n', 'SIP_HOST=\nSIP_PORT=\n');
    assert.equal(result.updated, 0);
    assert.equal(result.created, 1);
    assert.match(result.text, /SIP_HOST=10\.0\.0\.9/);
    assert.match(result.text, /SIP_PORT=/);
  });

  it('没有可导入内容时原样返回', () => {
    const result = mergeEnvText(ORIGINAL, '# 只有注释\n\n');
    assert.equal(result.updated, 0);
    assert.equal(result.created, 0);
    assert.equal(result.text, ORIGINAL);
  });
});

describe('envTaskMismatch', () => {
  it('任务命令写死别的 ENV 时给提示', () => {
    const message = envTaskMismatch('cross-env ENV=uat playwright test', 'dev');
    assert.match(message, /ENV=uat/);
    assert.match(message, /ENV=dev/);
  });

  it('一致 / 没选环境 / 命令不带 ENV 都不提示', () => {
    assert.equal(envTaskMismatch('cross-env ENV=uat playwright test', 'uat'), '');
    assert.equal(envTaskMismatch('cross-env ENV=uat playwright test', ''), '');
    assert.equal(envTaskMismatch('npx playwright test', 'dev'), '');
  });
});
