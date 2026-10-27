// WSDL 1.1 → services / ports / operations with a ready-to-send sample envelope per operation.
// document/literal: the input part's element built from the <types> XSD; rpc: the operation element with its parts.
// wsdl:import and xsd:import / xsd:include with a location are followed (a few levels, each file once).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { send } from './http.mjs';
import { parseXml, walk, qname } from './xml.mjs';

const XSD = 'http://www.w3.org/2001/XMLSchema';
const WSDL = 'http://schemas.xmlsoap.org/wsdl/';
const SOAP11_WSDL = 'http://schemas.xmlsoap.org/wsdl/soap/';
const SOAP12_WSDL = 'http://schemas.xmlsoap.org/wsdl/soap12/';
export const SOAP_ENV = { '1.1': 'http://schemas.xmlsoap.org/soap/envelope/', '1.2': 'http://www.w3.org/2003/05/soap-envelope' };

const key = (ns, local) => `${ns}|${local}`;
const kids = (node, local, ns) => (node?.children ?? []).filter((c) => c.local === local && (ns == null || c.ns === ns));
const kid = (node, local, ns) => kids(node, local, ns)[0];
const isUrl = (s) => /^https?:\/\//i.test(String(s));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Read a WSDL / XSD from a URL (with the given headers) or a file (relative to baseDir). */
async function fetchText(loc, { headers = {}, timeoutMs = 15000 } = {}) {
  if (isUrl(loc)) {
    const r = await send({ method: 'GET', url: loc, headers, timeoutMs });
    if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
    return r.text;
  }
  return readFile(loc, 'utf8').catch((e) => {
    throw new Error(e.code === 'ENOENT' ? 'file not found' : e.message);
  });
}

const resolveLoc = (loc, base) => (isUrl(loc) ? loc : isUrl(base) ? new URL(loc, base).toString() : path.resolve(path.dirname(base), loc));

/**
 * Load a WSDL and everything it imports. source: URL or file path; opts: { headers, baseDir, timeoutMs }.
 * Returns { defs: [definitions roots], schemas: [schema roots], notes: [what could not be loaded] }.
 */
export async function loadWsdl(source, opts = {}) {
  const src = String(source ?? '').trim();
  if (!src) throw new Error('Enter the WSDL URL or file path first');
  const first = isUrl(src) ? src : path.resolve(opts.baseDir ?? process.cwd(), src);
  const out = { defs: [], schemas: [], notes: [] };
  const seen = new Set();

  const load = async (loc) => {
    let text;
    try {
      text = await fetchText(loc, opts);
    } catch (e) {
      throw new Error(`Could not load WSDL ${loc}: ${e.message}`);
    }
    let root;
    try {
      root = parseXml(text);
    } catch (e) {
      throw new Error(`Could not load WSDL ${loc}: ${e.message}`);
    }
    if (!root) throw new Error(`Could not load WSDL ${loc}: empty document`);
    return root;
  };

  const addSchema = async (schema, base, depth, chameleonNs) => {
    const info = { tns: schema.attrs.targetNamespace ?? chameleonNs ?? '', qualified: schema.attrs.elementFormDefault === 'qualified' };
    for (const n of walk(schema)) n.schemaInfo = info;
    out.schemas.push(schema);
    for (const imp of [...kids(schema, 'import', XSD), ...kids(schema, 'include', XSD)]) {
      const loc = imp.attrs.schemaLocation;
      if (!loc) continue;
      const full = resolveLoc(loc, base);
      if (seen.has(full)) continue;
      seen.add(full);
      if (depth >= 4) {
        out.notes.push(`Schema not loaded (nested too deep): ${loc}`);
        continue;
      }
      try {
        const root = await load(full);
        if (root.local !== 'schema') throw new Error(`not an XML schema (root element is <${root.local}>)`);
        await addSchema(root, full, depth + 1, imp.local === 'include' ? info.tns : undefined);
      } catch (e) {
        out.notes.push(e.message);
      }
    }
  };

  const addDefs = async (root, base, depth) => {
    if (root.local === 'description') throw new Error('WSDL 2.0 is not supported — use the service\'s WSDL 1.1 (often ?wsdl instead of ?wsdl2)');
    if (root.local !== 'definitions') throw new Error(`Not a WSDL: the root element is <${root.local}>`);
    out.defs.push(root);
    for (const imp of kids(root, 'import', WSDL)) {
      const loc = imp.attrs.location;
      if (!loc) continue;
      const full = resolveLoc(loc, base);
      if (seen.has(full)) continue;
      seen.add(full);
      try {
        const r = await load(full);
        if (r.local === 'schema') await addSchema(r, full, depth + 1);
        else if (depth < 4) await addDefs(r, full, depth + 1);
      } catch (e) {
        out.notes.push(e.message);
      }
    }
    for (const types of kids(root, 'types')) for (const s of kids(types, 'schema', XSD)) await addSchema(s, base, depth);
  };

  seen.add(first);
  await addDefs(await load(first), first, 0);
  return out;
}

