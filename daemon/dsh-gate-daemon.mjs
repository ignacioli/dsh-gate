#!/usr/bin/env node
// dsh-gate daemon — the only component allowed to run project build/test
// commands outside the agent sandbox.
//
// One daemon per primary checkout. It binds ~/.config/dsh-gate/<key>/run/gate.sock,
// reads the user-owned command templates from that project directory, and
// confines every step with the Seatbelt profile from lib/common.mjs.
//
// The client supplies: op, scope, optional test filter, cwd. It never supplies
// argv — templates live in ~/.config, which the agent cannot write.

import { execFile, spawn } from 'node:child_process';
import { chmodSync, createWriteStream, appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  GATE_DIR,
  PROTOCOL_VERSION,
  VERSION,
  allowedWorkspaces,
  auditPath,
  canonical,
  configPath,
  cwdAllowed,
  derivedDataFor,
  findExecutable,
  gitPrimaryRoot,
  loadConfig,
  logsDir,
  normalizeOnly,
  pidPath,
  planFor,
  projectKey,
  resolveArg,
  runDir,
  scopesOf,
  seatbeltProfile,
  socketPath,
} from '../lib/common.mjs';

const args = process.argv.slice(2);
let rootOverride = null;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--root') rootOverride = args[++index];
  else if (args[index] === '--help' || args[index] === '-h') {
    process.stdout.write(`dsh-gate daemon ${VERSION}
Usage: node dsh-gate-daemon.mjs [--root <primary-checkout>] [--help]
Default root: the primary checkout that contains this file (git common dir).
State: ~/.config/dsh-gate/<project-key>/ (config, logs, audit, socket).
`);
    process.exit(0);
  }
}

const ROOT = canonical(rootOverride ?? gitPrimaryRoot(GATE_DIR) ?? path.resolve(GATE_DIR, '..', '..'));
const KEY = projectKey(ROOT);
const SOCKET = socketPath(KEY);
const RUN = runDir(KEY);
const LOGS = logsDir(KEY);
const AUDIT = auditPath(KEY);
const PID = pidPath(KEY);
const OPS = new Set(['build', 'test', 'doctor']);

const startedIso = new Date().toISOString();
let busy = false;
let activeChild = null;
let shuttingDown = false;

function logLine(...parts) {
  process.stderr.write(`[dsh-gate] ${new Date().toISOString()} ${parts.join(' ')}\n`);
}

function send(socket, payload) {
  if (!socket || socket.destroyed) return;
  try {
    socket.write(`${JSON.stringify(payload)}\n`);
  } catch {
    // Client gone; the audit record still lands.
  }
}

function audit(entry) {
  try {
    mkdirSync(path.dirname(AUDIT), { recursive: true });
    appendFileSync(AUDIT, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
  } catch (error) {
    logLine('audit write failed:', error.message);
  }
}

function statusPayload() {
  let config = null;
  let configError = null;
  try {
    config = loadConfig(KEY);
  } catch (error) {
    configError = error.message;
  }
  return {
    type: 'status',
    v: PROTOCOL_VERSION,
    version: VERSION,
    key: KEY,
    root: ROOT,
    pid: process.pid,
    startedAt: startedIso,
    busy,
    configured: Boolean(config),
    configError,
    configFile: configPath(KEY),
    destination: config?.destination ?? null,
    scopes: config ? scopesOf(config) : [],
    allowedRoots: config ? allowedWorkspaces(config).map(canonical) : [],
    socket: SOCKET,
    auditFile: AUDIT,
    logDir: LOGS,
  };
}

async function dispatch(socket, line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    send(socket, { type: 'error', code: 'BAD_REQUEST', message: 'request is not JSON' });
    return;
  }
  if (request.v !== PROTOCOL_VERSION) {
    send(socket, { type: 'error', code: 'BAD_VERSION', message: `protocol ${PROTOCOL_VERSION} required` });
    return;
  }
  const op = request.op;
  if (op === 'status') {
    send(socket, statusPayload());
    socket.end();
    return;
  }
  if (!OPS.has(op)) {
    send(socket, { type: 'error', code: 'BAD_OP', message: `unknown op: ${String(op)}` });
    send(socket, { type: 'exit', code: 2 });
    socket.end();
    return;
  }
  if (busy) {
    send(socket, { type: 'error', code: 'BUSY', message: 'another dsh-gate request is still running' });
    send(socket, { type: 'exit', code: 75 });
    socket.end();
    return;
  }
  busy = true;
  try {
    if (op === 'doctor') await runDoctor(socket);
    else await runBuildOrTest(socket, request);
  } catch (error) {
    send(socket, { type: 'error', code: 'INTERNAL', message: String(error?.message ?? error) });
    send(socket, { type: 'exit', code: 70 });
  } finally {
    busy = false;
    if (!socket.destroyed) socket.end();
  }
}

function rejectAndExit(socket, request, id, code, message, extra = {}) {
  send(socket, { type: 'error', code, message });
  audit({
    id,
    op: request.op,
    scope: request.scope ?? null,
    only: request.only ?? null,
    cwd: request.cwd ?? null,
    exit: null,
    error: code,
    durationMs: 0,
    log: null,
    ...extra,
  });
  send(socket, { type: 'exit', code: 2, id, durationMs: 0, log: null, audit: AUDIT });
}

