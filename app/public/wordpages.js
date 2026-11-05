'use strict';
/**
 * Word's pages and Word's hidden text, read from the strings of a Word file's parts (its main document, its styles, its
 * notes and comments, `docProps/app.xml`, each found as mammoth finds it) by a tag scanner: no DOM, so it runs in the page's document worker
 * (`importScripts`) and under `node --test` (`require`), where it is `AGMWord`.
 *
 * Invariants:
 *   - No part with a document type declaration or an entity declaration is read: `hasDtd` finds one, and every reader
 *     here refuses such a part ('dtd') before it scans it. OOXML parts never need one.
 *   - Hidden text never leaves `stripHidden`: every run (`w:r`) whose run properties carry `w:vanish` or `w:specVanish`
 *     (not `w:val` "0", "false" or "off") is removed, set on the run itself, through its character style (`w:rStyle`), its
 *     paragraph's style (`w:pStyle`, or the default paragraph style where it names none), the style of each table it sits
 *     in (`w:tblStyle`, or the default table style), each style followed through `w:basedOn`, or `w:docDefaults`. A run's
 *     own setting decides; otherwise a hidden mark at any level of its styles hides it. A mark it cannot resolve fails
 *     closed: the whole file is refused ('hidden'), never drawn with what may be hidden text in it. Those marks are a
 *     style it cannot find, a `w:basedOn` chain past MAX_CHAIN links, a table style whose conditional formats
 *     (`w:tblStylePr`) carry one, and a run's or a table's mark read after the run's text began (where it was decided).
 *   - The scanner reads WordprocessingML by the prefix `w`, so a part it reads is held to it (`namespaces`): the
 *     namespace bound to any other prefix, or as the default namespace, refuses the file ('hidden'), since a reader that
 *     resolves namespaces (mammoth's) would read runs this scanner cannot see.
 *   - The parts are the ones mammoth reads (`partsOf`): the main document named by the package's relationships, and its
 *     styles, numbering, footnotes, endnotes and comments named by the main document's, each found exactly as mammoth
 *     finds it, fallbacks included. A relationships part written any way but Office's (unprefixed, in the package
 *     relationships namespace, declaring nothing else) is refused ('shape'): it could name a part one reader finds and
 *     another does not.
 *   - The pages are Word's own: where the file carries Word's rendered page breaks (`w:lastRenderedPageBreak`) a
 *     paragraph's page is 1 + the rendered breaks before it (basis 'word', or 'word-stale' where `<Pages>` disagrees);
 *     otherwise 1 + the explicit breaks before it, which are lower bounds (basis 'breaks'). Only 'word' is exact: the
 *     others, a scan cut short and a block it cannot place are approximate ("≈"). A break before any of a paragraph's
 *     text puts the paragraph on the next page; a break after some of its text makes it span two.
 *   - The page is the document's physical page, counted from 1. A section that restarts its numbering or numbers in
 *     another format is marked (`differs`) from where it starts.
 *   - Pure: nothing is loaded, no global but the language's own is read.
 */
