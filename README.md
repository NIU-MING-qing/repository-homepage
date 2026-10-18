# reflex-guard · 拦截 + 反思 + 重试 守卫

一个零依赖的「闸门」模块 + DSH 插件包装：在工具调用【执行前】校验，违规时回传一段带「原因 + 允许范围」的反思提示让模型重试，连续失败则硬断升级。

## 解决什么问题
- 幻觉污染：模型调用未授权工具 / 写越界路径 / 直接覆盖文件 / 参数不合法。
- token 浪费：模型跑偏后反复踩同一个错。
- 性能：把「被动断掉」升级为「带原因的闭环重试」，成功率更高、轮次更少。

## 三个已知坑的解法（都有对应实现）
| 坑 | 解法 | 代码位置 |
| --- | --- | --- |
| 副作用泄漏（半执行状态） | Guard 只产出「决策」、绝不执行；拦截发生在执行前（fail-closed）；越界/覆盖类动作被拦时尚未产生任何写入 | lib/guard.js 的 submit() |
| 假阳性死循环 | 每次违反都带 ruleId，硬断时打印完整规则ID轨迹；据此判断是规则太严（改规则）还是模型不行（改模型） | lib/guard.js 的 trace + lib/logger.js |
| 成本失控 | maxRetry 硬上限（默认 2）+ shouldGuard 仅拦截关键工具 | lib/guard.js + lib/index.js 的 createInterceptor |

## 快速开始（不依赖 DSH，纯 Node）
运行演示：

    node demo/demo.js

在你的智能体循环里接入：

    import { Guard } from '@niumingqing/reflex-guard/guard';
    import { writeScopeRule, forbidOverwriteRule, jsonSchemaRule } from '@niumingqing/reflex-guard/rules';
    import { buildReflectPrompt } from '@niumingqing/reflex-guard/reflect';

    const guard = new Guard({
      maxRetry: 2,
      rules: [
        writeScopeRule(process.cwd(), { onlyTools: ['write', 'edit'] }),
        forbidOverwriteRule(),
        jsonSchemaRule({ type: 'object', required: ['path'] }, { tools: ['edit'] }),
      ],
    });

    const res = guard.submit({ name: 'edit', args: { path: '/outside/x.txt' } });
    if (res.decision === 'reflect') {
      // 把 buildReflectPrompt(res.violation) 追加回给模型，让它带原因重试
    }

## 内置规则
- jsonSchemaRule(schema, {ruleId, tools}) —— 参数校验
- allowToolsRule([...], {ruleId}) —— 工具白名单
- denyToolsRule([...], {ruleId}) —— 工具黑名单（被禁工具拒绝并回传反思提示）
- writeScopeRule(root, {ruleId, pathKey, onlyTools}) —— 写范围（pathKey 默认 ['path', 'file_path']，可传单个或多个键覆盖）
- forbidOverwriteRule({ruleId, pathKey, onlyTools}) —— 禁止覆盖：显式覆盖模式（mode=overwrite/replace）一律拒；且对整文件写工具（onlyTools 默认 ['write']）做目标存在性检查——目标已存在即拒。pathKey 默认 ['path', 'file_path']
- composeRules([...]) —— 组合

## 作为 DSH 插件使用（镜像 dsh-ops）
一键安装（委托官方 DSH 命令行）：

    npx --yes @niumingqing/reflex-guard@latest install --profile desktop
    # 桌面端若不在默认安装目录，需传 --dsh-cli <安装目录>/resources/runtime/cli/bin/dsh.cmd

或插件市场搜索 @niumingqing/reflex-guard 安装并启用。

    reflex-guard install   --profile desktop --dry-run   # 只看会执行什么，不改动
    reflex-guard status    --profile desktop             # 查看是否已安装/启用
    reflex-guard uninstall --profile desktop             # 卸载

手动：把 cordis.patch.yml 的 insert 条目并入目标 profile 的 cordis.yml。

宿主入口 lib/index.js 把拦截接到 tools/pre-execute（返回 { kind: deny, reason } 即拒绝）与 ctx.tools.guard（返回 reason 字符串即拒绝），违规回传反思文本由 DSH 喂回模型完成重试。这两个钩子签名已对齐 dsh-ops@0.3.0 的真实契约，并已用 DSH 自带 cordis + dsh-tools + dsh-fs-local 启动真实宿主验证通过（test/verify-host.mjs，18 项断言全过；demo/demo.js 为纯 Node 演示，7 个场景全过）。

## 配置（cordis.patch.yml 里的 config）
- maxRetry：连续反思重试上限，默认 2
- writeScope：是否启用写范围校验，默认 true；写范围根目录用 workspaceRoot 指定（默认 process.cwd()）
- forbidOverwrite：是否禁止直接覆盖写入，默认 true（0.1.4 起内置 write 覆盖已存在文件会被拦，不再只认 mode 参数）
- forbidOverwriteTools：目标存在性检查覆盖的工具名列表，默认 ['write']（如需扩展到 edit/ops_replace 等在此配置）
- writeTools：视为「写」的工具名列表，默认 [write, edit, replace, ops_replace, pwsh, rg_write]
- allowTools：可选工具白名单（若配置且希望使用 rg_write，需把 'rg_write' 列入）
- denyTools：可选工具黑名单；被禁工具调用会被拒绝，并走同一反思提示闭环（原因 + 允许范围 + 剩余次数）。黑名单优先于白名单裁决
- schema / schemaTools：可选结构化参数校验
- rgWrite：是否注册 rg_write 专用写工具，默认 true（写区详见下节）
- writeZone：rg_write 的写区配置。root＝写区根（默认 '.'，相对会话工作目录解析）；allowOverwrite＝是否允许覆盖已有文件（默认 false）