async function runBuildOrTest(socket, request) {
  const startedMs = Date.now();
  const id = randomUUID();
  const execute = (code, message) => rejectAndExit(socket, request, id, code, message);

  let config;
  try {
    config = loadConfig(KEY);
  } catch (error) {
    return execute(error.code ?? 'CONFIG_INVALID', error.message);
  }
  if (canonical(config.root) !== ROOT) {
    return execute('CONFIG_ROOT_MISMATCH', `config root ${config.root} does not match daemon root ${ROOT}`);
  }
  if (typeof request.cwd !== 'string' || !path.isAbsolute(request.cwd)) {
    return execute('CWD_INVALID', 'cwd must be an absolute path');
  }
  const workspace = canonical(request.cwd);
  if (!cwdAllowed(workspace, config)) {
    return execute('CWD_NOT_ALLOWED', `cwd is outside the allowed roots: ${workspace}`);
  }
  const scope = typeof request.scope === 'string' && request.scope !== '' ? request.scope : 'all';
  if (request.op === 'test' && scope !== 'all' && !scopesOf(config).includes(scope)) {
    return execute('SCOPE_INVALID', `scope must be all or one of: ${scopesOf(config).join(', ') || '(none)'}`);
  }
  const only = normalizeOnly(request.only);
  if (request.only !== undefined && only === null) {
    return execute('ONLY_INVALID', 'only must match [A-Za-z0-9_.\\/:-]{1,200}');
  }
  if (only && !JSON.stringify(config.steps).includes('{only}')) {
    return execute('ONLY_UNSUPPORTED', 'this project config has no {only} placeholder');
  }

  let steps;
  try {
    steps = planFor(request.op, { config, workspace, scope, only });
  } catch (error) {
    return execute('CONFIG_INVALID', error.message);
  }
  if (steps.length === 0) {
    return execute('NO_STEPS', `no configured steps for op ${request.op}${scope === 'all' ? '' : ` scope ${scope}`}`);
  }
  for (const step of steps) {
    for (const arg of step.argv) {
      if (arg === '') return execute('CONFIG_INVALID', `step "${step.label}" produced an empty argument`);
      if (/\{[a-zA-Z0-9_:-]+\}/.test(arg)) {
        return execute('CONFIG_INVALID', `step "${step.label}" has an unresolved placeholder: ${arg}`);
      }
    }
  }

  const logPath = path.join(LOGS, `${new Date().toISOString().replaceAll(':', '-')}-${id.slice(0, 8)}-${request.op}.log`);
  mkdirSync(LOGS, { recursive: true });
  const logStream = createWriteStream(logPath, { flags: 'a' });
  const writeBoth = (text) => {
    logStream.write(text);
    send(socket, { type: 'log', data: text });
  };

  writeBoth(`dsh-gate: ${request.op}${only ? ` (only ${only})` : ''} in ${workspace}\n`);
  let exitCode = 0;
  for (const step of steps) {
    writeBoth(`dsh-gate: ${step.label} starting\n`);
    const outcome = await runConfined(step, { config, workspace, writeBoth, op: request.op });
    writeBoth(`dsh-gate: ${step.label} exit ${outcome.code}${outcome.timedOut ? ' (timeout)' : ''}\n`);
    if (outcome.code !== 0) {
      exitCode = outcome.code ?? 1;
      if (config.testStopOnFirstFailure) break;
    }
  }
  await new Promise((resolve) => logStream.end(resolve));

  const durationMs = Date.now() - startedMs;
  send(socket, { type: 'exit', code: exitCode, id, durationMs, log: logPath, audit: AUDIT });
  audit({
    id,
    op: request.op,
    scope,
    only,
    cwd: workspace,
    exit: exitCode,
    durationMs,
    log: logPath,
    steps: steps.map((step) => step.label),
  });
}

function killGroup(child) {
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
  setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }, 5000).unref();
}

function runConfined(step, { config, workspace, writeBoth, op }) {
  return new Promise((resolve) => {
    const context = { config, workspace, only: null };
    const profile = seatbeltProfile({
      workspace,
      derivedData: derivedDataFor(workspace, config),
      config,
      context,
    });
    const timeoutMs = op === 'test' ? config.timeoutsMs?.test : config.timeoutsMs?.build;
    const fallbackTimeout = 1800000;
    let timedOut = false;
    let child;
    try {
      child = spawn('/usr/bin/sandbox-exec', ['-p', profile, ...step.argv], {
        cwd: workspace,
        env: { ...process.env },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      writeBoth(`dsh-gate: failed to spawn sandbox-exec: ${error.message}\n`);
      return resolve({ code: 1, timedOut: false });
    }
    activeChild = child;
    const timer = setTimeout(() => {
      timedOut = true;
      writeBoth(`dsh-gate: ${step.label} timed out after ${Math.round(timeoutMs / 1000)}s; stopping process group\n`);
      killGroup(child);
    }, timeoutMs ?? fallbackTimeout);
    const onChunk = (chunk) => writeBoth(chunk.toString('utf8'));
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('error', (error) => {
      clearTimeout(timer);
      activeChild = null;
      writeBoth(`dsh-gate: ${step.label} failed to start: ${error.message}\n`);
      resolve({ code: 1, timedOut: false });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      activeChild = null;
      if (signal && !timedOut) writeBoth(`dsh-gate: ${step.label} terminated by ${signal}\n`);
      resolve({ code: code ?? 1, timedOut });
    });
  });
}

function runCmd(argv, timeoutMs) {
  return new Promise((resolve) => {
    execFile(argv[0], argv.slice(1), { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        code: typeof error?.code === 'number' ? error.code : error ? 1 : 0,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
      });
    });
  });
}

