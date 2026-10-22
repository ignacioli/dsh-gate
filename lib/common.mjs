// Shared helpers for the dsh-gate daemon and client.
//
// Layout: the tool ships in <repo>/.dsh/gate, but every mutable thing lives
// under ~/.config/dsh-gate/<project-key>/ — outside the agent-writable
// checkout. The agent can edit repo files; it must not be able to edit the
// command templates the daemon executes or the audit trail.
//
// A "project" is a primary git checkout. Any worktree of that checkout is an
// allowed request cwd; the client resolves the primary root through
// `git rev-parse --git-common-dir`, so the same command works from worktrees.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** <repo>/.dsh/gate */
export const GATE_DIR = path.resolve(HERE, '..');
export const VERSION = '0.1.0';
export const PROTOCOL_VERSION = 1;
export const CONFIG_HOME = path.join(os.homedir(), '.config', 'dsh-gate');

export function canonical(target) {
  try {
    return realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

export function isUnder(child, parent) {
  const c = canonical(child);
  const p = canonical(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/** Primary checkout root for `startDir`, or null when it is not a git checkout. */
export function gitPrimaryRoot(startDir) {
  try {
    const out = execFileSync(
      'git',
      ['-C', startDir, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    if (!out) return null;
    return canonical(path.dirname(out));
  } catch {
    return null;
  }
}

/** Stable, human-readable key for one primary checkout. */
export function projectKey(root) {
  const base =
    path
      .basename(canonical(root))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project';
  const hash = createHash('sha1').update(canonical(root)).digest('hex').slice(0, 8);
  return `${base}-${hash}`;
}

export const projectDir = (key) => path.join(CONFIG_HOME, key);
export const configPath = (key) => path.join(projectDir(key), 'config.json');
export const runDir = (key) => path.join(projectDir(key), 'run');
export const socketPath = (key) => path.join(runDir(key), 'gate.sock');
export const pidPath = (key) => path.join(runDir(key), 'gate.pid');
export const logsDir = (key) => path.join(projectDir(key), 'logs');
export const auditPath = (key) => path.join(projectDir(key), 'audit.jsonl');

/** Read a project config. Throws with `code` CONFIG_MISSING / CONFIG_INVALID. */
export function loadConfig(key) {
  const file = configPath(key);
  if (!existsSync(file)) {
    const error = new Error(`missing project config: ${file} (run .dsh/gate/install.sh)`);
    error.code = 'CONFIG_MISSING';
    throw error;
  }
  let config;
  try {
    config = JSON.parse(readFileSync(file, 'utf8'));
  } catch (cause) {
    const error = new Error(`invalid JSON in ${file}: ${cause.message}`);
    error.code = 'CONFIG_INVALID';
    throw error;
  }
  if (typeof config.root !== 'string' || !path.isAbsolute(config.root)) {
    const error = new Error(`config.json must contain an absolute "root": ${file}`);
    error.code = 'CONFIG_INVALID';
    throw error;
  }
  if (!config.steps || typeof config.steps !== 'object') {
    const error = new Error(`config.json must contain "steps": ${file}`);
    error.code = 'CONFIG_INVALID';
    throw error;
  }
  return config;
}

export function scopesOf(config) {
  return Object.keys(config.steps?.test ?? {});
}

/** Checkout roots a request may come from (config entries relative to root). */
export function allowedWorkspaces(config) {
  const roots = [];
  for (const entry of config.allowedCwdRoots ?? ['.']) {
    const abs = path.isAbsolute(entry) ? entry : path.resolve(config.root, entry);
    if (existsSync(abs)) roots.push(canonical(abs));
  }
  return roots;
}

export function cwdAllowed(cwd, config) {
  return allowedWorkspaces(config).some((root) => isUnder(cwd, root));
}

export function derivedDataFor(workspace, config) {
  const base = config.derivedDataRoot ?? '/tmp/dsh-gate';
  const hash = createHash('sha1').update(canonical(workspace)).digest('hex').slice(0, 12);
  return path.join(base, hash);
}

export function normalizeOnly(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 200) return null;
  return /^[A-Za-z0-9_.\/:-]+$/.test(value) ? value : null;
}

function expandHome(value) {
  return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

/** Resolve `{placeholder}` tokens in one configured argv element. */
export function resolveArg(arg, context) {
  const { config, workspace, only } = context;
  return arg.replace(/\{([a-zA-Z0-9_:-]+)\}/g, (match, name) => {
    if (name === 'workspace') return workspace;
    if (name === 'root') return config.root;
    if (name === 'project') return path.join(workspace, config.project ?? '');
    if (name === 'derivedData') return derivedDataFor(workspace, config);
    if (name === 'destination') return config.destination ?? '';
    if (name === 'only') return only ?? '';
    if (name.startsWith('scheme:')) return config.schemes?.[name.slice('scheme:'.length)] ?? match;
    return match;
  });
}

/**
 * Build the fixed step list for one request.
 *
 * `only` is substituted into argv elements that contain `{only}`; when no
 * filter is given those elements are dropped instead of becoming empty args.
 * @returns {Array<{label: string, argv: string[]}>}
 */
export function planFor(op, context) {
  const { config, scope } = context;
  const raw =
    op === 'build'
      ? (config.steps.build ?? [])
      : scopesOf(config)
          .filter((name) => scope === 'all' || name === scope)
          .flatMap((name) => config.steps.test[name] ?? []);
  return raw.map((step) => ({
    label: step.label ?? op,
    argv: (step.argv ?? [])
      .filter((arg) => !arg.includes('{only}') || context.only)
      .map((arg) => resolveArg(arg, context)),
  }));
}

function sbplLiteral(value) {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/**
 * macOS Seatbelt profile for one confined step.
 *
 * Allow-default + deny-all-writes + explicit allow-list of subpaths. Reads and
 * network stay unrestricted, matching the agent sandbox posture. Any profile
 * carrying `(deny file-write*)` breaks Xcode's nested macro sandbox, so Xcode
 * templates must keep passing `OTHER_SWIFT_FLAGS=-disable-sandbox`; that flag
 * disables the compiler subprocess sandbox only, not this file boundary.
 */
export function seatbeltProfile({ workspace, derivedData, config, context }) {
  const extra = (config.writeRoots ?? []).map((entry) => expandHome(resolveArg(entry, context)));
  const roots = [...new Set([workspace, derivedData, '/tmp', os.tmpdir(), '/dev', ...extra].map(canonical))];
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* ${roots.map((root) => `(subpath ${sbplLiteral(root)})`).join(' ')})`,
  ].join(' ');
}

/** Locate an executable the way a shell would, without invoking a shell. */
export function findExecutable(program) {
  if (program.includes('/')) return existsSync(program) ? program : null;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, program);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
