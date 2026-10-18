// reflex-guard/lib/rg-write.js — rg_write 专用写工具（B 方案：独立写环境）
//
// 手写 DSH ToolDefinition（对齐 dsh-tools defineTool 的产物形状，schema.js:274-354），
// 零 @deepseek-ai 依赖：parameters 用原生 JSON Schema、output.schema 用具体对象 schema、
// execute 自行做参数检查——因此该文件在真实宿主与 verify-host 里都能无歧义解析。
//
// 语义：
//   - 写区 writeZone.root（默认 '.'，相对会话 cwd / exec.agent.session.header.cwd 解析）
//   - path 必须是写区内的相对路径；越界 → 拒绝（中文理由 + 允许范围）
//   - 写区默认禁止覆盖已有文件；writeZone.allowOverwrite === true 时放开
//   - 落盘走 ctx.fs.writeText（经宿主文件系统服务，生产环境由 dsh-fs-sandbox 的
//     workspace-write 栅栏兜底；expected={kind:'createIfAbsent'} 双重防覆盖）

import path from 'node:path';
import { mkdir } from 'node:fs/promises';

function sessionCwd(exec) {
  const cwd = exec && exec.agent && exec.agent.session && exec.agent.session.header && exec.agent.session.header.cwd;
  return typeof cwd === 'string' ? cwd : undefined;
}

export function rgWriteDefinition(ctx, config) {
  const zone = (config && config.writeZone) || {};
  const zoneRoot = typeof zone.root === 'string' && zone.root.length ? zone.root : '.';
  const allowOverwrite = zone.allowOverwrite === true;

  return {
    name: 'rg_write',
    description: '在 reflex-guard 受控写区（writeZone.root，默认当前会话工作目录）内写入一个 UTF-8 文本文件。'
      + 'path 是相对写区根目录的相对路径；越出写区的路径（含 .. 与绝对路径）会被拒绝。'
      + '写区默认禁止覆盖已有文件（配置 writeZone.allowOverwrite 可放开）。'
      + '当普通写工具不可用时，用它把写操作约束在受控写区内完成。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '相对写区根目录（writeZone.root）的相对路径，例如 notes/计划.md。不允许越出写区的相对路径（..）或绝对路径。',
        },
        content: {
          type: 'string',
          description: '要写入的完整文件内容（UTF-8 文本）。',
        },
      },
      required: ['path', 'content'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          operation: { type: 'string' },
          wroteTo: { type: 'string' },
        },
        required: ['path', 'operation', 'wroteTo'],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      if (!ctx || !ctx.fs) {
        throw new Error('rg_write 不可用：宿主未提供 ctx.fs 文件系统服务。');
      }
      if (!args || typeof args.path !== 'string' || !args.path.trim()) {
        throw new Error('rg_write: path 必须是非空字符串（写区内的相对路径）。');
      }
      if (typeof args.content !== 'string') {
        throw new Error('rg_write: content 必须是字符串。');
      }
      const cwd = sessionCwd(exec);
      const session = exec && exec.agent && exec.agent.session;
      const opts = { ...(cwd !== undefined ? { cwd } : {}), signal: exec && exec.signal };

      // 沙箱策略：按会话解析后随写调用传入（对齐 dsh-tool-fs 的 resolvePolicy 主干）。
      // 不传时 dsh-fs-sandbox 会回落部署默认策略（无会话 → workspaceRoot=宿主进程 cwd、
      // mode=默认值），写区会被 workspace-write 栅栏误拒（FS_SANDBOX_DENIED，2026-10-16 复测发现）。
      let sandboxPolicy;
      try {
        const policyService = ctx && typeof ctx.get === 'function' ? ctx.get('sandboxPolicy') : undefined;
        if (policyService && typeof policyService.resolve === 'function') {
          sandboxPolicy = policyService.resolve({ ...(session ? { session } : {}) });
        }
      } catch {
        sandboxPolicy = undefined; // 宿主未挂沙箱策略服务：退化为无策略（后端不设栅栏）
      }

      // 写区根按会话 cwd 解析；文件路径按「写区根」解析（path 是写区内的相对路径）
      const zoneTarget = await ctx.fs.resolve(zoneRoot, opts);
      const fileTarget = await ctx.fs.resolve(args.path, {
        cwd: String(zoneTarget.targetKey),
        signal: exec && exec.signal,
      });

      // 越界检查：目标必须落在写区内（ctx.fs.contains 是相对路径逃逸判定，纯路径数学）
      let contained = false;
      try {
        contained = ctx.fs.contains(zoneTarget, fileTarget);
      } catch {
        contained = false; // 后端未实现 contains 时保守拒绝
      }
      if (!contained) {
        throw new Error('rg_write 拒绝：路径 "' + args.path + '" 越出了写区 "' + zoneRoot
          + '"（写区按当前会话工作目录解析）。允许范围：写区内的相对路径，例如 notes/计划.md。');
      }

      // 懒创建写区目录（写区是操作者配置的受信路径；失败时由后续写入报错兜底）
      try {
        await mkdir(String(zoneTarget.targetKey), { recursive: true });
      } catch {
        /* 已存在或不可创建时忽略 */
      }

      // 覆盖写检查：先给友好中文理由；writeText 的 expected={kind:'createIfAbsent'} 兜底并发竞态
      if (!allowOverwrite) {
        const existing = await ctx.fs.stat(fileTarget, opts.signal);
        if (existing) {
          throw new Error('rg_write 拒绝：文件 "' + args.path + '" 已存在，写区默认禁止覆盖写'
            + '（配置 writeZone.allowOverwrite 可放开）。请换一个新文件名。');
        }
      }

      let outcome;
      try {
        outcome = await ctx.fs.writeText(
          fileTarget,
          args.content,
          allowOverwrite ? undefined : { kind: 'createIfAbsent' },
          opts.signal,
          sandboxPolicy,
        );
      } catch (e) {
        if (e && e.code === 'FS_SANDBOX_DENIED') {
          throw new Error('rg_write 被宿主沙箱拒绝（当前会话文件策略不允许此写入）：' + (e && e.message || String(e)));
        }
        throw e;
      }
      return { path: args.path, operation: outcome.operation, wroteTo: fileTarget.displayPath };
    },
  };
}

export default rgWriteDefinition;
