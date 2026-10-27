// beforeRequest / afterResponse scripts in a node:vm context with a time limit.
// Not a security boundary — scripts come from the team's own repo.
import vm from 'node:vm';
import { inspect } from 'node:util';
import { createPm, deepEqual } from './pm-shim.mjs';

const show = (v) => inspect(v, { depth: 3, breakLength: Infinity });

function matchers(actual, negate) {
  const check = (pass, msg) => {
    if (pass === negate) throw new Error(`expected ${show(actual)} ${negate ? 'not ' : ''}${msg}`);
  };
  return {
    toBe: (e) => check(Object.is(actual, e), `to be ${show(e)}`),
    toEqual: (e) => check(deepEqual(actual, e), `to equal ${show(e)}`),
    toBeTruthy: () => check(!!actual, 'to be truthy'),
    toBeFalsy: () => check(!actual, 'to be falsy'),
    toBeNull: () => check(actual === null, 'to be null'),
    toBeUndefined: () => check(actual === undefined, 'to be undefined'),
    toBeDefined: () => check(actual !== undefined, 'to be defined'),
    toContain: (e) => check(actual?.includes?.(e) === true, `to contain ${show(e)}`),
    toHaveLength: (n) => check(actual?.length === n, `to have length ${n}`),
    toHaveProperty: (k) => check(actual != null && k in Object(actual), `to have property ${show(k)}`),
    toBeGreaterThan: (n) => check(actual > n, `to be > ${n}`),
    toBeLessThan: (n) => check(actual < n, `to be < ${n}`),
    toMatch: (re) => check(new RegExp(re).test(String(actual)), `to match ${re}`),
  };
}

export function createTestApi() {
  const pending = [];
  const $test = (name, fn) => {
    pending.push(
      (async () => {
        try {
          await fn();
          return { name, pass: true };
        } catch (err) {
          return { name, pass: false, error: err.message };
        }
      })(),
    );
  };
  const $expect = (actual) => ({ ...matchers(actual, false), not: matchers(actual, true) });
  return { $test, $expect, results: () => Promise.all(pending) };
}

export async function runScript(code, api, { timeoutMs = 5000, label = 'script' } = {}) {
  if (!code?.trim()) return;
  const pending = [];
  const context = vm.createContext({ ...api, ...createPm(api, pending), URL, URLSearchParams, TextEncoder, TextDecoder, structuredClone, setTimeout, clearTimeout });
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    const run = vm.runInContext(`(async () => {\n${code}\n})()`, context, { timeout: timeoutMs, filename: label });
    await Promise.race([run.then(() => Promise.all(pending)), timeout]);
  } catch (err) {
    throw new Error(`${label}: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}
