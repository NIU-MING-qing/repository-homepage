# DSH 独立写环境使用说明

> 目标：给「写操作」提供一个独立、受控的环境，绕开 DSH 对写操作约束能力有限的痛点。
> 依据：DSH 0.2.0-rc.2 源码级核实（295 个 @deepseek-ai 包全文检索 + 生产 profile 实读），2026-10-16。
> 配套：reflex-guard 插件（含 rg_write 专用写工具）。

## 一、结论先行（两个关键更正）

1. **DSH 平台没有「自我保护闸」**。此前流传的「read/write/edit/bash 被平台保护、插件拦不住」是误传：全库检索无 self-protect 类实现；「保护名单」出自社区插件 dsh-tool-guard 自己的常量 `PROTECTED_TOOLS = ['read','write','edit','bash']`（它的 applyProtection 拒绝屏蔽这 4 个工具，是插件自己的选择）。平台唯一保留的名字只有 `run_code`（不可注册、不可 restrict，dsh-tools/lib/index.js:2885/2905）。
2. **reflex-guard 此前「write/edit 拦不住」是它自己的字段 bug，现已修复**：DSH 工具执行对象的规范字段是 `exec.arguments`（dsh-tools 源码 3061 / 3163-3167 / 3310），旧代码读 `exec.args` 在生产恒为空对象。0.1.1 起读 `exec.arguments`（保留 args/params 兼容），writeScope/forbidOverwrite/jsonSchema 在生产对 write/edit 真实生效。平台的 pre-execute deny 与 tools.guard 拒绝**对所有工具一视同仁、无按名豁免**（dsh-tools/lib/index.js:3225-3257）。

## 二、方案 A：平台原生写区（零代码）

### 2.1 机制
- 每个会话有一个不可变的写边界：`workspaceRoot = 会话 header.cwd`（会话创建时记录；dsh-sandbox-policy 的 resolve()）。生产默认模式 `workspace-write`（DSH_PERMISSION_MODE 可改，cordis.yml:127-131）。
- 写操作落盘前，dsh-fs-sandbox 做**进程内策略检查**：目标 canonicalize 后必须落在 `writableRoots = {workspaceRoot, "/tmp", 系统临时目录}` 三者之一内，越界抛 `FS_SANDBOX_DENIED`（dsh-fs-sandbox/lib/index.js:153-166）；**读取完全放行**。
- 性质（官方头注释 dsh-fs-sandbox:77-85 原话）：这是「受信代码对模型控制路径的策略检查」，**不是内核边界**——它防模型跑偏，不防恶意代码；代码级隔离由 ctx.shell 的沙箱负责。
- 权限阶梯：`read-only` → `workspace-write` → `danger-full-access`（严格更宽，dsh-sandbox WIDER_MODES:30-33）。放宽要成对提供 `sandbox_permissions + justification` 并经审批（validateEscalationArgs:51-55、approveEscalation:99-123）。
- shell/代码域（pwsh 等）：ctx.sandbox.confine 走 **Windows ACL 受限令牌链**（dsh-pwsh-sandbox:99-104、:151-205），工作区被打 Low 完整性标签，会话结束后依然存在（dsh-sandbox-windows-acl README.zh.md:131）。

### 2.2 怎么用：建立独立写环境
1. 建一个专用写区目录，例如 `D:\DSH-写区`。
2. 以该目录为工作目录创建/打开会话（`workspaceRoot = process.cwd()`，见生产 cordis.yml 的 sandbox-policy 配置）。会话内的 write / edit / ops_replace / pwsh 等所有文件写都被栅栏 confine 到该目录；越界即得 `FS_SANDBOX_DENIED` 拒绝。
3. 想要更宽的临时写放行（如写系统临时目录），无需配置——/tmp 与系统临时目录天然在 writableRoots 内。
4. 需要越界写时：临时升权走审批（danger-full-access），或换到一个以目标目录为根的新会话。

### 2.3 优点与边界
- 优点：零代码、平台级、对所有模型驱动写生效、与工具无关。
- 边界：①非内核边界（受信代码内的检查）；②读不受限；③workspaceRoot 不可变（插件只读 ctx.sandboxPolicy.workspaceRoot，改不了）；④模式切换走 sandbox/mode 事件或审批。

## 三、方案 B：rg_write 插件写区（reflex-guard）

在插件内注册一个零依赖的自定义写工具 rg_write（手写 ToolDefinition，对齐 dsh-tools defineTool 产物形状；注册 API ctx.tools.register，注册即进入模型工具列表，无需 manifest 声明）：

- 配置：
  ```yaml
  writeZone: { root: 'rg-write-zone', allowOverwrite: false }  # root 相对会话 cwd；默认 '.'
  rgWrite: false   # 设为 false 关闭注册
  ```
- 语义：`path` 是**相对写区根**的相对路径；越界（`..` 或绝对路径）→ 拒绝；覆盖已有文件 → 拒绝（allowOverwrite: true 才放开）。拒绝理由为带「允许范围」的中文提示，模型可直接纠正。
- 落盘：`ctx.fs.resolve → ctx.fs.contains → ctx.fs.stat → ctx.fs.writeText(expected={kind:'createIfAbsent'})`，与平台 write/edit 走同一文件系统服务，生产环境同样受 2.1 的 workspace-write 栅栏兜底。
- 与规则联动：rg_write 已加入默认写工具列表（DEFAULT_WRITE_TOOLS），writeScope/forbidOverwrite 两条规则同样覆盖它；若配置了 allowTools，需把 'rg_write' 列入。
- 真实宿主验证（verify-host，DSH 自带 cordis + dsh-tools + dsh-system-prompt + dsh-fs-local）：15/15 断言全过，含：写区内落盘成功（operation=create）、越界拒（带允许范围）、覆盖拒、writeScope 拦 rg_write 绝对路径、exec.arguments 字段形状拦截。

## 四、组合建议
- **A 兜底、B 语义化**：A（平台栅栏）保证任何写都出不了工作区；B（rg_write）给模型一个语义明确的「受控写区」工具，拒绝理由可读、可反思重试。
- 生产启用 reflex-guard 0.1.1+ 后：write/edit 越界在 pre-execute 被插件拦（带原因+允许范围+剩余重试），未被拦的写由平台栅栏兜底，双层防护。

## 五、附：DSH 文件写链路（源码事实）
- dsh-tool-fs 的 write：`sandbox.resolvePolicy("write", args, exec)` → `ctx.fs.resolve(filePath, sessionResolveOptions)` → `ctx.waterfall("fs/write-intent", ...)` → `ctx.fs.writeText(..., sandboxPolicy)`（dsh-tool-fs/lib/index.js:579-600）。
- 文件操作走 wire 协议带 workspaceFileScope 头，Host 定类型并 confine 到工作区（api-catalog.js:3585-3609）。
- 工具执行链：`tools/pre-execute` 瀑布 → 单调 guards → execute（dsh-tools/lib/index.js:3214-3274）。
