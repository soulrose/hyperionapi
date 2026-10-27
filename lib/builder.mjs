// Schema explorer (Postman-style field tree): list a type's fields, and tick / untick a field to edit the query.
// Edits go through the GraphQL AST, so the query stays valid and the editor and the checkboxes agree both ways.
import { parse, print, getNamedType, isLeafType, isObjectType, isInterfaceType, isNonNullType, Kind } from 'graphql';

const rootType = (schema, op) => (op === 'mutation' ? schema.getMutationType() : op === 'subscription' ? schema.getSubscriptionType() : schema.getQueryType());

/** Type reached by following field names from the operation root, or null. */
function typeAt(schema, op, path) {
  let t = rootType(schema, op);
  for (const name of path) {
    const f = t && (isObjectType(t) || isInterfaceType(t)) ? t.getFields()[name] : null;
    if (!f) return null;
    t = getNamedType(f.type);
  }
  return t;
}

/** Fields under op + path, for one level of the tree. */
export function fieldsAt(schema, op, path = []) {
  const t = typeAt(schema, op, path);
  if (!t || !(isObjectType(t) || isInterfaceType(t))) return [];
  return Object.values(t.getFields()).map((f) => ({
    name: f.name,
    type: String(f.type),
    leaf: isLeafType(getNamedType(f.type)),
    args: f.args.map((a) => ({ name: a.name, type: String(a.type), required: isNonNullType(a.type) && a.defaultValue === undefined })),
    description: f.description ?? '',
    deprecated: !!f.deprecationReason,
  }));
}

export const roots = (schema) => ({
  query: !!schema.getQueryType(),
  mutation: !!schema.getMutationType(),
});

function parseOrEmpty(query) {
  try {
    return query?.trim() ? parse(query) : { kind: Kind.DOCUMENT, definitions: [] };
  } catch {
    return null; // the editor holds an unfinished query: nothing can be ticked from it
  }
}

const firstOp = (doc, op) => doc.definitions.find((d) => d.kind === Kind.OPERATION_DEFINITION && d.operation === op);

/**
 * Ticked paths in the query, e.g. ["query:patient", "query:patient.visits", "query:patient.visits.visitId"],
 * and for each field the arguments it passes: { "query:patient": { hn: { var: "hn" } } } (or { value: "…" } for literals).
 */
export function selectedPaths(query) {
  const doc = parseOrEmpty(query);
  const out = [];
  const args = {};
  if (!doc) return { paths: out, args, valid: false };
  const walk = (set, op, prefix) => {
    for (const s of set?.selections ?? []) {
      if (s.kind !== Kind.FIELD) continue;
      const p = prefix ? `${prefix}.${s.name.value}` : s.name.value;
      out.push(`${op}:${p}`);
      if (s.arguments?.length) {
        args[`${op}:${p}`] = Object.fromEntries(
          s.arguments.map((a) => [a.name.value, a.value.kind === Kind.VARIABLE ? { var: a.value.name.value } : { value: print(a.value) }]),
        );
      }
      walk(s.selectionSet, op, p);
    }
  };
  for (const d of doc.definitions) if (d.kind === Kind.OPERATION_DEFINITION) walk(d.selectionSet, d.operation, '');
  return { paths: out, args, valid: true };
}

const pascal = (s) => s.replace(/(^|[^A-Za-z0-9]+)([A-Za-z0-9])/g, (_, __, c) => c.toUpperCase());
const name = (value) => ({ kind: Kind.NAME, value });

/** Parse a type string like "[String!]!" into an AST type node. */
function typeNode(str) {
  if (str.endsWith('!')) return { kind: Kind.NON_NULL_TYPE, type: typeNode(str.slice(0, -1)) };
  if (str.startsWith('[')) return { kind: Kind.LIST_TYPE, type: typeNode(str.slice(1, -1)) };
  return { kind: Kind.NAMED_TYPE, name: name(str) };
}

/** A placeholder value for a new variable, so the Variables JSON shows what to fill in. */
function sample(typeStr) {
  const t = typeStr.replace(/!/g, '');
  if (t.startsWith('[')) return [];
  if (/^(Int|Float|Long|BigDecimal|Short)$/.test(t)) return 0;
  if (t === 'Boolean') return false;
  return '';
}

/**
 * Tick (on) or untick a field at op + path. Returns the new query and any variables that were added/removed.
 * Ticking an object field also ticks `id` (or its first scalar) so the query is valid straight away.
 */
