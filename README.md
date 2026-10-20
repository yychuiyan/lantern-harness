# Lantern Harness

> 提灯的人不问路。

AI 工作台：对话与插件工具、需求 / 用例 / 知识 / 提示词内容库、模板库、会话记忆，数据全部留在本机。

仓库：[yychuiyan/lantern-harness](https://github.com/yychuiyan/lantern-harness) · 文档：[lantern.yychuiyan.com](https://lantern.yychuiyan.com/) · npm 包 `lantern-harness`，命令 `lantern` · [变更日志](https://lantern.yychuiyan.com/docs/changelog/)

## 功能

| 模块      | 说明                                                                                                                                                                                                                                                                         |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI 工作台 | 多轮对话，流式输出，BYOK（自带密钥）直连模型；默认提示词按空间可改，可按插件挂载工具                                                                                                                                                                                         |
| 会话记忆  | 五轨记忆（用户档案 / 全局事实 / 项目关键 / 项目日志 / 每日），待确认队列与工作台「记忆」Tab                                                                                                                                                                                  |
| 插件库    | 内置能力开关：内容库（需求 / 用例 / 提示词 / 知识库 / 模板）、生成能力、记忆与检索、任务 / 待办 / 工作汇报 / 测试统计、自动化测试（Playwright / pytest / Selenium）、项目管理（项目 / 迭代 / 需求 / 缺陷）、仪表盘、开发工具；开启后侧栏出现对应入口，也可让模型推荐能力建议 |

模型配置（BYOK）、内容目录约定、插件用法见 **[操作手册](https://lantern.yychuiyan.com/docs/manual/)**。

## 快速开始

两种用法任选其一。装好后都在侧栏「设置」配置 BYOK；默认打开 `http://127.0.0.1:4321/`，会直接进「自动化测试」（`/test-automation/`，插件关闭时回落到 `/workbench/` 的「我的工作台」）。

### 方式一：免安装方式（推荐）

1、 安装：

```bash
npx lantern-harness
```

执行后会安装全局短命令 `lantern`，之后用 `lantern init` / `lantern web` 操作即可。升级有两种方式：终端执行 `lantern update`（在跑的服务会自动停掉、装完重新拉起），或在页面「设置 → 通用 → 平台版本」点「检查更新 / 更新并重启」——有新版本时侧栏版本号旁也会出现小圆点。`npx` 模式下的页面更新会先装到全局，再用全局 `lantern` 启动。

2、 初始化数据空间（首次必做；可再次执行以更换数据空间）：

```bash
lantern init
```

按序号选择数据空间：

```text
选择数据目录：
  1) 打开系统文件夹选择器
  2) 当前目录（当前终端所在位置）
  3) 自定义路径（手输）
请输入 1 / 2 / 3（默认 1）：
```

3、 常用命令：

```bash
lantern init           # 选择并记住数据空间
lantern web            # 启动本地 Web 服务
lantern stop           # 停止服务
lantern restart        # 重启服务
lantern status         # 运行状态、端口、数据空间
lantern open           # 在浏览器中打开工作台
lantern path           # 显示当前数据空间路径
lantern config         # 显示配置文件地址
lantern logs           # 查看服务日志
lantern doctor         # 检查运行环境与配置是否正常
lantern help           # 显示操作命令列表
lantern version        # 显示当前版本号
lantern list           # 显示可用版本列表
lantern update         # 更新到最新版本（在跑的服务会自动重启）
lantern update 0.1.x   # 更新到指定版本（同上）
lantern uninstall      # 卸载本机 lantern 命令（保留数据空间）
lantern wipe           # 删除当前数据空间（需确认；不可恢复）
lantern space list     # 列出全部数据空间与当前项
lantern space add      # 新建数据空间（--use 顺带设为当前）
lantern space use      # 切换当前数据空间
lantern ask            # 无界面单轮问答，lantern ask <提示词>
lantern rpc            # 以 stdio JSON-RPC 暴露本地问答能力
lantern acp            # 以 ACP 子集供外部编排驱动无 UI Agent
```

4、 插件默认值：

新建空间默认开启「提示词管理」（每个空间都要有默认提示词，属于内置常开项），侧栏为「我的工作台」「提示词管理」「帮助中心」。其余扩展插件（其它内容库、生成能力、知识库检索、会话记忆、任务管理 / 待办事项 / 工作汇报 / 测试统计 / 用例执行统计 / 自动化测试、项目列表 / 迭代管理 / 需求管理 / 缺陷管理、仪表盘、插件开发）都要在「插件」页按分类手动开启；由「插件开发」新增的插件同样默认关闭。

### 方式二：源码启动

适合改代码或二次开发。

1、 克隆仓库到本地：

```bash
git clone https://github.com/yychuiyan/lantern-harness.git
cd lantern-harness
```

2、 开发模式（热更新，含本地落盘 API）：

```bash
pnpm install
pnpm dev
```

3、 预览静态页（需先打包；无本地落盘）：

```bash
pnpm build
pnpm preview
```

## 许可证

[MIT](https://github.com/yychuiyan/lantern-harness/blob/main/LICENSE)
