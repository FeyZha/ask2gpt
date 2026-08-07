# Ask2GPT

在 VS Code 中使用已登录的 ChatGPT 网页会话进行编程问答。Ask2GPT 由一个 VS Code 扩展和一个
Chrome Relay 伴生扩展组成，通过本机 loopback WebSocket 自动连接，不需要 OpenAI API Key、
配对码或每个窗口单独配置。

> Ask2GPT 是独立的开源项目，与 OpenAI 无隶属或官方合作关系。它不复制 Codex 的私有代码、
> CSS、Logo 或品牌资产。

- 当前版本：`0.0.1`
- Relay 协议：`v15`
- 内容运行时：`34`

## 使用要求

- VS Code 1.96 或更高版本
- Google Chrome 116 或更高版本
- 可正常登录 `https://chatgpt.com/` 的 ChatGPT 账号
- 一个名称精确为 `Ask2GPT` 的 ChatGPT Project

最终用户不需要安装 Node.js、pnpm，也不需要 OpenAI API Key。

## 从 GitHub Release 安装

每个正式 Release 应同时包含以下两个同版本文件：

- `ask2gpt-<version>.vsix`
- `ask2gpt-relay-<version>.zip`
- `SHA256SUMS.txt`

不要混用不同 Release 的 VSIX 和 Relay ZIP。

### 1. 安装 VS Code 扩展

1. 下载 Release 中的 VSIX。
2. 在 VS Code 中运行 `Extensions: Install from VSIX...`。
3. 选择下载的 VSIX，并按提示重新加载 VS Code。
4. 点击 Activity Bar 中的 Ask2GPT 图标，或在命令面板运行
   `Ask2GPT: 打开问答窗口 / Open Q&A`。

### 2. 安装 Chrome Relay

1. 解压 Release 中的 Relay ZIP 到一个固定目录；升级时完整替换该目录。
2. 打开 `chrome://extensions` 并启用“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择刚解压的目录。
4. 将 Ask2GPT Relay 固定到 Chrome 工具栏，便于查看状态或重新加载。

不要直接加载 ZIP，也不要同时保留多个不同版本的 Relay 目录。

### 3. 首次连接

1. 在 Chrome 中登录 ChatGPT。
2. 打开或创建名称精确为 `Ask2GPT` 的 Project。
3. 回到 VS Code 的 Ask2GPT 并发送问题。

Relay 会自动发现并保存该 Project。只有自动识别失败时，才需要在 Relay 弹窗中点击
“绑定当前 Project”。Project 绑定由 Chrome 扩展保存，多个 VS Code 窗口共享；每个窗口仍拥有
独立端口、会话分区、标签页映射和 `instanceId`。

## 当前功能

- 独立问答侧栏与多轮对话；
- 新建、切换、重命名、归档、撤销归档和恢复本地会话；
- ChatGPT 会话标题与当前可见分支历史同步；
- 智能、极速、中、高、极高和 Pro 等可用模型/推理档位同步；
- Markdown、GFM 表格、代码高亮和流式回答；
- 停止、重新生成、排队追问或停止后发送；
- 通过灯泡 Quick Fix 显式附加当前选区；
- 通过 Composer 的 `+` 显式附加当前文件或多个文本文件；
- 发送前上下文预览、逐项移除、敏感文件和大小限制；
- 多 VS Code 窗口独立路由与重启恢复；
- AES-256-GCM 加密的扩展私有会话存储；
- Chrome 最小化时的增强后台流式接收。

Ask2GPT 不会在本地执行 Shell、Git、测试或任务，不搜索工作区，也不写入用户工作区。所有问题
都通过同一 Relay 路径发送到用户可见的 ChatGPT 页面。

## 上下文与数据边界

Ask2GPT 只读取用户明确选择的内容：

- 当前选区；
- 当前编辑器的内存文本；
- 用户在系统文件选择器中确认的文本/代码文件。

它不会扫描或推断工作区中的其他文件。`.env*`、私钥、证书、keystore、常见凭据文件、二进制
文件以及超过限制的内容会被拒绝。短上下文以可见文本发送；较大的文本上下文通过 ChatGPT
页面的文件控件附加，发送前必须确认附件已经出现在页面中。

## Chrome 权限

Relay 当前申请：

```text
tabs
storage
alarms
debugger
scripting
https://chatgpt.com/*
http://127.0.0.1/*
```

- `debugger` 仅连接 Ask2GPT 拥有的 ChatGPT 标签页；默认增强模式会在页面按钮激活前保持该
  renderer 为 active 并模拟页面焦点（不会聚焦操作系统窗口），同时用于最小化窗口下继续接收本轮
  SSE/声明的 WebSocket topic。Relay 临时停放窗口只在 MAIN-world 严格验证后的按钮命中点派发一次左键
  按下/释放；关闭增强接收时使用不启用 Network 域的短时会话并立即断开。结束、停止或失败后断开。