export function toggleField(schema, query, op, path, on) {
  const doc = parseOrEmpty(query);
  if (!doc) throw new Error('Fix the query first (it does not parse yet), then tick fields');
  // AST nodes from graphql-js are frozen in dev builds; work on a plain copy
  const ast = JSON.parse(JSON.stringify(doc));
  let operation = firstOp(ast, op);
  if (!operation) {
    if (!on) return { query, added: {}, removed: [] };
    operation = {
      kind: Kind.OPERATION_DEFINITION,
      operation: op,
      name: name(pascal(path[0]) || 'MyQuery'),
      variableDefinitions: [],
      directives: [],
      selectionSet: { kind: Kind.SELECTION_SET, selections: [] },
    };
    ast.definitions.push(operation);
  }
  operation.variableDefinitions ??= [];
  const added = {};
  const usedVars = new Set(operation.variableDefinitions.map((v) => v.variable.name.value));

  let parentType = rootType(schema, op);
  let set = operation.selectionSet;
  const trail = []; // [selectionSet, field] per level, to prune empty parents on untick
  for (let i = 0; i < path.length; i++) {
    const fname = path[i];
    const fdef = parentType?.getFields?.()[fname];
    if (!fdef) throw new Error(`Field "${path.slice(0, i + 1).join('.')}" not found in schema`);
    let field = set.selections.find((s) => s.kind === Kind.FIELD && s.name.value === fname && !s.alias);
    if (!field) {
      if (!on) return { query, added: {}, removed: [] }; // already not selected
      field = { kind: Kind.FIELD, name: name(fname), arguments: [], directives: [] };
      // required arguments become variables: $hn: String!
      for (const a of fdef.args) {
        if (!(isNonNullType(a.type) && a.defaultValue === undefined)) continue;
        let v = a.name;
        for (let n = 2; usedVars.has(v); n++) v = `${fname}${a.name[0].toUpperCase()}${a.name.slice(1)}${n > 2 ? n : ''}`;
        usedVars.add(v);
        operation.variableDefinitions.push({ kind: Kind.VARIABLE_DEFINITION, variable: { kind: Kind.VARIABLE, name: name(v) }, type: typeNode(String(a.type)), directives: [] });
        field.arguments.push({ kind: Kind.ARGUMENT, name: name(a.name), value: { kind: Kind.VARIABLE, name: name(v) } });
        added[v] = sample(String(a.type));
      }
      set.selections.push(field);
    }
    trail.push([set, field]);
    const named = getNamedType(fdef.type);
    if (i < path.length - 1) {
      field.selectionSet ??= { kind: Kind.SELECTION_SET, selections: [] };
      set = field.selectionSet;
      parentType = named;
    } else if (on && !isLeafType(named) && !field.selectionSet?.selections?.length) {
      // a bare object field is invalid GraphQL: start it with id / the first scalar
      const leaves = Object.values(named.getFields?.() ?? {}).filter((f) => isLeafType(getNamedType(f.type)) && !f.args.some((a) => isNonNullType(a.type)));
      const pick = leaves.find((f) => f.name === 'id') ?? leaves[0];
      field.selectionSet = { kind: Kind.SELECTION_SET, selections: pick ? [{ kind: Kind.FIELD, name: name(pick.name), arguments: [], directives: [] }] : [] };
    }
  }

  if (!on) {
    // remove the field, then any parent left with an empty selection
    for (let i = trail.length - 1; i >= 0; i--) {
      const [s, f] = trail[i];
      if (i === trail.length - 1 || !f.selectionSet?.selections?.length) s.selections = s.selections.filter((x) => x !== f);
      else break;
    }
    if (!operation.selectionSet.selections.length) ast.definitions = ast.definitions.filter((d) => d !== operation);
  }

  // drop variable definitions nothing uses any more
  const removed = [];
  if (ast.definitions.includes(operation)) {
    const used = new Set();
    const scan = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.kind === Kind.VARIABLE && node !== undefined) used.add(node.name.value);
      for (const [k, v] of Object.entries(node)) if (k !== 'variableDefinitions' && k !== 'loc') Array.isArray(v) ? v.forEach(scan) : scan(v);
    };
    scan(operation.selectionSet);
    operation.variableDefinitions = operation.variableDefinitions.filter((d) => used.has(d.variable.name.value) || (removed.push(d.variable.name.value), false));
  } else removed.push(...(operation.variableDefinitions ?? []).map((d) => d.variable.name.value));

  const text = ast.definitions.length ? `${print(ast)}\n` : '';
  return { query: text, added, removed };
}

