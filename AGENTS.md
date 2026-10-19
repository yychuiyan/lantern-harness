# Agent / 贡献约定

## Git 提交

遵循 Conventional Commits（约定见本地 `.cursor/rules/`，该目录不入库）。

示例：`feat(nav): 主导航支持展开收起`

仅在用户明确要求时创建 commit；勿提交 `.local/`、密钥与本机文档库内容。

**提交推送前必跑**（任一失败先修，不要带着失败提交）：

```bash
pnpm build
pnpm lint
pnpm test
```

用户明确要求跳过时除外，并在回复里注明跳过了检查。

## 发版：版本日志与版本号

**每次提交并推送之前都要做**，与上面的检查一起完成：

1. `CHANGELOG.md` 把顶部 `## [Unreleased]`（没有就新开）改成 `## [x.y.z] - YYYY-MM-DD`，正文按「新增 / 修复 / 优化」归类；开头补一句本次发布的整体说明。
2. 同一提交里提升 `package.json` 的 `version`（默认末位 +1，功能性改动可升次位），保持与日志标题一致。
3. 版本号唯一来源是 `package.json`：侧栏、`lantern version`、`/__tb_update` 都从它读，不要另存常量。
4. 若本次没有面向用户的改动（纯内部重构 / 文档），可以不升版本，但在回复里说明「本次不发版」。

## 格式与检查

| 命令                | 作用                       |
| ------------------- | -------------------------- |
| `pnpm lint`         | ESLint（`src`）            |
| `pnpm typecheck`    | 类型检查（`tsc --noEmit`） |
| `pnpm test`         | 轻量自测（`node:test`）    |
| `pnpm format`       | Prettier 写回              |
| `pnpm format:check` | Prettier 检查              |

`pre-commit`（simple-git-hooks + lint-staged）会对暂存的 `src` 文件自动 Prettier，并对 `.ts/.tsx` 跑 ESLint。

**Node 类型**：`@types/node` 是 `tsc --noEmit` 能识别 `node:*` 与 `process` 的前提，属于必需依赖，勿移除。

**是否需要 ESLint / Prettier**：需要。本仓库已接入轻量配置，用于统一格式与基本质量门禁；规则可后续收紧。