/** Index of what the WSDL defines, by `{ns}|local`. */
function indexOf(w) {
  const idx = { messages: {}, portTypes: {}, bindings: {}, elements: {}, types: {}, groups: {}, attrGroups: {} };
  for (const d of w.defs) {
    const tns = d.attrs.targetNamespace ?? '';
    for (const m of kids(d, 'message')) idx.messages[key(tns, m.attrs.name)] = m;
    for (const p of kids(d, 'portType')) idx.portTypes[key(tns, p.attrs.name)] = p;
    for (const b of kids(d, 'binding')) idx.bindings[key(tns, b.attrs.name)] = b;
  }
  for (const s of w.schemas) {
    const tns = s.schemaInfo.tns;
    for (const c of s.children) {
      const k = key(tns, c.attrs.name);
      if (c.local === 'element') idx.elements[k] = c;
      else if (c.local === 'complexType' || c.local === 'simpleType') idx.types[k] = c;
      else if (c.local === 'group') idx.groups[k] = c;
      else if (c.local === 'attributeGroup') idx.attrGroups[k] = c;
    }
  }
  return idx;
}

const NUMERIC = new Set(['int', 'integer', 'long', 'short', 'byte', 'decimal', 'double', 'float', 'unsignedInt', 'unsignedLong', 'unsignedShort', 'unsignedByte', 'positiveInteger', 'nonNegativeInteger', 'negativeInteger', 'nonPositiveInteger']);

function builtinSample(local) {
  const today = new Date().toISOString().slice(0, 10);
  if (NUMERIC.has(local)) return local === 'positiveInteger' ? '1' : local === 'negativeInteger' ? '-1' : '0';
  if (local === 'boolean') return 'false';
  if (local === 'date') return today;
  if (local === 'dateTime') return `${today}T00:00:00`;
  if (local === 'time') return '00:00:00';
  if (local === 'gYear') return today.slice(0, 4);
  if (local === 'duration') return 'P0D';
  return '?';
}

/** Builds the body XML for one operation; namespace prefixes are collected as they are used. */
class EnvelopeWriter {
  constructor(idx, preferred) {
    this.idx = idx;
    this.preferred = preferred; // URI → prefix the WSDL itself uses
    this.prefixes = new Map();
    this.lines = [];
  }

  prefix(ns) {
    if (!this.prefixes.has(ns)) {
      const used = new Set([...this.prefixes.values(), 'soap', 'xsi', 'xsd', 'xs', 'xml']);
      let p = this.preferred[ns];
      if (!p || used.has(p) || !/^[A-Za-z_][\w.-]*$/.test(p)) {
        let n = 1;
        while (used.has(`ns${n}`)) n++;
        p = `ns${n}`;
      }
      this.prefixes.set(ns, p);
    }
    return this.prefixes.get(ns);
  }

  line(indent, s) {
    this.lines.push(`${'  '.repeat(indent)}${s}`);
  }

