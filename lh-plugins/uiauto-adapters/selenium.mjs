/**
 * Selenium 适配器：Java（Maven / Gradle）与 Node（selenium-webdriver）项目。
 *
 * - Python + selenium 由 pytest 适配器覆盖（跑的是 pytest，结果也走 JUnit XML）。
 * - 判定顺序：pom.xml → build.gradle → package.json(selenium-webdriver)。
 * - 结果统一解析 JUnit / surefire XML；HTML 报告有就快照，没有就只给汇总。
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  emptySummary,
  listFiles,
  mergeSummaries,
  parseJUnitXml,
  readSmall,
  text,
} from './shared.mjs';

export const id = 'selenium';
export const label = 'Selenium';
export const kind = 'ui';
export const controls = ['file', 'grep'];

const NODE_DEPS = ['selenium-webdriver', 'webdriverio'];

function findFlavor(probe) {
  if (probe.hasPom) {
    const pom = probe.readRel('pom.xml');
    if (/selenium/i.test(pom)) return { flavor: 'maven', evidence: ['pom.xml: selenium'] };
  }
  if (probe.hasGradle) {
    const gradle = probe.readRel('build.gradle') || probe.readRel('build.gradle.kts');
    if (/selenium/i.test(gradle)) return { flavor: 'gradle', evidence: ['build.gradle: selenium'] };
  }
  for (const name of NODE_DEPS) {
    if (probe.nodeDeps.has(name)) {
      return { flavor: 'node', evidence: [`package.json: ${name}`] };
    }
  }
  return null;
}

export function detect(probe) {
  const found = findFlavor(probe);
  if (!found) return null;
  const score = found.flavor === 'maven' ? 96 : found.flavor === 'gradle' ? 92 : 86;
  return { score, evidence: found.evidence };
}

function executable(dir, wrapper, fallback) {
  const abs = path.join(dir, wrapper);
  if (fs.existsSync(abs)) return abs;
  return fallback;
}

export function ready(probe) {
  if (probe.hasPom) return true;
  if (probe.hasGradle) return true;
  return typeof probe.pkg?.scripts?.test === 'string';
}

export function readyHint(probe) {
  return `未找到可用的测试命令：Java 项目需要 mvn / gradle（或项目自带的 mvnw / gradlew），Node 项目需要在 package.json 里配置 scripts.test。`;
}

/** src/test/java/com/foo/LoginTest.java → LoginTest */
function javaClassName(rel) {
  const base = path.basename(rel);
  return base.replace(/\.(java|kt)$/i, '');
}

export function resolve(ctx) {
  const found = findFlavor(ctx.probe);
  const flavor = found?.flavor ?? 'maven';
  const file = text(ctx.args.file, 1024);
  const grep = text(ctx.args.grep, 200);

  if (flavor === 'maven') {
    const surefireDir = path.join(ctx.resultDirAbs, `${ctx.runId}-surefire`);
    const args = ['-q', '-B', 'test', `-Dsurefire.reportsDirectory=${surefireDir}`];
    const className = file ? javaClassName(file) : '';
    if (className && grep) args.push(`-Dtest=${className}#${grep}`);
    else if (className) args.push(`-Dtest=${className}`);
    else if (grep) args.push(`-Dtest=${grep}`);
    return {
      command: executable(ctx.dir, 'mvnw', 'mvn'),
      args,
      env: { MAVEN_OPTS: process.env.MAVEN_OPTS ?? '-Dfile.encoding=UTF-8' },
    };
  }

  if (flavor === 'gradle') {
    const args = ['test', '--console=plain'];
    const pattern = file ? javaClassName(file) : grep;
    if (pattern) args.push('--tests', pattern);
    return { command: executable(ctx.dir, 'gradlew', 'gradle'), args };
  }

  const pm = ctx.probe.packageManager;
  const command = pm === 'pnpm' ? 'pnpm' : pm === 'yarn' ? 'yarn' : 'npm';
  return { command, args: ['test'], env: { FORCE_COLOR: '0' } };
}

function parseXmlFiles(files) {
  const summaries = files.map((file) => parseJUnitXml(readSmall(file.abs, 8 * 1024 * 1024)));
  const merged = mergeSummaries(summaries);
  return merged.total ? merged : emptySummary();
}

export function parse(ctx) {
  const found = findFlavor(ctx.probe);
  const flavor = found?.flavor ?? 'maven';
  const minMtime = Date.parse(ctx.startedAt) || 0;

  if (flavor === 'maven') {
    const dir = path.join(ctx.resultDirAbs, `${ctx.runId}-surefire`);
    return parseXmlFiles(listFiles(dir, { pattern: /\.xml$/i, maxDepth: 2 }));
  }
  if (flavor === 'gradle') {
    const dir = path.join(ctx.dir, 'build', 'test-results', 'test');
    return parseXmlFiles(listFiles(dir, { pattern: /\.xml$/i, minMtime, maxDepth: 3 }));
  }
  const candidates = [
    path.join(ctx.dir, 'test-results'),
    path.join(ctx.dir, 'reports'),
    path.join(ctx.dir, 'build', 'test-results'),
  ].filter((dir) => fs.existsSync(dir));
  const files = candidates.flatMap((dir) =>
    listFiles(dir, { pattern: /\.xml$/i, minMtime, maxDepth: 3 }),
  );
  return parseXmlFiles(files);
}

export function describeArgs(args) {
  const parts = [];
  if (args.file) parts.push(args.file);
  if (args.grep) parts.push(args.grep);
  return parts.length ? parts.join(' · ') : '全量';
}

/** 项目里可能存在的 HTML 报告目录（项目相对路径） */
export function reportDirs(probe) {
  const found = findFlavor(probe);
  if (found?.flavor === 'gradle') return ['build/reports/tests/test'];
  if (found?.flavor === 'maven') return ['target/site', 'target/surefire-reports'];
  return ['test-results', 'reports', 'mochawesome-report'];
}

export function hintFromLog(log) {
  if (
    /command not found: (mvn|gradle)|not recognized as an internal or external command/i.test(log)
  ) {
    return '本机找不到 Maven / Gradle：请先安装，或使用项目自带的 mvnw / gradlew。';
  }
  if (/Could not resolve dependencies|Non-resolvable parent POM/i.test(log)) {
    return 'Maven 依赖下载失败：请检查网络 / 私服配置后再重试（插件不会自动安装依赖）。';
  }
  if (/Missing script: "test"/i.test(log)) {
    return 'package.json 里没有 test 脚本：先补一个 scripts.test 再运行。';
  }
  return '';
}