## rg_write：受控写区的专用写工具（B 方案）
DSH 宿主里注册一个零依赖的自定义工具 rg_write：在写区（writeZone.root）内写 UTF-8 文件，**越出写区的路径（含 .. 与绝对路径）和覆盖已有文件都会被拒绝**，拒绝理由为带「允许范围」的中文提示，模型可直接据其纠正。写区路径经 ctx.fs 落盘，生产环境由宿主沙箱（workspace-write 栅栏）兜底；0.1.2 起随写调用传入按会话解析的 sandboxPolicy，写区写入不再被 workspace-write 栅栏误拒。writeScope / forbidOverwrite 规则同样覆盖 rg_write（它在默认写工具列表里）。

    writeZone: { root: 'rg-write-zone', allowOverwrite: false }

想要一个独立写环境时：把 writeZone.root 设成专用写区目录（如 D:/DSH-写区），并确保 allowTools 含 'rg_write'——模型的所有写操作就被约束在该写区内完成。

## 平台兼容性（如实说明，2026-10-16 源码级核实修正）
- **此前文档称「DSH 对 write/edit 设有平台自我保护闸、拦不掉」，经对 DSH 0.2.0-rc.2 全库源码检索（295 个包）核实为误判**：平台没有这类「自我保护闸」（社区插件 dsh-tool-guard 自带的 PROTECTED_TOOLS=['read','write','edit','bash'] 是它自己的常量，与平台无关；平台唯一保留的名字是 run_code）。真正原因是本插件 0.1.x 读错了执行对象字段——DSH 工具执行对象的规范字段是 exec.arguments（dsh-tools 源码 3061/3163-3167/3310），旧代码读 exec.args 在生产环境恒为空对象，导致 writeScope/forbidOverwrite/jsonSchema 全放行、只有按工具名判定的 denyTools 生效。**0.1.1 已修复（读 exec.arguments，保留 args/params 兼容），writeScope/forbidOverwrite 现在对 write/edit 在生产环境真实生效**（verify-host [3k] 用例以 arguments 形状验证）。
- **平台的写边界是进程内策略栅栏**（非内核边界）：workspace-write 模式下 ctx.fs 的写被 dsh-fs-sandbox 限制在 workspaceRoot（会话 header.cwd，不可变）+ /tmp + 系统临时目录内，越界抛 FS_SANDBOX_DENIED；读取不受限。shell/代码域由 Windows ACL 受限令牌链兜底。详见同仓文档《DSH 独立写环境使用说明》（docs/DSH-独立写环境使用说明.md）。
- denyTools / allowTools / jsonSchema 拦截工具调用入口，与上述修复无关，此前即已生效（真机验证覆盖）。

## 0.1.2 修复（2026-10-16）
- **rg_write 写区写入不再被 workspace-write 栅栏误拒**：此前 rg_write 落盘时不传沙箱策略，dsh-fs-sandbox 回落无会话的部署默认策略（workspaceRoot=宿主 profile 目录），写区写入被误报 FS_SANDBOX_DENIED（file access denied under workspace-write mode）。0.1.2 起 rg_write 在 execute() 里先用 ctx.get('sandboxPolicy').resolve({session}) 按当前会话解析策略，并随 writeText 传入；若策略仍不允许，FS_SANDBOX_DENIED 会转成中文提示「rg_write 被宿主沙箱拒绝（当前会话文件策略不允许此写入）」。代码：lib/rg-write.js。
- **writeScopeRule 漏检 file_path 已修复**：内置 write/edit 工具的参数名是 file_path 而不是 path，旧版单一路径键让这两个工具的参数越界写入直接漏过。0.1.2 起 writeScopeRule 支持多路径键，默认 ['path', 'file_path']，任一出现的路径越界即拒绝；config.writePathKey 仍可覆盖为单个或多个键。代码：lib/rules.js（buildRules 默认值在 lib/index.js）。

## 目录
- lib/：核心（guard/rules/validate/reflect/logger/rg-write）+ DSH 宿主入口（index.js）
- demo/：可运行演示
- bin/：安装 CLI
- dsh-plugin.json + cordis.patch.yml：插件清单与组件补丁

## 说明
- 用途：解决幻觉问题 + 提升性能（少 token、少轮次、少跑偏）。
- 发布：0.1.0 首发于 npm 包名 reflex-guard（账号 niu-ming-ping，该账号 2FA 丢失无法再发布）；0.1.1 起发布为 @niumingqing/reflex-guard（新账号 niumingqing，包名含原名的 scoped 版，含 exec.arguments 字段修复与 rg_write 写区工具）；0.1.2 修复 rg_write 沙箱策略按会话解析与 writeScope 双路径键检查（详见上文「0.1.2 修复」）；0.1.3 补齐 repository/homepage（https://github.com/NIU-MING-qing/repository-homepage）；0.1.4 修复 forbidOverwrite 对内置 write/edit 失效——旧实现只查 args.mode，而内置工具不传该参数恒放行；现改为对 write 做目标存在性检查（mode 检查保留，详见「内置规则」与「配置」）。
- 写环境文档：《DSH 独立写环境使用说明》（docs/，与 README 同仓发布）。