  simpleSample(node, stack) {
    if (!node) return '?';
    if (node.local === 'simpleType') {
      const r = kid(node, 'restriction');
      if (r) {
        const en = kid(r, 'enumeration');
        if (en) return en.attrs.value ?? '';
        if (r.attrs.base) return this.typeSample(qname(r.attrs.base, r), stack);
        return this.simpleSample(kid(r, 'simpleType'), stack);
      }
      const list = kid(node, 'list');
      if (list?.attrs.itemType) return this.typeSample(qname(list.attrs.itemType, list), stack);
      return '?';
    }
    return '?';
  }

  /** Text value for a simple type reference. */
  typeSample(t, stack) {
    if (t.ns === XSD) return builtinSample(t.local);
    const def = this.idx.types[key(t.ns, t.local)];
    if (def?.local === 'simpleType' && !stack.includes(def)) return this.simpleSample(def, [...stack, def]);
    return '?';
  }

  /** Attributes (use="required" only) of a complexType or an extension. */
  attributes(node, stack, out = []) {
    for (const c of node.children) {
      if (c.local === 'attribute' && c.attrs.use === 'required') {
        const name = c.attrs.name ?? qname(c.attrs.ref, c).local;
        const v = c.attrs.type ? this.typeSample(qname(c.attrs.type, c), stack) : this.simpleSample(kid(c, 'simpleType'), stack);
        out.push(`${name}="${esc(c.attrs.fixed ?? c.attrs.default ?? v)}"`);
      } else if (c.local === 'attributeGroup' && c.attrs.ref) {
        const g = this.idx.attrGroups[key(...Object.values(qname(c.attrs.ref, c)))];
        if (g && !stack.includes(g)) this.attributes(g, [...stack, g], out);
      }
    }
    return out;
  }

  /** Children of a sequence / all / choice / group. */
  particles(node, indent, stack) {
    for (const c of node.children) {
      if (c.local === 'element') this.element(c, indent, stack, false);
      else if (c.local === 'sequence' || c.local === 'all') this.particles(c, indent, stack);
      else if (c.local === 'choice') {
        const names = c.children.filter((x) => x.local === 'element').map((x) => x.attrs.name ?? qname(x.attrs.ref, x).local);
        if (names.length > 1) this.line(indent, `<!-- choice: one of ${names.join(', ')} -->`);
        const firstOpt = c.children.find((x) => ['element', 'sequence', 'group', 'choice'].includes(x.local));
        if (firstOpt) this.particles({ children: [firstOpt] }, indent, stack);
      } else if (c.local === 'group' && c.attrs.ref) {
        const g = this.idx.groups[key(...Object.values(qname(c.attrs.ref, c)))];
        if (g && !stack.includes(g)) this.particles(g, indent, [...stack, g]);
      } else if (c.local === 'any') this.line(indent, '<!-- any element -->');
    }
  }

  /** Content of a complexType: { attrs, text } plus child lines written at indent. */
  complex(ct, indent, stack) {
    const attrs = this.attributes(ct, stack);
    let text = null;
    for (const c of ct.children) {
      if (['sequence', 'all', 'choice', 'group'].includes(c.local)) this.particles({ children: [c] }, indent, stack);
      else if (c.local === 'complexContent' || c.local === 'simpleContent') {
        const ext = kid(c, 'extension') ?? kid(c, 'restriction');
        if (!ext) continue;
        const base = ext.attrs.base ? qname(ext.attrs.base, ext) : null;
        const baseDef = base && base.ns !== XSD ? this.idx.types[key(base.ns, base.local)] : null;
        if (c.local === 'simpleContent') {
          text = base ? (baseDef?.local === 'complexType' ? '?' : this.typeSample(base, stack)) : '?';
        } else if (ext.local === 'extension' && baseDef?.local === 'complexType' && !stack.includes(baseDef)) {
          const r = this.complex(baseDef, indent, [...stack, baseDef]);
          attrs.unshift(...r.attrs);
        }
        attrs.push(...this.attributes(ext, stack));
        this.particles(ext, indent, stack);
      }
    }
    return { attrs, text };
  }

