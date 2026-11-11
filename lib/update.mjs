// Check for updates: the newest vX.Y.Z tag on the Git remote (git ls-remote, so the computer's Git proxy / login apply).
// Update = fast-forward this checkout to that tag, npm install when package-lock.json changed, then restart the server.
// Only for a Git checkout with no edited tracked files; anything else gets the release page instead.
import { execFile, spawn } from 'node:child_process';
import { readFileSync, existsSync, openSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSetting } from './tls.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const RELEASES = 'https://github.com/soulrose/hyperionapi/tags';
const CHECK_EVERY_MS = 6 * 3600 * 1000;

const run = (cmd, args, cwd, timeout = 30000) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { cwd, timeout, windowsHide: true, shell: cmd === 'npm' }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).trim().split('\n').pop())) : resolve(stdout.trim()),
    ),
  );

const parse = (v) => String(v).replace(/^v/, '').split('.').map(Number);
/** a > b for X.Y.Z versions */
export function newer(a, b) {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

export const autoUpdate = () => getSetting('autoUpdate') !== false; // on unless switched off in Settings

const version = (root) => JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;

/** Newest release tag on origin: { latest, tag } or throws (offline, no Git). */
async function latestTag(root) {
  const out = await run('git', ['ls-remote', '--tags', '--refs', 'origin'], root, 15000);
  const tags = out
    .split('\n')
    .map((l) => l.split('refs/tags/')[1])
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t ?? ''));
  if (!tags.length) return {};
  const tag = tags.reduce((a, b) => (newer(b, a) ? b : a));
  return { latest: tag.slice(1), tag };
}

/** Why this checkout can't update itself in place (undefined = it can). */
async function blocker(root) {
  if (!existsSync(path.join(root, '.git'))) return 'not a Git checkout — download the new version';
  const dirty = await run('git', ['status', '--porcelain', '--untracked-files=no'], root);
  if (dirty) return 'files in the Hyperion folder were edited — commit or undo them first';
}

let cached = null; // { at, result }
export async function checkForUpdate({ force = false, root = ROOT } = {}) {
  if (!force && cached && cached.root === root && Date.now() - cached.at < CHECK_EVERY_MS) return cached.result;
  const current = version(root);
  let result;
  try {
    const { latest, tag } = await latestTag(root);
    const available = !!latest && newer(latest, current);
    result = { current, latest: latest ?? current, tag, available, releases: RELEASES, checkedAt: new Date().toISOString() };
    if (available) result.blocked = await blocker(root);
  } catch (err) {
    result = { current, available: false, error: `could not check: ${err.message}`, releases: RELEASES };
  }
  cached = { at: Date.now(), root, result };
  return result;
}

let busy = false;
/** Fast-forward to the newest tag; returns { from, to, installed }. The caller restarts the server. */
export async function applyUpdate({ root = ROOT } = {}) {
  if (busy) throw new Error('an update is already running');
  busy = true;
  try {
    const info = await checkForUpdate({ force: true, root });
    if (!info.available) throw new Error(info.error ?? `already on the newest version (${info.current})`);
    if (info.blocked) throw new Error(info.blocked);
    const lock = () => (existsSync(path.join(root, 'package-lock.json')) ? readFileSync(path.join(root, 'package-lock.json'), 'utf8') : '');
    const before = lock();
    await run('git', ['fetch', '--tags', 'origin'], root, 120000);
    await run('git', ['merge', '--ff-only', info.tag], root).catch((err) => {
      throw new Error(`can't fast-forward to ${info.tag} (this checkout has its own commits?): ${err.message}`);
    });
    const installed = lock() !== before;
    if (installed) await run('npm', ['install', '--no-audit', '--no-fund'], root, 300000);
    cached = null;
    return { from: info.current, to: version(root), installed };
  } finally {
    busy = false;
  }
}

/**
 * Start a new server on the same port (it waits for this one to let go of it) and stop this one.
 * The open window stays: its page reloads once the new server answers, and the new server keeps watching it.
 * open: no window yet (updated while starting) — the new server opens it.
 */
export function restart({ port, dir, open = false, root = ROOT }) {
  const log = (f) => (existsSync(path.join(root, f)) ? openSync(path.join(root, f), 'a') : 'ignore');
  const args = [path.join(root, 'bin/hyperion.mjs'), 'serve', ...(dir ? [dir] : []), '--port', String(port), open ? '--open' : '--attach'];
  spawn(process.execPath, args, {
    cwd: root,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', log('server.log'), log('server.err.log')],
    env: { ...process.env, HYPERION_RESTART: '1' },
  }).unref();
  setTimeout(() => process.exit(0), 300);
}