async function runDoctor(socket) {
  const checks = [];
  let config = null;
  try {
    config = loadConfig(KEY);
    checks.push({ name: 'config-file', ok: true, detail: configPath(KEY) });
  } catch (error) {
    checks.push({ name: 'config-file', ok: false, detail: error.message });
  }
  if (config) {
    checks.push({
      name: 'root-match',
      ok: canonical(config.root) === ROOT,
      detail: `${config.root} (daemon: ${ROOT})`,
    });
    const scopes = scopesOf(config);
    checks.push({ name: 'scopes', ok: scopes.length > 0, detail: scopes.join(', ') || '(none)' });
    const steps = [...(config.steps.build ?? []), ...scopes.flatMap((name) => config.steps.test?.[name] ?? [])];
    checks.push({ name: 'steps', ok: steps.length > 0, detail: `${steps.length} configured` });
    const missing = [];
    for (const step of steps) {
      const first = (step.argv ?? [])[0];
      if (!first) continue;
      const resolved = resolveArg(first, { config, workspace: canonical(config.root), only: null });
      if (/\{[a-zA-Z0-9_:-]+\}/.test(resolved)) missing.push(resolved);
      else if (!findExecutable(resolved)) missing.push(resolved);
    }
    checks.push({
      name: 'commands',
      ok: missing.length === 0,
      detail: missing.length === 0 ? 'all step programs found' : `not found: ${missing.join(', ')}`,
    });

    const probePath = path.join(os.homedir(), `.dsh-gate-doctor-${randomUUID().slice(0, 8)}`);
    const profile = seatbeltProfile({
      workspace: ROOT,
      derivedData: derivedDataFor(ROOT, config),
      config,
      context: { config, workspace: ROOT, only: null },
    });
    const script = `printf probe > ${JSON.stringify(probePath)} 2>/dev/null && echo WROTE || echo DENIED`;
    const probe = await runCmd(['/usr/bin/sandbox-exec', '-p', profile, '/bin/sh', '-c', script], 20000);
    const leaked = existsSync(probePath);
    if (leaked) rmSync(probePath, { force: true });
    checks.push({
      name: 'write-outside-denied',
      ok: !leaked && probe.stdout.includes('DENIED'),
      detail: leaked ? 'profile allowed a write outside the allow-list' : `sandbox-exec exit ${probe.code}`,
    });

    const simId = /id=([0-9A-Fa-f-]+)/.exec(config.destination ?? '');
    if (simId) {
      const sim = await runCmd(['xcrun', 'simctl', 'list', 'devices', 'available', '--json'], 20000);
      let ok = false;
      let detail = 'xcrun simctl failed';
      if (sim.code === 0) {
        try {
          const devices = Object.values(JSON.parse(sim.stdout).devices ?? {}).flat().map((device) => device.udid);
          ok = devices.includes(simId[1]);
          detail = ok ? `simulator ${simId[1]}` : `simulator ${simId[1]} is not available`;
        } catch {
          detail = 'could not parse simctl output';
        }
      }
      checks.push({ name: 'simulator', ok, detail });
    }
  }

  send(socket, { type: 'doctor', version: VERSION, root: ROOT, key: KEY, checks });
  send(socket, { type: 'exit', code: checks.every((check) => check.ok) ? 0 : 1 });
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logLine(`received ${signal}; shutting down`);
  try {
    server.close();
  } catch {
    // Not listening yet.
  }
  if (activeChild?.pid) killGroup(activeChild);
  rmSync(SOCKET, { force: true });
  rmSync(PID, { force: true });
  setTimeout(() => process.exit(0), 200).unref();
}

mkdirSync(RUN, { recursive: true, mode: 0o700 });
rmSync(SOCKET, { force: true });

const server = net.createServer((socket) => {
  socket.setEncoding('utf8');
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) dispatch(socket, line);
    }
  });
  socket.on('error', () => {
    // A dropped client must not take the daemon down.
  });
});

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
server.on('error', (error) => {
  logLine('server error:', error.message);
  process.exit(1);
});
server.listen(SOCKET, () => {
  chmodSync(SOCKET, 0o600);
  writeFileSync(PID, `${process.pid}\n`);
  logLine(`v${VERSION} listening on ${SOCKET} (root ${ROOT}, key ${KEY})`);
});