  /** One xsd:element (a global one when top is true). */
  element(decl, indent, stack, top) {
    let el = decl;
    if (decl.attrs.ref) {
      const r = qname(decl.attrs.ref, decl);
      el = this.idx.elements[key(r.ns, r.local)];
      if (!el) return this.line(indent, `<!-- element ${esc(decl.attrs.ref)} not found in the WSDL types -->`);
      top = true;
    }
    const info = el.schemaInfo ?? { tns: '', qualified: false };
    const qualified = top || el.attrs.form === 'qualified' || (el.attrs.form !== 'unqualified' && info.qualified);
    const tag = qualified && info.tns ? `${this.prefix(info.tns)}:${el.attrs.name}` : el.attrs.name;
    const min = decl.attrs.minOccurs ?? el.attrs.minOccurs;
    const max = decl.attrs.maxOccurs ?? el.attrs.maxOccurs;
    const notes = [min === '0' && 'optional', (max === 'unbounded' || Number(max) > 1) && 'repeatable'].filter(Boolean);
    if (notes.length) this.line(indent, `<!-- ${notes.join(', ')} -->`);
    if (stack.includes(el) || stack.length > 40) return this.line(indent, `<${tag}/><!-- recursive -->`);
    const next = [...stack, el];

    let def = kid(el, 'complexType') ?? kid(el, 'simpleType');
    if (!def && el.attrs.type) {
      const t = qname(el.attrs.type, el);
      if (t.ns === XSD) return this.line(indent, `<${tag}>${esc(builtinSample(t.local))}</${tag}>`);
      def = this.idx.types[key(t.ns, t.local)];
      if (!def) return this.line(indent, `<${tag}>?</${tag}>`);
      if (stack.includes(def)) return this.line(indent, `<${tag}/><!-- recursive -->`);
      next.push(def);
    }
    if (!def) return this.line(indent, `<${tag}>${el.attrs.fixed ?? el.attrs.default ?? '?'}</${tag}>`);
    if (def.local === 'simpleType') return this.line(indent, `<${tag}>${esc(el.attrs.fixed ?? el.attrs.default ?? this.simpleSample(def, next))}</${tag}>`);

    const at = this.lines.length;
    const { attrs, text } = this.complex(def, indent + 1, next);
    const open = `<${tag}${attrs.length ? ` ${attrs.join(' ')}` : ''}`;
    const childLines = this.lines.splice(at);
    if (text != null) this.line(indent, `${open}>${esc(text)}</${tag}>`);
    else if (!childLines.length) this.line(indent, `${open}/>`);
    else {
      this.line(indent, `${open}>`);
      this.lines.push(...childLines);
      this.line(indent, `</${tag}>`);
    }
  }

  /** A part with type= (rpc, or a document part without an element): <partName> unqualified. */
  typedPart(name, typeRef, node, indent, stack) {
    const t = qname(typeRef, node);
    const def = t.ns === XSD ? null : this.idx.types[key(t.ns, t.local)];
    if (def?.local === 'complexType') {
      const at = this.lines.length;
      const { attrs, text } = this.complex(def, indent + 1, [...stack, def]);
      const childLines = this.lines.splice(at);
      const open = `<${name}${attrs.length ? ` ${attrs.join(' ')}` : ''}`;
      if (text != null) this.line(indent, `${open}>${esc(text)}</${name}>`);
      else if (!childLines.length) this.line(indent, `${open}/>`);
      else {
        this.line(indent, `${open}>`);
        this.lines.push(...childLines);
        this.line(indent, `</${name}>`);
      }
    } else this.line(indent, `<${name}>${esc(this.typeSample(t, stack))}</${name}>`);
  }

  envelope(version) {
    const decl = [...this.prefixes].map(([ns, p]) => ` xmlns:${p}="${esc(ns)}"`).join('');
    return [
      `<soap:Envelope xmlns:soap="${SOAP_ENV[version]}"${decl}>`,
      '  <soap:Header/>',
      '  <soap:Body>',
      ...this.lines,
      '  </soap:Body>',
      '</soap:Envelope>',
      '',
    ].join('\n');
  }
}

/**
 * Services → SOAP ports → operations, each with a sample envelope.
 * { services: [ { name, ports: [ { name, address, soapVersion, operations: [ { name, action, style, envelope } ] } ] } ], notes }
 */