(function (scope) {
  /** How many `w:basedOn` links are followed from a style before its chain is cut. */
  const MAX_CHAIN = 10;
  /** How far ahead of the last placed paragraph a block's text is looked for, and how much of it must begin one. */
  const LOOK_AHEAD = 50;
  const PREFIX = 40;
  /** WordprocessingML's namespaces, transitional and strict: mammoth reads both as `w`. */
  const WML = Object.freeze(['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main']);
  /** The package's relationships namespace, the one mammoth reads a relationships part in. */
  const PACKAGE_RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
  /** A relationship's type: the main document's, and the parts related to it by name (`styles`, `footnotes` …). */
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
  const WORDS = Object.freeze({
    hidden: 'This Word file has hidden text AGMessage could not leave out — show a picture or a quote.',
    differs: 'the printed page numbers differ here',
    approx: 'Word\'s last saved layout is missing or out of date: pages are approximate',
    shape: 'This Word file cannot be read.',
  });

  class Refused extends Error {
    constructor(why) { super(why); this.why = why; }
  }

  /** Whether the part declares a document type or an entity, which no reader here is shown. */
  const hasDtd = (xml) => /<!DOCTYPE|<!ENTITY/i.test(String(xml));

  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' };
  /** XML's five entities and its character references; anything else is left as written. */
  function decode(s) {
    if (s.indexOf('&') < 0) return s;
    return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-z]{2,4});/g, (whole, e) => {
      if (e[0] !== '#') return Object.prototype.hasOwnProperty.call(ENTITIES, e) ? ENTITIES[e] : whole;
      const n = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    });
  }

  /**
   * Each tag and run of text of `xml`, in order, handed to `visit`: {t: 'open'|'close'|'empty', name, attrs, at, end}
   * or {t: 'text', text, at, end}, `at` and `end` the token's offsets. Comments and processing instructions are passed
   * over; a CDATA section is text. A document type declaration, or a tag that does not end, is refused ('dtd', 'shape').
   */
  function walk(xml, visit) {
    const n = xml.length;
    let i = 0;
    while (i < n) {
      const lt = xml.indexOf('<', i);
      if (lt < 0) { visit({ t: 'text', text: decode(xml.slice(i)), at: i, end: n }); break; }
      if (lt > i) visit({ t: 'text', text: decode(xml.slice(i, lt)), at: i, end: lt });
      if (xml.startsWith('<!--', lt)) { const e = xml.indexOf('-->', lt + 4); if (e < 0) throw new Refused('shape'); i = e + 3; continue; }
      if (xml.startsWith('<![CDATA[', lt)) {
        const e = xml.indexOf(']]>', lt + 9);
        if (e < 0) throw new Refused('shape');
        visit({ t: 'text', text: xml.slice(lt + 9, e), at: lt, end: e + 3 });
        i = e + 3;
        continue;
      }
      if (xml.startsWith('<?', lt)) { const e = xml.indexOf('?>', lt + 2); if (e < 0) throw new Refused('shape'); i = e + 2; continue; }
      if (xml[lt + 1] === '!') throw new Refused('dtd');
      let j = lt + 1;
      const closing = xml[j] === '/';
      if (closing) j++;
      const nameAt = j;
      while (j < n && !/[\s/>]/.test(xml[j])) j++;
      const name = xml.slice(nameAt, j);
      if (!name) throw new Refused('shape');
      const attrs = {};
      for (;;) {
        while (j < n && /\s/.test(xml[j])) j++;
        if (j >= n) throw new Refused('shape');
        if (xml[j] === '>') { j++; visit({ t: closing ? 'close' : 'open', name, attrs, at: lt, end: j }); break; }
        if (xml[j] === '/' && xml[j + 1] === '>') { j += 2; visit({ t: 'empty', name, attrs, at: lt, end: j }); break; }
        const keyAt = j;
        while (j < n && !/[\s=/>]/.test(xml[j])) j++;
        const key = xml.slice(keyAt, j);
        while (j < n && /\s/.test(xml[j])) j++;
        if (!key || xml[j] !== '=') throw new Refused('shape');
        j++;
        while (j < n && /\s/.test(xml[j])) j++;
        const q = xml[j];
        if (q !== '"' && q !== '\'') throw new Refused('shape');
        const e = xml.indexOf(q, j + 1);
        if (e < 0) throw new Refused('shape');
        attrs[key] = decode(xml.slice(j + 1, e));
        j = e + 1;
      }
      i = j;
    }
  }

  /** An on/off property's value: absent `w:val` is on; "0", "false" and "off" are off; anything else is on. */
  const onOff = (attrs) => {
    const v = attrs['w:val'];
    return v === undefined || !/^(0|false|off)$/i.test(v);
  };

  /**
   * The styles of `word/styles.xml`: per style id its `w:basedOn`, its run properties' hidden mark and its paragraph
   * properties' `w:pageBreakBefore` (each true, false or undefined where it sets none), the default paragraph and
   * character styles, and `w:docDefaults`' hidden mark. An absent part is no styles.
   */
  function styles(stylesXml) {
    // Each type's default styles: Word writes one; a file naming more has every one read, and any that hides hides.
    const table = { byId: new Map(), defaults: undefined, paragraph: '', character: '', table: '', all: { paragraph: [], character: [], table: [] } };
    if (!stylesXml) return table;
    if (hasDtd(stylesXml)) throw new Refused('dtd');
    const path = [];
    let style = null;
    walk(String(stylesXml), (tk) => {
      if (tk.t === 'close') { path.pop(); if (tk.name === 'w:style') style = null; return; }
      if (tk.t === 'text') return;
      const parent = path[path.length - 1] || '';
      const grand = path[path.length - 2] || '';
      if (tk.name === 'w:style' && (tk.t === 'open' || tk.t === 'empty')) {
        style = { type: tk.attrs['w:type'] || 'paragraph', basedOn: '', hidden: undefined, breakBefore: undefined, conditional: false };
        const id = tk.attrs['w:styleId'] || '';
        // A style id written twice is one whose properties cannot be told: a run it reaches fails closed.
        if (table.byId.has(id)) style.twice = true;
        table.byId.set(id, style);
        if (onOff({ 'w:val': tk.attrs['w:default'] || '0' })) {
          if (style.type === 'paragraph' && !table.paragraph) table.paragraph = id;
          if (style.type === 'character' && !table.character) table.character = id;
          if (style.type === 'table' && !table.table) table.table = id;
          if (Object.prototype.hasOwnProperty.call(table.all, style.type)) table.all[style.type].push(id);
        }
        if (tk.t === 'empty') style = null;   // a style with no properties: known, setting nothing
      } else if (style && tk.name === 'w:basedOn' && parent === 'w:style') style.basedOn = tk.attrs['w:val'] || '';
      else if (style && (tk.name === 'w:vanish' || tk.name === 'w:specVanish') && parent === 'w:rPr' && grand === 'w:style') style.hidden = style.hidden || onOff(tk.attrs);
      // A table style's conditional format (its first row, banded rows …) hiding text: which cells it reaches is the
      // table's look, not read here, so it is a mark this reader cannot resolve.
      else if (style && (tk.name === 'w:vanish' || tk.name === 'w:specVanish') && parent === 'w:rPr' && grand === 'w:tblStylePr') style.conditional = style.conditional || onOff(tk.attrs);
      else if (style && tk.name === 'w:pageBreakBefore' && parent === 'w:pPr' && grand === 'w:style') style.breakBefore = onOff(tk.attrs);
      else if ((tk.name === 'w:vanish' || tk.name === 'w:specVanish') && parent === 'w:rPr' && grand === 'w:rPrDefault') table.defaults = table.defaults || onOff(tk.attrs);
      if (tk.t === 'open') path.push(tk.name);
    });
    return table;
  }

  /**
   * A style's property as its chain sets it: {value, cut}, `value` from the first style of the chain that sets it.
   * A style it cannot find is refused ('missing'); `cut` is true when the chain runs past MAX_CHAIN links.
   */
  function chain(table, id, prop) {
    let at = id;
    for (let links = 0; at; links++) {
      if (links > MAX_CHAIN) return { value: undefined, cut: true };
      const s = table.byId.get(at);
      if (!s || s.twice) throw new Refused('missing');
      if (s[prop] !== undefined) return { value: s[prop], cut: false };
      at = s.basedOn;
    }
    return { value: undefined, cut: false };
  }

  /** Whether a style's chain hides its runs: a chain that cannot be followed is a mark not resolved, and fails closed. */
  function hidesRuns(table, id) {
    if (!id) return false;
    let c;
    try { c = chain(table, id, 'hidden'); } catch (e) { if (e instanceof Refused) throw new Refused('hidden'); throw e; }
    if (c.cut) throw new Refused('hidden');
    return c.value === true;
  }

  /**
   * Whether a table's style hides the runs in its cells: its chain's first hidden mark, as `hidesRuns` reads one; a
   * conditional format's mark anywhere in the chain, a style it cannot find or a chain past MAX_CHAIN links fails closed.
   */
  function tableHides(table, id) {
    if (!id) return false;
    let value;
    for (let at = id, links = 0; at; links++) {
      const s = links > MAX_CHAIN ? null : table.byId.get(at);
      if (!s || s.conditional || s.twice) throw new Refused('hidden');
      if (value === undefined && s.hidden !== undefined) value = s.hidden;
      at = s.basedOn;
    }
    return value === true;
  }

  /** An element's local name: `w:r` → `r`, `mc:Choice` → `Choice`. */
  const localName = (name) => name.slice(name.indexOf(':') + 1);
  /** The markup-compatibility wrappers a reader replaces by one of their branches: a run's properties may sit in one. */
  const WRAPPERS = new Set(['AlternateContent', 'Choice', 'Fallback']);

  /**
   * Reads a body part's paragraphs and runs. `on.open(p)` hears each paragraph as it begins, `on.styled(p)` once its
   * paragraph properties are read (its style, `w:pageBreakBefore`, whether it ends a section), `on.para(p)` as it ends;
   * `on.run(r)` each run as it ends ({at, end, hidden}); `on.token(tk, ctx)` every token, with the innermost open run
   * and paragraph and every open run. A run's hidden mark is decided by its own run properties, its character style, its
   * paragraph's style and `w:docDefaults`, as the head of this file says, once anything but its run properties begins.
   */
  function body(xml, table, on) {
    const path = [];
    const runs = [];     // the runs open now, innermost last
    const paras = [];    // the paragraphs open now, innermost last
    const tables = [];   // the tables open now, innermost last: {depth, style, read}
    /** Whether the run properties at path index `at` are `run`'s own: only wrappers a reader collapses between them. */
    const ownProps = (run, at) => {
      if (!run || path[at] !== 'w:rPr') return false;
      for (let k = run.depth; k < at; k++) if (!WRAPPERS.has(localName(path[k]))) return false;
      return run.depth <= at;
    };
    walk(xml, (tk) => {
      // The element's own parent and grandparent: a closing tag's element is still the top of the path.
      const up = tk.t === 'close' ? 1 : 0;
      const parent = path[path.length - 1 - up] || '';
      const grand = path[path.length - 2 - up] || '';
      const run = runs[runs.length - 1];
      const para = paras[paras.length - 1];
      const inRunProps = (tk.name === 'w:rPr' && parent === 'w:r') || (parent === 'w:rPr' && grand === 'w:r');
      if (run && !run.decided && tk.t !== 'text' && !inRunProps) decide(run);
      const inParaProps = path[para ? para.depth : -1] === 'w:pPr';
      if (para && !para.styled && tk.t !== 'text' && !inParaProps && !(tk.name === 'w:pPr' && parent === 'w:p')) style(para);
      if (tk.t === 'open' || tk.t === 'empty') {
        if (tk.name === 'w:p') {
          const p = { at: tk.at, depth: path.length + 1, pStyle: '', breakDirect: undefined, sect: false, styled: false };
          if (on.open) on.open(p);
          if (tk.t === 'open') paras.push(p);
          else { style(p); p.end = tk.end; if (on.para) on.para(p); }
        } else if (tk.name === 'w:r') {
          const r = { at: tk.at, depth: path.length + 1, direct: undefined, rStyle: '', hidden: false, decided: false, para };
          if (tk.t === 'open') runs.push(r);
          else { decide(r); r.end = tk.end; if (on.run) on.run(r); }
        } else if (tk.name === 'w:tbl') {
          if (tk.t === 'open') tables.push({ depth: path.length + 1, style: '', read: false });
        } else if (tk.name === 'w:tblStyle' && parent === 'w:tblPr' && tables.length && path.length === tables[tables.length - 1].depth + 1) {
          const t = tables[tables.length - 1];
          // A table's style named after a run of it was read could hide what was already judged shown.
          if (t.read) throw new Refused('hidden');
          t.style = tk.attrs['w:val'] || '';
        } else if (para && parent === 'w:pPr' && path.length === para.depth + 1) {
          if (tk.name === 'w:pStyle') para.pStyle = tk.attrs['w:val'] || '';
          else if (tk.name === 'w:pageBreakBefore') para.breakDirect = onOff(tk.attrs);
          else if (tk.name === 'w:sectPr') para.sect = true;
        } else if (ownProps(run, path.length - 1)) {
          if (tk.name === 'w:vanish' || tk.name === 'w:specVanish') {
            // A mark read once the run's text began (its properties after its text, or inside a wrapper) is one this
            // reader judged too late: it fails closed.
            if (run.decided) { if (onOff(tk.attrs)) throw new Refused('hidden'); } else run.direct = run.direct || onOff(tk.attrs);
          } else if (tk.name === 'w:rStyle') {
            if (run.decided) { if (hidesRuns(table, tk.attrs['w:val'] || '')) throw new Refused('hidden'); } else run.rStyle = tk.attrs['w:val'] || '';
          }
        }
      }
      if (on.token) on.token(tk, { run: runs[runs.length - 1], para: paras[paras.length - 1], parent, runs });
      if (tk.t === 'open') path.push(tk.name);
      else if (tk.t === 'close') {
        path.pop();
        if (tk.name === 'w:r' && run) { if (!run.decided) decide(run); run.end = tk.end; runs.pop(); if (on.run) on.run(run); }
        else if (tk.name === 'w:p' && para) { if (!para.styled) style(para); para.end = tk.end; paras.pop(); if (on.para) on.para(para); }
        else if (tk.name === 'w:tbl' && tables.length && path.length === tables[tables.length - 1].depth - 1) tables.pop();
      }
    });
    function decide(r) {
      r.decided = true;
      // Every table the run sits in: its style (or the default table style) may hide it, and is read now.
      let inHidden = false;
      for (const t of tables) {
        t.read = true;
        if (t.style ? tableHides(table, t.style) : table.all.table.some((id) => tableHides(table, id))) inHidden = true;
      }
      if (r.direct !== undefined) { r.hidden = r.direct; return; }
      const pStyle = r.para && r.para.pStyle;
      r.hidden = table.defaults === true || inHidden
        || (r.rStyle ? hidesRuns(table, r.rStyle) : table.all.character.some((id) => hidesRuns(table, id)))
        || (pStyle ? hidesRuns(table, pStyle) : table.all.paragraph.some((id) => hidesRuns(table, id)));
    }
    function style(p) {
      p.styled = true;
      if (on.styled) on.styled(p);
    }
  }

  /**
   * A body part (`word/document.xml`, the footnotes, the endnotes) with every hidden run removed: {ok: true, xml,
   * removed}, or {ok: false, why} ('hidden' where a mark cannot be resolved, 'dtd', 'shape').
   */
  function stripHidden(xml, table) {
    try {
      const text = String(xml);
      if (hasDtd(text)) return { ok: false, why: 'dtd' };
      const cut = [];
      body(text, table || styles(''), { run(r) { if (r.hidden) cut.push([r.at, r.end]); } });
      // A run inside another (a text box's) ends before it, so the outer one, heard last, covers it: keep the outermost.
      cut.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
      const keep = [];
      for (const c of cut) { if (keep.length && c[0] < keep[keep.length - 1][1]) continue; keep.push(c); }
      let out = '', from = 0;
      for (const [a, b] of keep) { out += text.slice(from, a); from = b; }
      out += text.slice(from);
      return { ok: true, xml: out, removed: keep.length };
    } catch (e) {
      if (e instanceof Refused) return { ok: false, why: e.why === 'missing' ? 'hidden' : e.why };
      throw e;
    }
  }

  /**
   * Whether a part binds WordprocessingML only to the prefix `w`, as this scanner reads it: {ok: true}, or {ok: false,
   * why} ('hidden' where the namespace is bound to another prefix or as the default namespace, 'dtd', 'shape').
   */
  function namespaces(xml) {
    try {
      const text = String(xml || '');
      if (hasDtd(text)) return { ok: false, why: 'dtd' };
      let bad = false;
      walk(text, (tk) => {
        if (tk.t !== 'open' && tk.t !== 'empty') return;
        for (const [k, v] of Object.entries(tk.attrs)) {
          if ((k === 'xmlns' || k.startsWith('xmlns:')) && k !== 'xmlns:w' && WML.includes(String(v).trim().toLowerCase())) bad = true;
        }
      });
      return bad ? { ok: false, why: 'hidden' } : { ok: true };
    } catch (e) {
      if (e instanceof Refused) return { ok: false, why: e.why };
      throw e;
    }
  }

  /**
   * A relationships part's relationships, [{type, target}] in order, the root's children named `Relationship`, as
   * mammoth reads them. An absent part has none. A part written any other way than Office writes one (a prefix, a
   * namespace but the package relationships' on the root, a second root) is refused (throws, `why` 'shape'; 'dtd' for a
   * declaration).
   */
  function relationships(xml) {
    const text = String(xml || '');
    if (!text) return [];
    if (hasDtd(text)) throw new Refused('dtd');
    const out = [];
    let depth = 0, roots = 0;
    walk(text, (tk) => {
      if (tk.t === 'text') return;
      if (tk.t === 'close') { depth--; return; }
      if (tk.name.includes(':')) throw new Refused('shape');
      for (const k of Object.keys(tk.attrs)) {
        if (k === 'xmlns' ? depth !== 0 || tk.attrs[k] !== PACKAGE_RELS : k.includes(':')) throw new Refused('shape');
      }
      if (depth === 0 && (++roots > 1 || tk.attrs.xmlns !== PACKAGE_RELS)) throw new Refused('shape');
      if (depth === 1 && tk.name === 'Relationship') out.push({ type: tk.attrs.Type, target: tk.attrs.Target });
      if (tk.t === 'open') depth++;
    });
    return out;
  }

  /** Paths joined as mammoth joins them: empty ones dropped, one beginning with `/` starting again. */
  function joinPath(...paths) {
    let kept = [];
    for (const p of paths) { if (!p) continue; if (p.startsWith('/')) kept = [p]; else kept.push(p); }
    return kept.join('/');
  }
  /** A part's folder ('' at the root) and its name. */
  const splitPath = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? { dir: '', base: p } : { dir: p.slice(0, i), base: p.slice(i + 1) }; };

  /**
   * The parts mammoth reads of a Word file, found as it finds them: {main, styles, numbering, footnotes, endnotes,
   * comments, app}. The main document is the first target of the package's officeDocument relationship that the
   * archive holds, else `word/document.xml`; each other part the first target of its type among the main document's
   * relationships, from the main document's folder, else `word/<name>.xml`; the extended properties (`<Pages>`) the
   * package's own, else `docProps/app.xml`. `has(name)` says whether the archive holds a file of that name, `read(name)`
   * its text. A file with no main document is refused (throws, `why` 'shape'), as mammoth refuses it.
   */
  async function partsOf(has, read) {
    const find = (rels, type, base, fallback) => {
      for (const r of rels) {
        if (r.type !== type) continue;
        const joined = joinPath(base, r.target);
        const name = joined.startsWith('/') ? joined.slice(1) : joined;
        if (has(name)) return name;
      }
      return fallback;
    };
    const pkg = relationships(await read('_rels/.rels'));
    const main = find(pkg, REL + 'officeDocument', '', 'word/document.xml');
    if (!has(main)) throw new Refused('shape');
    const { dir, base } = splitPath(main);
    const own = relationships(await read(joinPath(dir, '_rels', base + '.rels')));
    const related = (name) => find(own, REL + name, dir, 'word/' + name + '.xml');
    return { main, styles: related('styles'), numbering: related('numbering'), footnotes: related('footnotes'), endnotes: related('endnotes'), comments: related('comments'), app: find(pkg, REL + 'extended-properties', '', 'docProps/app.xml') };
  }

  /** A paragraph's text as the blocks drawn from it read: whitespace collapsed, trimmed. */
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  /**
   * The sections of `word/document.xml` in order: each `w:sectPr`'s type ('nextPage' where it names none) and whether
   * its page numbers restart (`w:pgNumType w:start`) or take another format (`w:fmt` other than decimal).
   */
  function sections(xml) {
    const out = [];
    let cur = null;
    const path = [];
    walk(xml, (tk) => {
      if (tk.t === 'text') return;
      if (tk.t === 'close') { path.pop(); if (tk.name === 'w:sectPr') { out.push(cur); cur = null; } return; }
      if (tk.name === 'w:sectPr') {
        const s = { type: 'nextPage', start: undefined, fmt: '' };
        if (tk.t === 'empty') out.push(s); else cur = s;
      } else if (cur && path[path.length - 1] === 'w:sectPr') {
        if (tk.name === 'w:type') cur.type = tk.attrs['w:val'] || 'nextPage';
        else if (tk.name === 'w:pgNumType') {
          if (tk.attrs['w:start'] !== undefined) cur.start = Number(tk.attrs['w:start']);
          if (tk.attrs['w:fmt']) cur.fmt = tk.attrs['w:fmt'];
        }
      }
      if (tk.t === 'open') path.push(tk.name);
    });
    return out;
  }

  /** `docProps/app.xml`'s `<Pages>`, or undefined. */
  function pagesOf(appXml) {
    if (!appXml) return undefined;
    const m = /Pages>([^<]{0,32})</.exec(String(appXml));
    const n = m ? m[1].trim() : '';
    return /^\d{1,7}$/.test(n) ? Number(n) : undefined;
  }

  /**
   * Word's pages of a document: {ok: true, basis, pages, approx, cut, paras}, each paragraph (in the order it ends, at
   * any depth: table cells and text boxes too) {text, page, last, differs}, `last` the page it ends on; or {ok: false,
   * why} ('dtd', 'hidden', 'shape'). `parts` is {document, styles, app}, each a part's text or absent.
   */
  function scan(parts) {
    try {
      const doc = String((parts && parts.document) || '');
      for (const k of ['document', 'styles', 'app']) if (parts && parts[k] && hasDtd(parts[k])) return { ok: false, why: 'dtd' };
      const table = styles(parts && parts.styles);
      const sects = sections(doc);
      let rendered = 0, explicit = 0, section = 0, cut = false, differs = false;
      const out = [];
      // Entering a section: its numbering differs from the physical page from where it restarts or changes format.
      const enter = (k) => {
        const s = sects[k];
        const physical = 1 + (rendered > 0 ? rendered : explicit);
        if (s && ((s.start !== undefined && s.start !== physical) || (s.fmt && s.fmt !== 'decimal'))) differs = true;
      };
      enter(0);
      body(doc, table, {
        open(p) { p.rec = { text: '', any: false, r0: rendered, e0: explicit }; },
        styled(p) {
          let before = p.breakDirect;
          const id = p.pStyle || table.paragraph;
          if (before === undefined && id) {
            try {
              const c = chain(table, id, 'breakBefore');
              if (c.cut) cut = true;
              before = c.value;
            } catch (e) { if (!(e instanceof Refused)) throw e; cut = true; }
          }
          if (before && out.length > 0) explicit++;
          p.rec.r0 = rendered;
          p.rec.e0 = explicit;
        },
        token(tk, ctx) {
          const o = ctx.para && ctx.para.rec;
          if (!o || tk.t === 'close' || ctx.runs.some((r) => r.decided && r.hidden)) return;
          if (tk.t === 'text') {
            if (ctx.parent === 'w:t' && tk.text) { o.text += tk.text; if (/\S/.test(tk.text)) o.any = true; }
            return;
          }
          if (tk.name === 'w:tab' || tk.name === 'w:cr') o.text += ' ';
          else if (tk.name === 'w:lastRenderedPageBreak') { rendered++; if (!o.any) o.r0 = rendered; }
          else if (tk.name === 'w:br') {
            o.text += ' ';
            if (tk.attrs['w:type'] === 'page') { explicit++; if (!o.any) o.e0 = explicit; }
          }
        },
        para(p) {
          const o = p.rec;
          out.push({ text: norm(o.text), r0: o.r0, r1: rendered, e0: o.e0, e1: explicit, differs });
          if (p.sect) {
            section++;
            const next = sects[section];
            if (next && /^(nextPage|oddPage|evenPage)$/.test(next.type)) explicit++;
            enter(section);
          }
        },
      });
      const word = rendered > 0;
      const declared = pagesOf(parts && parts.app);
      const basis = !word ? 'breaks' : declared !== undefined && declared !== rendered + 1 ? 'word-stale' : 'word';
      const paras = out.map((p) => ({ text: p.text, page: 1 + (word ? p.r0 : p.e0), last: 1 + (word ? p.r1 : p.e1), differs: p.differs }));
      const pages = 1 + (word ? rendered : explicit);
      return { ok: true, basis, pages, approx: basis !== 'word' || cut, cut, paras };
    } catch (e) {
      if (e instanceof Refused) return { ok: false, why: e.why === 'missing' ? 'hidden' : e.why };
      throw e;
    }
  }

  /**
   * The page of each of `texts` (the drawn blocks' texts, in order) by the scan: {page, approx, differs} each. A text
   * is placed on the next paragraph of the scan, at most LOOK_AHEAD ahead, whose text equals it or begins with its first
   * PREFIX characters; empty paragraphs are passed over. A text with none, or empty, takes the page of the one before
   * it, approximate where it was not placed.
   */
  function place(texts, sc) {
    const paras = sc && sc.ok ? sc.paras.filter((p) => p.text) : [];
    let cursor = 0;
    let prev = { page: 1, approx: !sc || !sc.ok || sc.approx, differs: false };
    return texts.map((raw) => {
      const t = norm(raw);
      if (!t) return { ...prev };
      const head = t.slice(0, PREFIX);
      for (let k = cursor; k < Math.min(paras.length, cursor + LOOK_AHEAD); k++) {
        const p = paras[k];
        if (p.text === t || p.text.startsWith(head)) {
          cursor = k + 1;
          prev = { page: p.page, approx: sc.approx, differs: p.differs };
          return { ...prev };
        }
      }
      prev = { page: prev.page, approx: true, differs: prev.differs };
      return { ...prev };
    });
  }

  const api = Object.freeze({ MAX_CHAIN, WORDS, WML, hasDtd, walk, styles, stripHidden, namespaces, relationships, partsOf, scan, place, norm });
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else scope.AGMWord = api;
})(globalThis);