- `scripting` 用于在已验证的 Ask2GPT 标签页中恢复内容脚本，以及在严格校验后执行一次受限的
  MAIN-world 页面操作。
- `storage` 只保存 Relay 自身的 Project 绑定、路由和恢复状态。
- `tabs` 用于管理 Ask2GPT 自己创建或已经明确映射的 ChatGPT 标签页；发送时若 exact owned 标签页
  位于后台，会暂时移入 `focused=false`、最大 980×760 的桌面布局临时窗口，并在终态后原位恢复，
  不切换用户当前标签页；窗口移动后需通过两次间隔 350 ms 的 composer 就绪探测才会发送。

扩展不申请 `cookies`、`history`、`downloads`、`nativeMessaging`、剪贴板或文件 URL 权限。
它不把 Cookie、访问令牌、网页存储、问题正文或回答正文写入日志。

## 安全模型

VS Code 与 Chrome 使用 `127.0.0.1:32171–32180` 上的 protocol v15 WebSocket 连接。连接会校验
固定 Chrome 扩展 ID、Origin、协议版本、产品版本、消息 schema、方向、大小和目标窗口身份。

这个 loopback 传输没有 TLS 或对端密码学认证。本机恶意进程仍可能抢占端口或冒充一端，进而
看到准备发送的问题/显式附件，或诱导 Relay 操作当前 ChatGPT 页面。因此当前版本适用于用户
信任本机进程的个人开发环境，不适用于需要抵御本机恶意进程的高安全环境。完整说明见
[SECURITY.md](./SECURITY.md)。

## 从源码构建

开发要求：

- Node.js 22.13+ 或 24+（推荐当前 Node 24 LTS）
- pnpm 11.20.0（根 `package.json` 已通过 Corepack 固定版本）

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm audit:dependencies
pnpm verify
pnpm package
```

`pnpm verify` 会运行格式、类型、ESLint、架构边界、源码隔离、第三方许可证、单元/集成、
Webview 预览契约、smoke harness 和构建检查。`pnpm package` 会从当前版本号生成并复核 VSIX
与 Relay ZIP，包括 MIT 许可证和第三方依赖声明；生成物被 `.gitignore` 排除，只应作为 GitHub
Release/CI artifact 发布。

真实登录态 smoke 会创建 ChatGPT 会话并操作 Relay，仅在明确准备好测试账号和 Chrome 环境时运行：

```powershell
pnpm smoke:live -- --host-count 3 --connection-timeout-ms 180000 --generation-timeout-ms 180000
```

详细开发流程见 [CONTRIBUTING.md](./CONTRIBUTING.md)，人工发布验收见
[MANUAL_QA.md](./MANUAL_QA.md)。

## 发布

1. 同步根、VS Code、Chrome、协议包和 Chrome manifest 的 SemVer。
2. 更新 [CHANGELOG.md](./CHANGELOG.md)。
3. 执行 `pnpm audit:dependencies`、`pnpm verify` 与 `pnpm package`。
4. 提交并推送代码。
5. 创建并推送与版本一致的 tag，例如 `v0.0.1`。

`.github/workflows/release.yml` 会从干净 checkout 重新验证、打包、生成 SHA-256 校验和并创建
GitHub Release。tag 与 `package.json` 版本不一致时发布会失败。

## 已知限制

- ChatGPT 页面结构、未公开模型目录或会话请求结构变化后，可能需要更新兼容层；
- 登录、CAPTCHA 和人工验证必须由用户在 Chrome 中处理；
- 不支持二进制、图片、Deep Research、Web Search 或 Apps；
- 不扫描 ChatGPT 全部历史或不可见分支；
- GitHub Release 安装仍需要 Chrome 开发者模式，真正的一键自动更新需要后续发布到 VS Code
  Marketplace 与 Chrome Web Store；
- protocol v15 的零配置 loopback 不能防止本机恶意进程冒充。

## 文档

- [ARCHITECTURE.md](./ARCHITECTURE.md)：组件、协议、状态机和恢复边界
- [SECURITY.md](./SECURITY.md)：权限、数据处理和威胁模型
- [MANUAL_QA.md](./MANUAL_QA.md)：发布前人工验收
- [CHANGELOG.md](./CHANGELOG.md)：版本变更
- [CONTRIBUTING.md](./CONTRIBUTING.md)：开发与贡献流程

## License

[MIT](./LICENSE)。随成品分发的依赖许可证和版权声明见
[THIRD_PARTY_NOTICES.txt](./THIRD_PARTY_NOTICES.txt)。