export async function describeWsdl(source, opts = {}) {
  const w = await loadWsdl(source, opts);
  const idx = indexOf(w);
  // prefixes the WSDL author picked (tns, etc.) read nicer than ns1
  const preferred = {};
  for (const d of w.defs) for (const n of walk(d)) for (const [p, uri] of Object.entries(n.nsMap)) if (p && !(uri in preferred)) preferred[uri] = p;

  const services = [];
  for (const d of w.defs) {
    for (const svc of kids(d, 'service')) {
      const ports = [];
      for (const port of kids(svc, 'port')) {
        const bq = qname(port.attrs.binding, port);
        const binding = idx.bindings[key(bq.ns, bq.local)];
        const soapBinding = kid(binding, 'binding', SOAP11_WSDL) ?? kid(binding, 'binding', SOAP12_WSDL);
        if (!soapBinding) continue; // HTTP GET/POST bindings etc.
        const soapNs = soapBinding.ns;
        const version = soapNs === SOAP12_WSDL ? '1.2' : '1.1';
        const address = kid(port, 'address', soapNs)?.attrs.location ?? kid(port, 'address')?.attrs.location ?? '';
        const pq = qname(binding.attrs.type, binding);
        const portType = idx.portTypes[key(pq.ns, pq.local)];
        const operations = [];
        for (const bop of kids(binding, 'operation')) {
          const soapOp = kid(bop, 'operation', soapNs);
          const style = soapOp?.attrs.style ?? soapBinding.attrs.style ?? 'document';
          const ptOp = kids(portType, 'operation').find((o) => o.attrs.name === bop.attrs.name);
          const inputRef = kid(ptOp, 'input')?.attrs.message;
          const mq = inputRef ? qname(inputRef, kid(ptOp, 'input')) : null;
          const message = mq ? idx.messages[key(mq.ns, mq.local)] : null;
          const soapBody = kid(kid(bop, 'input'), 'body', soapNs);
          const only = soapBody?.attrs.parts ? new Set(soapBody.attrs.parts.split(/\s+/)) : null;
          const parts = kids(message, 'part').filter((p) => !only || only.has(p.attrs.name));

          const wr = new EnvelopeWriter(idx, preferred);
          if (style === 'rpc') {
            const ns = soapBody?.attrs.namespace ?? d.attrs.targetNamespace ?? '';
            const tag = ns ? `${wr.prefix(ns)}:${bop.attrs.name}` : bop.attrs.name;
            const at = wr.lines.length;
            for (const p of parts) {
              if (p.attrs.element) wr.element({ attrs: { ref: p.attrs.element }, nsMap: p.nsMap, children: [] }, 3, [], true);
              else wr.typedPart(p.attrs.name, p.attrs.type, p, 3, []);
            }
            const inner = wr.lines.splice(at);
            if (inner.length) wr.lines.push(`    <${tag}>`, ...inner, `    </${tag}>`);
            else wr.lines.push(`    <${tag}/>`);
          } else {
            for (const p of parts) {
              if (p.attrs.element) wr.element({ attrs: { ref: p.attrs.element }, nsMap: p.nsMap, children: [] }, 2, [], true);
              else if (p.attrs.type) wr.typedPart(p.attrs.name, p.attrs.type, p, 2, []);
            }
          }
          operations.push({ name: bop.attrs.name, action: soapOp?.attrs.soapAction ?? '', style, envelope: wr.envelope(version) });
        }
        ports.push({ name: port.attrs.name, address, soapVersion: version, operations });
      }
      if (ports.length) services.push({ name: svc.attrs.name, ports });
    }
  }
  if (!services.length) throw new Error('No SOAP service found in the WSDL');
  return { services, notes: w.notes };
}

/** The port an import uses: the first SOAP 1.1 port, else the first port. */
export function preferredPort(services) {
  for (const s of services) for (const p of s.ports) if (p.soapVersion === '1.1') return { service: s, port: p };
  return { service: services[0], port: services[0]?.ports[0] };
}