/** Plain (scalar / enum) fields directly under op + path that need no arguments — what "select all" ticks. */
function leafNames(schema, op, path) {
  return fieldsAt(schema, op, path)
    .filter((f) => f.leaf && !f.args.some((a) => a.required))
    .map((f) => f.name);
}

/** Tick (on) or untick every plain field under op + path. The object field itself is ticked first if needed. */
export function toggleAll(schema, query, op, path, on) {
  let q = query;
  const added = {};
  const removed = [];
  const names = leafNames(schema, op, path);
  if (on) {
    for (const n of names) {
      const r = toggleField(schema, q, op, [...path, n], true);
      q = r.query;
      Object.assign(added, r.added);
    }
  } else {
    // untick from the last one so the object field goes away only when nothing is left
    for (const n of names) {
      if (!selectedPaths(q).paths.includes(`${op}:${[...path, n].join('.')}`)) continue;
      const r = toggleField(schema, q, op, [...path, n], false);
      q = r.query;
      removed.push(...r.removed);
    }
  }
  return { query: q, added, removed };
}

/** Find the field node at op + path in a plain-object AST, or null. */
function fieldNode(operation, path) {
  let set = operation?.selectionSet;
  let field = null;
  for (const n of path) {
    field = set?.selections.find((s) => s.kind === Kind.FIELD && s.name.value === n && !s.alias) ?? null;
    if (!field) return null;
    set = field.selectionSet;
  }
  return field;
}

/**
 * Pass an argument of the field at op + path as a variable (on), or stop passing it (off).
 * Ticks the field first if needed. Returns the variable's name so the UI can put the typed value there.
 */
export function toggleArg(schema, query, op, path, argName, on) {
  const fdef = typeAt(schema, op, path.slice(0, -1))?.getFields?.()[path.at(-1)];
  const adef = fdef?.args.find((a) => a.name === argName);
  if (!adef) throw new Error(`Argument "${argName}" not found on ${path.join('.')}`);

  let q = query;
  const added = {};
  if (on && !selectedPaths(q).paths.includes(`${op}:${path.join('.')}`)) {
    const r = toggleField(schema, q, op, path, true);
    q = r.query;
    Object.assign(added, r.added);
  }
  const doc = parseOrEmpty(q);
  if (!doc) throw new Error('Fix the query first (it does not parse yet)');
  const ast = JSON.parse(JSON.stringify(doc));
  const operation = firstOp(ast, op);
  const field = fieldNode(operation, path);
  if (!field) return { query: q, added, removed: [], varName: null };
  field.arguments ??= [];
  operation.variableDefinitions ??= [];
  const existing = field.arguments.find((a) => a.name.value === argName);
  let varName = existing?.value.kind === Kind.VARIABLE ? existing.value.name.value : null;

  if (on && !existing) {
    const used = new Set(operation.variableDefinitions.map((v) => v.variable.name.value));
    varName = argName;
    for (let n = 2; used.has(varName); n++) varName = `${path.at(-1)}${argName[0].toUpperCase()}${argName.slice(1)}${n > 2 ? n : ''}`;
    operation.variableDefinitions.push({ kind: Kind.VARIABLE_DEFINITION, variable: { kind: Kind.VARIABLE, name: name(varName) }, type: typeNode(String(adef.type)), directives: [] });
    field.arguments.push({ kind: Kind.ARGUMENT, name: name(argName), value: { kind: Kind.VARIABLE, name: name(varName) } });
    added[varName] = sample(String(adef.type));
  }
  const removed = [];
  if (!on && existing) {
    field.arguments = field.arguments.filter((a) => a !== existing);
    if (varName) {
      if (!usesVariable(operation.selectionSet, varName)) {
        operation.variableDefinitions = operation.variableDefinitions.filter((d) => d.variable.name.value !== varName);
        removed.push(varName);
      }
    }
    varName = null;
  }
  return { query: `${print(ast)}\n`, added, removed, varName };
}

/** Does any $variable reference under this AST node use `name`? (field names do not count) */
function usesVariable(node, varName) {
  if (!node || typeof node !== 'object') return false;
  if (node.kind === Kind.VARIABLE) return node.name.value === varName;
  return Object.entries(node).some(([k, v]) => k !== 'loc' && (Array.isArray(v) ? v.some((x) => usesVariable(x, varName)) : usesVariable(v, varName)));
}
