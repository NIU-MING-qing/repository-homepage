#!/usr/bin/env node
// reflex-guard/bin/reflex-guard.mjs — 安装/卸载/状态 CLI
// 委托官方 DSH 命令行管理 profile（对齐 dsh-ops 的 profileCommand 思路）。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..');

function pkgVersion() {
  return JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;
}

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function usage() {
  console.log('reflex-guard — 拦截+反思+重试守卫插件');
  console.log('');
  console.log('用法:');
  console.log('  reflex-guard install   --profile <desktop|web|tui> [--dsh-cli <path>] [--dry-run]');
  console.log('  reflex-guard uninstall --profile <desktop|web|tui> [--dsh-cli <path>] [--dry-run]');
  console.log('  reflex-guard status    --profile <desktop|web|tui>');
  console.log('  reflex-guard help');
  console.log('');
  console.log('说明: install/uninstall 委托官方 DSH 命令行（dsh plugin --profile <t> add/remove @niumingqing/reflex-guard@<v>）。');
  console.log('tui 映射到 dsh-tui。桌面端需传 --dsh-cli <安装目录>/resources/runtime/cli/bin/dsh.cmd。');
}

function profileCommand(operation, opts = {}) {
  const profile = opts.profile;
  const dshCli = opts.dshCli;
  const dryRun = opts.dryRun === true;
  const aliases = { desktop: 'desktop', web: 'web', tui: 'dsh-tui', 'dsh-tui': 'dsh-tui' };
  if (!Object.hasOwn(aliases, profile || '')) {
    throw new Error('需要显式 --profile desktop|web|tui（tui 映射到 dsh-tui）。');
  }
  const target = aliases[profile];
  const directory = path.join(dshHome(), 'profiles', target);
  if (!fs.existsSync(path.join(directory, 'package.json'))) {
    throw new Error('请先初始化目标 DSH 应用/profile：' + directory);
  }
  const version = pkgVersion();
  if (operation === 'status') {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    console.log(JSON.stringify({
      profile: target,
      directory,
      dependency: (manifest.dependencies && manifest.dependencies['@niumingqing/reflex-guard']) || null,
      enabled: ((manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles) || []).includes('@niumingqing/reflex-guard'),
    }, null, 2));
    return 0;
  }
  const args = ['plugin', '--profile', target, operation === 'install' ? 'add' : 'remove', operation === 'install' ? ('@niumingqing/reflex-guard@' + version) : '@niumingqing/reflex-guard'];
  let command = dshCli || process.env.REFLEX_GUARD_DSH_CLI;
  if (!command && target === 'desktop') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const p = path.join(local, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd');
    if (fs.existsSync(p)) command = p;
    else throw new Error('桌面端需要自带 CLI。请传 --dsh-cli <安装目录>/resources/runtime/cli/bin/dsh.cmd。');
  }
  if (!command) command = 'dsh.cmd';
  console.log('目标: ' + target + ' (' + directory + ')');
  console.log('官方 CLI: ' + command + '; ' + args.join(' '));
  if (dryRun) return 0;
  let result;
  if (/\.cmd$/i.test(command)) {
    if (/["\r\n&|<>^%!]/.test(command)) throw new Error('CLI 路径含非法字符。');
    const quoted = '""' + command + '" ' + args.join(' ') + '"';
    result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', quoted], { stdio: 'inherit', windowsHide: true, windowsVerbatimArguments: true });
  } else {
    result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true });
  }
  if (result.error) throw result.error;
  return result.status != null ? result.status : 1;
}

const argv = process.argv.slice(2);
const cmd = ['install', 'uninstall', 'status', 'help'].includes(argv[0]) ? argv[0] : 'help';
let profile;
let dshCli;
let dryRun = false;
for (let i = 1; i < argv.length; i++) {
  if (argv[i] === '--profile') profile = argv[++i];
  else if (argv[i] === '--dsh-cli') dshCli = argv[++i];
  else if (argv[i] === '--dry-run') dryRun = true;
}

let exit = 0;
try {
  if (cmd === 'install' || cmd === 'uninstall') {
    exit = profileCommand(cmd, { profile, dshCli, dryRun }) || 0;
  } else if (cmd === 'status') {
    if (!profile) { usage(); }
    else exit = profileCommand('status', { profile }) || 0;
  } else {
    usage();
  }
} catch (e) {
  console.error('错误: ' + (e && e.message ? e.message : e));
  exit = 1;
}
process.exit(exit);
