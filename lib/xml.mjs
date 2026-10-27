// Small XML helpers on top of fast-xml-parser: a namespace-aware element tree, namespace-agnostic lookups
// ($res.xml / $res.xmlAll) and SOAP Fault detection.
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
});

// fast-xml-parser decodes the named entities; numeric ones (&#3588; / &#xE04;) are left as they are
const decode = (s) =>
  String(s).replace(/&#(x[0-9a-f]+|\d+);/gi, (all, n) => {
    const cp = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : parseInt(n, 10);
    try {
      return String.fromCodePoint(cp);
    } catch {
      return all;
    }
  });

/**
 * Parse XML into { name, local, prefix, ns, attrs, children, text } nodes (the root element is returned).
 * `ns` is the element's namespace URI; `nsMap` (prefix → URI) is what is in scope, for resolving QName attributes.
 */
export function parseXml(text) {
  const raw = parser.parse(String(text ?? ''));
  const build = (item, parentMap) => {
    const name = Object.keys(item).find((k) => k !== ':@');
    if (name === '#text' || name == null) return null;
    const attrs = {};
    const nsMap = { ...parentMap };
    for (const [k, v] of Object.entries(item[':@'] ?? {})) {
      if (k === 'xmlns') nsMap[''] = v;
      else if (k.startsWith('xmlns:')) nsMap[k.slice(6)] = v;
      else attrs[k] = decode(v);
    }
    const i = name.indexOf(':');
    const prefix = i < 0 ? '' : name.slice(0, i);
    const node = { name, local: i < 0 ? name : name.slice(i + 1), prefix, ns: nsMap[prefix] ?? '', nsMap, attrs, children: [], text: '' };
    for (const c of item[name] ?? []) {
      if ('#text' in c) node.text += decode(c['#text']);
      else {
        const child = build(c, nsMap);
        if (child) node.children.push(child);
      }
    }
    return node;
  };
  for (const item of raw) {
    const n = build(item, {});
    if (n) return n;
  }
  return null;
}

/** All text inside an element (its own and its descendants'). */
export const textOf = (node) => (node ? node.text + node.children.map(textOf).join('') : undefined);

/** Depth-first walk over every element. */
export function* walk(node) {
  if (!node) return;
  yield node;
  for (const c of node.children) yield* walk(c);
}

/** `ns:Local` → { ns, local } using the namespaces in scope at `node`. */
export function qname(value, node) {
  const v = String(value ?? '');
  const i = v.indexOf(':');
  const prefix = i < 0 ? '' : v.slice(0, i);
  return { ns: node?.nsMap?.[prefix] ?? '', local: i < 0 ? v : v.slice(i + 1) };
}

const tryParse = (text) => {
  try {
    return parseXml(text);
  } catch {
    return null;
  }
};

/** `$res.xml(name)` / `$res.xmlAll(name)`: elements matched by local name, prefix ignored. Parsed once, on first use. */
export function xmlApi(text) {
  let root;
  const tree = () => (root === undefined ? (root = /^\s*</.test(String(text ?? '')) ? tryParse(text) : null) : root);
  const all = (name) => [...walk(tree())].filter((n) => n.local === String(name).replace(/^.*:/, '')).map((n) => textOf(n).trim());
  return { xml: (name) => all(name)[0], xmlAll: all };
}

const SOAP_ENV = ['http://schemas.xmlsoap.org/soap/envelope/', 'http://www.w3.org/2003/05/soap-envelope'];

/** { code, string } when the text is a SOAP 1.1 / 1.2 envelope whose Body holds a Fault, else null. */
export function soapFault(text) {
  if (!/Fault/.test(String(text ?? ''))) return null;
  const root = tryParse(text);
  if (!root || root.local !== 'Envelope') return null;
  const body = root.children.find((c) => c.local === 'Body');
  const fault = body?.children.find((c) => c.local === 'Fault' && (SOAP_ENV.includes(c.ns) || !c.ns || c.ns === root.ns));
  if (!fault) return null;
  const child = (n, local) => n?.children.find((c) => c.local === local);
  // 1.1: faultcode / faultstring; 1.2: Code/Value (+ Subcode/Value) and Reason/Text
  const code11 = child(fault, 'faultcode');
  if (code11) return { code: textOf(code11).trim(), string: textOf(child(fault, 'faultstring'))?.trim() ?? '' };
  const code = child(fault, 'Code');
  const sub = child(child(code, 'Subcode'), 'Value');
  const value = textOf(child(code, 'Value'))?.trim() ?? '';
  return {
    code: sub ? `${value} / ${textOf(sub).trim()}` : value,
    string: textOf(child(child(fault, 'Reason'), 'Text'))?.trim() ?? '',
  };
}
