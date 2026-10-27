// `hyperion shortcut` — a Desktop icon that opens Hyperion as its own window (start.bat: no console, no URL to type).
import { execFile } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const q = (s) => `'${String(s).replaceAll("'", "''")}'`; // PowerShell single-quoted string

/** folder: where the .lnk goes (default the Desktop); OffLab also uses one named start.lnk inside the app folder. */
export function makeShortcut({ name = 'Hyperion API', folder } = {}) {
  if (process.platform !== 'win32') return Promise.reject(new Error('shortcut is for Windows — elsewhere run `npm start`'));
  const where = folder ? q(folder) : "([Environment]::GetFolderPath('Desktop'))";
  const ps = [
    '$shell = New-Object -ComObject WScript.Shell',
    `$lnk = $shell.CreateShortcut((Join-Path ${where} ${q(`${name}.lnk`)}))`,
    `$lnk.TargetPath = ${q(path.join(root, 'start.bat'))}`,
    `$lnk.WorkingDirectory = ${q(root)}`,
    `$lnk.IconLocation = ${q(`${path.join(root, 'public', 'icon.ico')},0`)}`,
    '$lnk.WindowStyle = 1',
    `$lnk.Description = ${q('Hyperion API — GraphQL / REST / gRPC / WebSocket')}`,
    '$lnk.Save()',
    '$lnk.FullName',
  ].join('; ');
  return new Promise((resolve, reject) =>
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true }, (err, out, errOut) =>
      err ? reject(new Error(String(errOut || err.message).trim())) : resolve(String(out).trim()),
    ),
  );
}
