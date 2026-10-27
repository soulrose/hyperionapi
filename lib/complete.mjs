// Lightweight GraphQL field autocomplete: walk the selection-set path up to the cursor and list fields of that type.
import { getNamedType, isObjectType, isInterfaceType, isUnionType } from 'graphql';

function tokens(text) {
  // drop strings and comments so braces inside them do not count
  const clean = text.replace(/"""[\s\S]*?(?:"""|$)|"(?:\\.|[^"\\\n])*"?|#[^\n]*/g, (m) => ' '.repeat(m.length));
  return clean.match(/\.\.\.|[A-Za-z_][A-Za-z0-9_]*|[{}()]|:/g) ?? [];
}

/** Type at the cursor, or null when the cursor is not inside a selection set we can resolve. */
export function typeAtCursor(schema, before) {
  const toks = tokens(before);
  const stack = []; // GraphQL types per open "{"
  let parens = 0;
  let lastField = null;
  let opType = null;
  let typeCondition = null;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === '(') parens++;
    else if (t === ')') parens--;
    else if (parens > 0) continue;
    else if (t === 'query' || t === 'mutation' || t === 'subscription') {
      if (!stack.length) opType = t;
    } else if (t === 'on' && toks[i - 1] === '...') typeCondition = toks[++i];
    else if (t === 'fragment') {
      // fragment Name on Type {
      i += 1;
      if (toks[i + 1] === 'on') typeCondition = toks[(i += 2)];
    } else if (t === '{') {
      if (!stack.length) {
        const root = typeCondition
          ? schema.getType(typeCondition)
          : opType === 'mutation'
            ? schema.getMutationType()
            : opType === 'subscription'
              ? schema.getSubscriptionType()
              : schema.getQueryType();
        stack.push(root ?? null);
      } else if (typeCondition) stack.push(schema.getType(typeCondition) ?? null);
      else {
        const parent = stack.at(-1);
        const field = parent && (isObjectType(parent) || isInterfaceType(parent)) ? parent.getFields()[lastField] : null;
        stack.push(field ? getNamedType(field.type) : null);
      }
      typeCondition = null;
      lastField = null;
    } else if (t === '}') {
      stack.pop();
      if (!stack.length) opType = null;
    } else if (t === ':') lastField = null; // alias: next word is the real field
    else if (/^[A-Za-z_]/.test(t)) lastField = t;
  }
  return stack.length ? stack.at(-1) : null;
}

export function complete(schema, text, offset) {
  const before = text.slice(0, offset);
  const prefix = before.match(/[A-Za-z_][A-Za-z0-9_]*$/)?.[0] ?? '';
  const type = typeAtCursor(schema, before.slice(0, before.length - prefix.length));
  if (!type) return { prefix, type: null, items: [] };
  let items = [];
  if (isObjectType(type) || isInterfaceType(type)) {
    items = Object.values(type.getFields()).map((f) => ({
      label: f.name,
      detail: String(f.type),
      args: f.args.map((a) => `${a.name}: ${a.type}`),
      doc: f.description ?? '',
      deprecated: !!f.deprecationReason,
      hasSelection: !!getNamedType(f.type).getFields,
    }));
  }
  if (isUnionType(type)) items = type.getTypes().map((t) => ({ label: `... on ${t.name}`, detail: 'type', args: [], doc: '' }));
  items.push({ label: '__typename', detail: 'String!', args: [], doc: '' });
  const p = prefix.toLowerCase();
  items = items
    .filter((i) => i.label.toLowerCase().includes(p))
    .sort((a, b) => Number(!a.label.toLowerCase().startsWith(p)) - Number(!b.label.toLowerCase().startsWith(p)) || a.label.localeCompare(b.label));
  return { prefix, type: type.name, items: items.slice(0, 50) };
}
