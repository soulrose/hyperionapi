// Console + JUnit output. Response bodies are masked (PHI) and never written to JUnit.
import { maskDeep } from './util.mjs';

const c = process.stdout.isTTY && !process.env.NO_COLOR
  ? { red: (s) => `\x1b[31m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m` }
  : { red: (s) => s, green: (s) => s, yellow: (s) => s, dim: (s) => s, bold: (s) => s };

export function printResult(r, { verbose = false, unmask = false, maskFields = [] } = {}) {
  const mark = r.blocked ? c.yellow('-') : r.passed ? c.green('✔') : c.red('✘');
  const passed = r.tests.filter((t) => t.pass).length;
  const meta = [r.status ?? '---', r.timeMs != null ? `${r.timeMs}ms` : '', r.tests.length ? `tests ${passed}/${r.tests.length}` : '']
    .filter(Boolean)
    .join('  ');
  console.log(`${mark} ${c.bold(r.name)}  ${c.dim(meta)}`);
  for (const t of r.tests) console.log(`    ${t.pass ? c.green('✓') : c.red('✗')} ${t.name}${t.error ? c.red(` — ${t.error}`) : ''}`);
  for (const w of r.warnings) console.log(c.yellow(`    warn: ${w}`));
  if (r.error) console.log(c.red(`    ${r.error}`));
  if (verbose && r.response) {
    const body = r.response.json !== undefined ? (unmask ? r.response.json : maskDeep(r.response.json, maskFields)) : r.response.text;
    const text = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
    console.log(c.dim(text.length > 4000 ? `${text.slice(0, 4000)}\n… (${text.length} chars)` : text).replace(/^/gm, '    '));
  }
}

export function printSummary(results) {
  const ok = results.filter((r) => r.passed).length;
  const blocked = results.filter((r) => r.blocked).length;
  const failed = results.length - ok - blocked;
  const line = `${ok} passed, ${failed} failed${blocked ? `, ${blocked} blocked` : ''} (${results.length} requests)`;
  console.log(`\n${failed ? c.red(line) : c.green(line)}`);
}

const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[ch]);

export function junit(results, suiteName = 'hyperion') {
  const cases = [];
  for (const r of results) {
    const time = ((r.timeMs ?? 0) / 1000).toFixed(3);
    if (r.error || r.blocked || !r.tests.length) {
      const fail = r.blocked ? `<skipped message="${esc(r.error)}"/>` : r.passed ? '' : `<failure message="${esc(r.error ?? `HTTP ${r.status}`)}"/>`;
      cases.push(`  <testcase classname="${esc(r.name)}" name="request" time="${time}">${fail}</testcase>`);
    }
    for (const t of r.tests) {
      cases.push(`  <testcase classname="${esc(r.name)}" name="${esc(t.name)}" time="${time}">${t.pass ? '' : `<failure message="${esc(t.error)}"/>`}</testcase>`);
    }
  }
  const failures = (s) => (s.match(/<failure/g) ?? []).length;
  const body = cases.join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${esc(suiteName)}" tests="${cases.length}" failures="${failures(body)}">\n${body}\n</testsuite>\n`;
}
