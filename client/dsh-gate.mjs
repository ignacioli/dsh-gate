#!/usr/bin/env node
// dsh-gate client — what agents call instead of project build tools.
//
// The client resolves the project's PRIMARY checkout through git (so it works
// from any worktree), connects to that project's daemon socket, and streams the
// run output back. It never supplies argv: command templates live in
// ~/.config/dsh-gate/<key>/config.json, which the sandboxed agent cannot write.

import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { GATE_DIR, VERSION, auditPath, configPath, gitPrimaryRoot, projectKey, socketPath } from '../lib/common.mjs';

const HELP = `dsh-gate ${VERSION} — 沙箱外构建/测试门禁客户端（非官方，与 DeepSeek 无关）

用法（在仓库或任意 worktree 内）:
  dsh-gate build                        运行配置的构建步骤
  dsh-gate test [--scope S] [--only F]  运行配置的测试步骤
        --scope <name|all>              默认 all；名称由项目 config.json 定义
        --only <filter>                 单测过滤（需模板支持 {only}）
  dsh-gate status                       查看本项目的 daemon 状态与配置
  dsh-gate doctor                       自检（配置、命令、沙箱边界、模拟器）
  dsh-gate audit [--lines N]            查看审计记录（默认 20 行）
  dsh-gate --help

退出码: 与构建命令相同；daemon 不可达 69；请求被拒 2；daemon 忙 75。

状态目录: ~/.config/dsh-gate/<project-key>/ （config、logs、audit、socket）
本项目 config: ${configPath('<project-key>')}
`;

const OPS = new Set(['build', 'test', 'status', 'doctor', 'audit']);
const args = process.argv.slice(2);

if (args.length === 0 || args.includes('-h') || args.includes('--help') || args[0] === 'help') {
  process.stdout.write(HELP);
  process.exit(0);
}

const op = args[0];
if (!OPS.has(op)) {
  process.stderr.write(`dsh-gate: unknown command: ${op}\n\n${HELP}`);
  process.exit(64);
}

let scope = null;
let only = null;
let lines = 20;
for (let index = 1; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--scope') scope = args[++index];
  else if (arg.startsWith('--scope=')) scope = arg.slice('--scope='.length);
  else if (arg === '--only') only = args[++index];
  else if (arg.startsWith('--only=')) only = arg.slice('--only='.length);
  else if (arg === '--lines') lines = Number(args[++index]);
  else if (arg.startsWith('--lines=')) lines = Number(arg.slice('--lines='.length));
  else {
    process.stderr.write(`dsh-gate: unknown option: ${arg}\n`);
    process.exit(64);
  }
}

const cwd = process.cwd();
const root = gitPrimaryRoot(cwd);
if (!root) {
  process.stderr.write(`dsh-gate: ${cwd} is not inside a git checkout\n`);
  process.exit(68);
}
const key = projectKey(root);
const auditFile = auditPath(key);

if (op === 'audit') {
  if (!existsSync(auditFile)) {
    process.stdout.write(`dsh-gate: no audit entries yet (${auditFile})\n`);
    process.exit(0);
  }
  const rows = readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean).slice(-Math.max(0, lines));
  for (const row of rows) {
    try {
      const entry = JSON.parse(row);
      process.stdout.write(
        `${entry.ts} ${entry.op} exit=${entry.exit} ${Math.round((entry.durationMs ?? 0) / 1000)}s cwd=${entry.cwd ?? '-'} log=${entry.log ?? '-'}\n`,
      );
    } catch {
      process.stdout.write(`${row}\n`);
    }
  }
  process.exit(0);
}

const request = { v: 1, op, cwd, pid: process.pid };
if (scope) request.scope = scope;
if (only) request.only = only;

const socket = connect(socketPath(key));
let buffer = '';
let sawExit = false;
let exitCode = 0;

function finish(code) {
  process.exitCode = code;
  socket.end();
}

function handleEvent(event) {
  if (event.type === 'log') {
    process.stdout.write(event.data);
    return;
  }
  if (event.type === 'status') {
    process.stdout.write(`${JSON.stringify(event, null, 2)}\n`);
    return;
  }
  if (event.type === 'doctor') {
    process.stdout.write(`dsh-gate doctor — ${event.root} (${event.key})\n`);
    for (const check of event.checks ?? []) {
      process.stdout.write(`  ${check.ok ? 'PASS' : 'FAIL'}  ${check.name}: ${check.detail}\n`);
    }
    return;
  }
  if (event.type === 'error') {
    process.stderr.write(`dsh-gate: ${event.code}: ${event.message}\n`);
    return;
  }
  if (event.type === 'exit') {
    sawExit = true;
    exitCode = typeof event.code === 'number' ? event.code : 1;
    process.stderr.write(`dsh-gate: ${op} exit=${exitCode} duration=${Math.round((event.durationMs ?? 0) / 1000)}s\n`);
    if (event.log) process.stderr.write(`dsh-gate: log ${event.log}\n`);
    if (event.audit) process.stderr.write(`dsh-gate: audit ${event.audit}\n`);
    finish(exitCode);
  }
}

socket.on('error', (error) => {
  process.stderr.write(`dsh-gate: cannot reach the daemon for ${key}\n`);
  process.stderr.write(`dsh-gate: ${error.code ?? error.message} (${socketPath(key)})\n`);
  process.stderr.write(`dsh-gate: one-time install: cd ${GATE_DIR} && ./install.sh  (see ${GATE_DIR}/MANUAL.md)\n`);
  process.exit(69);
});

socket.on('connect', () => {
  socket.write(`${JSON.stringify(request)}\n`);
});

socket.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    handleEvent(event);
  }
});

socket.on('end', () => {
  if (!sawExit && op !== 'status' && op !== 'doctor') {
    process.stderr.write('dsh-gate: daemon closed the connection without a result\n');
    process.exit(70);
  }
  process.exit(sawExit ? exitCode : 0);
});
