// Hyperion as its own window (like a desktop app): Edge app mode, and the server stops when the last window closes.
import { spawn, execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const TITLE = 'Hyperion API'; // every page title contains this (index.html / app.js)

// last window size / position (the page reports it), next to the project registry
const BOUNDS_FILE = path.join(process.env.HYPERION_PROJECTS_FILE ? path.dirname(process.env.HYPERION_PROJECTS_FILE) : path.join(os.homedir(), '.hyperion'), 'window.json');

export async function saveWindowBounds(b) {
  const n = (v) => Math.round(Number(v));
  const bounds = { x: n(b.x), y: n(b.y), w: n(b.w), h: n(b.h), max: !!b.max };
  if (![bounds.x, bounds.y, bounds.w, bounds.h].every(Number.isFinite) || bounds.w < 400 || bounds.h < 300) return false;
  await mkdir(path.dirname(BOUNDS_FILE), { recursive: true });
  await writeFile(BOUNDS_FILE, JSON.stringify(bounds), 'utf8');
  return true;
}

function windowArgs() {
  try {
    const b = JSON.parse(readFileSync(BOUNDS_FILE, 'utf8'));
    if (b.max) return ['--start-maximized'];
    return [`--window-size=${b.w},${b.h}`, `--window-position=${b.x},${b.y}`];
  } catch {
    return ['--window-size=1440,900'];
  }
}

export function openWindow(url) {
  const edge = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
  // app mode = a standalone window with its own taskbar entry; fall back to the default browser
  if (edge) spawn(edge, [`--app=${url}`, ...windowArgs()], { detached: true, stdio: 'ignore' }).unref();
  else if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

// Is a browser window titled "...Hyperion API..." still open? Edge freezes minimised pages (no pings), so silence
// alone does not mean the window was closed. Inline -Command, so no script file and no execution-policy change.
const FIND = `
Add-Type @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class HyperionWin {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static uint[] Find(string part) {
    var found = new List<uint>();
    EnumWindows((h, l) => {
      if (IsWindowVisible(h)) {
        var sb = new StringBuilder(512); GetWindowText(h, sb, 512);
        if (sb.ToString().Contains(part)) { uint pid; GetWindowThreadProcessId(h, out pid); found.Add(pid); }
      }
      return true;
    }, IntPtr.Zero);
    return found.ToArray();
  }
}
'@
$browsers = 'msedge', 'chrome', 'firefox', 'brave', 'opera', 'vivaldi'
$open = [HyperionWin]::Find('${TITLE}') | Where-Object { $browsers -contains (Get-Process -Id $_ -ErrorAction SilentlyContinue).ProcessName }
if ($open) { '1' } else { '0' }
`;

const windowOpen = () =>
  new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(false);
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', FIND], { windowsHide: true, timeout: 20000 }, (e, out) =>
      resolve(e ? true : String(out).trim() === '1'), // unsure -> keep running
    );
  });

/**
 * Track open pages (each pings every 10 s, says bye on close). Calls onLastClosed when the last page is gone:
 * 4 s after a bye with nobody back (a reload is back within ~1 s), or after 90 s of silence with no window left.
 */
export function trackPages(onLastClosed) {
  const pages = new Map(); // page id -> last ping
  let hadPage = false;
  let byeTimer = null;
  let checking = false;
  let nextCheck = 0;
  let lastTick = Date.now();
  const dropSilent = () => {
    const now = Date.now();
    for (const [p, t] of pages) if (now - t > 90000) pages.delete(p);
  };
  setInterval(async () => {
    const now = Date.now();
    const slept = now - lastTick > 45000; // PC was asleep: give pages a fresh 90 s
    lastTick = now;
    if (slept) return void pages.forEach((_, p) => pages.set(p, now));
    dropSilent();
    if (pages.size || !hadPage || byeTimer || checking || now < nextCheck) return;
    checking = true;
    const open = await windowOpen();
    checking = false;
    if (pages.size || byeTimer) return;
    if (!open) return onLastClosed('no window for 90 s');
    nextCheck = Date.now() + 60000;
  }, 15000).unref();
  return {
    ping(p) {
      if (p) {
        pages.set(p, Date.now());
        hadPage = true;
      }
      clearTimeout(byeTimer);
      byeTimer = null;
    },
    bye(p) {
      if (p) pages.delete(p);
      clearTimeout(byeTimer);
      byeTimer = setTimeout(() => {
        byeTimer = null;
        dropSilent();
        if (!pages.size) onLastClosed('window closed');
      }, 4000);
    },
  };
}
