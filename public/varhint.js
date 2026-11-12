// {{variables}} in text boxes: the value on hover, and suggestions while typing after "{{"
const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;
const TYPING = /\{\{\s*([\w.$:-]*)$/;
const DYNAMIC = ['$today', '$isoNow', '$timestamp', '$uuid', '$randomInt'];

/** context() → { file, env }: the open request (if any) and the env on screen */
export function initVarHints({ api, context, t, esc }) {
  let cache = { key: '', at: 0, list: [] };
  async function load() {
    const { file, env } = context();
    const key = `${file ?? ''}|${env}`;
    if (cache.key !== key || Date.now() - cache.at > 5000) {
      const r = await api(`/api/vars?env=${encodeURIComponent(env)}${file ? `&file=${encodeURIComponent(file)}` : ''}`).catch(() => ({ vars: [] }));
      cache = { key, at: Date.now(), list: r.vars };
    }
    return cache.list;
  }
  const eligible = (el) => el instanceof HTMLInputElement && (el.type === 'text' || !el.getAttribute('type')) && !el.readOnly;

  function describe(name, map, env) {
    if (name.startsWith('secret:')) return `${name} = ${t('(secret — not shown)')}`;
    if (name.startsWith('$')) return `${name} = ${t('(new value on every send)')}`;
    const v = map.get(name);
    return v?.value != null ? `${name} = ${v.value}  · ${v.from}` : `${name} — ${t('not set in {env}', { env })}`;
  }

  // hover: the input's own tooltip is kept and the values go first
  document.addEventListener('mouseover', async (e) => {
    const el = e.target;
    if (!eligible(el)) return;
    el.dataset.ownTitle ??= el.title;
    const names = [...new Set([...el.value.matchAll(PLACEHOLDER)].map((m) => m[1]))];
    if (!names.length) return void (el.title = el.dataset.ownTitle);
    const list = await load();
    const map = new Map(list.map((v) => [v.name, v]));
    el.title = [...names.map((n) => describe(n, map, context().env)), el.dataset.ownTitle].filter(Boolean).join('\n');
  });

  // suggestions: a popover, so it shows above open dialogs too
  const box = document.createElement('ul');
  box.className = 'ac var-ac';
  box.popover = 'manual';
  box.setAttribute('role', 'listbox');
  document.body.append(box);
  let target = null;
  let items = [];
  let at = 0;
  const close = () => {
    target = null;
    if (box.matches(':popover-open')) box.hidePopover();
  };
  const paint = () => {
    box.innerHTML = items
      .map((v, i) => `<li role="option" data-i="${i}" aria-selected="${i === at}"><span>${esc(v.name)}</span><small>${esc(v.hint ?? '')}</small></li>`)
      .join('');
    box.children[at]?.scrollIntoView({ block: 'nearest' });
  };
  const caretX = (el, text) => {
    const cs = getComputedStyle(el);
    const ctx = (caretX.c ??= document.createElement('canvas').getContext('2d'));
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    return el.getBoundingClientRect().left + parseFloat(cs.paddingLeft) + ctx.measureText(text).width - el.scrollLeft;
  };

  async function suggest(el) {
    const before = el.value.slice(0, el.selectionStart);
    const m = TYPING.exec(before);
    if (!m) return close();
    const q = m[1].toLowerCase();
    const list = await load();
    const all = [...list.map((v) => ({ name: v.name, hint: v.value == null ? t('not set') : v.value.length > 40 ? `${v.value.slice(0, 40)}…` : v.value })), ...DYNAMIC.map((name) => ({ name, hint: t('dynamic') }))];
    items = all.filter((v) => v.name.toLowerCase().startsWith(q)).concat(all.filter((v) => !v.name.toLowerCase().startsWith(q) && v.name.toLowerCase().includes(q)));
    if (!items.length || document.activeElement !== el) return close();
    target = el;
    at = 0;
    paint();
    const r = el.getBoundingClientRect();
    box.style.left = `${Math.min(caretX(el, before.slice(0, m.index)), innerWidth - 300)}px`;
    box.style.top = `${r.bottom + 4}px`;
    if (!box.matches(':popover-open')) box.showPopover();
  }

  function accept(i) {
    const el = target;
    const name = items[i]?.name;
    if (!el || !name) return close();
    const caret = el.selectionStart;
    const m = TYPING.exec(el.value.slice(0, caret));
    const start = caret - m[0].length;
    const rest = el.value.slice(caret).replace(/^[\w.$:-]*\s*\}\}/, '');
    const insert = `{{${name}}}`;
    el.value = el.value.slice(0, start) + insert + rest;
    el.selectionStart = el.selectionEnd = start + insert.length;
    close();
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.focus();
  }

  document.addEventListener('input', (e) => eligible(e.target) && suggest(e.target));
  document.addEventListener(
    'keydown',
    (e) => {
      if (!target || e.target !== target) return;
      const move = { ArrowDown: 1, ArrowUp: -1 }[e.key];
      if (move) at = (at + move + items.length) % items.length;
      else if (e.key === 'Enter' || e.key === 'Tab') accept(at);
      else if (e.key === 'Escape') close();
      else return;
      e.preventDefault();
      e.stopPropagation();
      if (move) paint();
    },
    true,
  );
  box.addEventListener('mousedown', (e) => {
    e.preventDefault(); // keep the caret in the input
    const li = e.target.closest('li');
    if (li) accept(Number(li.dataset.i));
  });
  document.addEventListener('focusout', (e) => e.target === target && close());
  addEventListener('resize', close);
  document.addEventListener('scroll', (e) => !box.contains(e.target) && close(), true);
}
