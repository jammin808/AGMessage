'use strict';
/**
 * Lines in Stagewatch's own grammar, for the show desk (Show Bus 1.2 §11) — built here and nowhere else (pure, tested).
 *
 * The research team or a hall's crew sends a message to Stagewatch and says where it should go; the show caller
 * approves it in Stagewatch's Copilot and Stagewatch runs it:
 *
 *   speaker       message "<text>" <info|warn|crit> off ack     the speaker's confidence monitor, under the countdown,
 *                                                                with "Got it" for the speaker
 *   moderator     signal message moderator "<text>"             a role screen (/moderator, /backstage, /interpreter)
 *   backstage     signal message backstage "<text>"
 *   interpreter   signal message interpreter "<text>"
 *   dept:<Name>   signal message "<Name>" "<text>"              a department's crew page (Lighting, Sound…)
 *   operator      note "<text>"                                 only to the operator: shown in Copilot, logged in the
 *                                                                show report when approved; they decide where it goes
 *
 * Stagewatch's tokenizer (McpEndpoint.Tokenize) toggles on a double quote and has no escape, so a double quote inside
 * the text becomes a single one; line breaks become spaces. Its parser takes `message <text> [urgency] [flash] [ack]` with
 * the flash in third place: an "ack" there is refused ("flash must be off|slow|fast") — the `off` before `ack` is what
 * makes the line run. `parse()` below is that grammar, kept as the oracle the tests hold every line to.
 *
 * Stagewatch counts and cuts in UTF-16 units (C# strings): every limit here is in those units, and a cut is made at the
 * last code-point boundary within it, so no line carries half an emoji; a lone surrogate becomes U+FFFD, so every line
 * can be put in a URL. Stagewatch reads `{…}` in a message as its own placeholder ({TIME}, {REMAINING}…, filled in on
 * every frame): the words a line carries have `(` and `)` for `{` and `}`, so the speaker reads what was typed.
 *
 * The line a push carries to the speaker's screen is built from the stored take by `flatten`, the core the hall page shows
 * it with (public/linecore.js): a quote's words in one line with its marked labels, or a document's or a picture's note.
 */
const { flatten, one: oneLine } = require('../public/linecore.js');

const ROLES = ['moderator', 'backstage', 'interpreter'];
const URGENCY = Object.freeze({ info: 'info', warn: 'warn', crit: 'crit', urgent: 'crit', warning: 'warn' });
const MESSAGE_MAX = 500;   // Stagewatch cuts a message at 500
const SIGNAL_MAX = 200;    // …and a signal's body at 200
const NOTE_MAX = 300;      // …and a note at 300
const LINE_MAX = 400;      // Stagewatch's show desk keeps 400 characters of a proposed line (ProposalDesk.MaxLine)
const DEPT_MAX = 32;       // …and a signal's target at 32 (SignalBoard.NormaliseTarget)
// Stagewatch's own targets (SignalBoard.NormaliseTarget): a cue to one of these is not a department.
const SW_ROLES = new Set(['speaker', 'moderator', 'backstage', 'chair', 'interpreter', '*']);

const quote = (t) => '"' + String(t).replace(/"/g, '\'') + '"';
const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;
/** At most `max` UTF-16 units of `s`, cut at the last code-point boundary within them, every surrogate paired. */
function cut(s, max) {
  let end = Math.min(s.length, Math.max(0, max));
  if (end < s.length && end > 0 && isHigh(s.charCodeAt(end - 1)) && isLow(s.charCodeAt(end))) end--;
  return s.slice(0, end).toWellFormed();
}
// Whitespace as one space, and no other control character: Stagewatch drops those from a line it keeps (ProposalDesk's
// Str), so the line AGMessage proposes is the line the desk holds, word for word.
const clean = (t, max) => cut(String(t || '').replace(/[\r\n\t\v\f]+/g, ' ').replace(/\p{Cc}/gu, '').replace(/\s+/g, ' ').trim(), max);
/** The words a line carries: cleaned and cut, with `(` `)` for `{` `}` (one unit each, so the cut stands). */
const words = (t, max) => clean(t, max).replace(/\{/g, '(').replace(/\}/g, ')');

// char.ToUpperInvariant: one UTF-16 unit for one, by Unicode's simple mapping. A letter whose capital is two letters
// (ß, ŉ, ﬁ) stays as it is; a Greek small letter with ypogegrammeni takes its one-letter capital (ᾳ → ᾼ, ᾀ → ᾈ); a
// surrogate is left alone.
const YPO = Object.freeze({ 0x1fb3: 0x1fbc, 0x1fc3: 0x1fcc, 0x1ff3: 0x1ffc });
function upperUnit(c) {
  const n = c.charCodeAt(0);
  if (n >= 0x1f80 && n <= 0x1faf && (n & 0xf) < 8) return String.fromCharCode(n + 8);
  if (Object.hasOwn(YPO, n)) return String.fromCharCode(YPO[n]);
  const u = c.toUpperCase();
  return u.length === 1 ? u : c;
}
/**
 * A department named as Stagewatch names a signal's target (SignalBoard.NormaliseTarget): no control characters (the desk
 * drops them from a line it keeps), trimmed, cut at 32 UTF-16 units on a code point, trimmed again (Stagewatch trims what
 * it is sent) and its first unit capitalised, its spaces otherwise as given — so the line names the department Stagewatch
 * keeps, and what AGMessage says it went to is what Stagewatch shows.
 */
function department(t) {
  const name = cut(String(t || '').replace(/\p{Cc}/gu, '').trim(), DEPT_MAX).trimEnd();
  return name ? upperUnit(name[0]) + name.slice(1) : '';
}
/** Stagewatch's own role targets are no department, by the name Stagewatch would make of the label. */
const isRole = (name) => SW_ROLES.has(name.toLowerCase());

/** Where a message can go, for a Stagewatch whose context lists these departments (pure). */
function destinations(departments = []) {
  const out = [
    { id: 'speaker', label: 'The speaker\'s screen (under the countdown)', direct: true },
    { id: 'moderator', label: 'Moderator screen' },
    { id: 'backstage', label: 'Backstage / green room' },
    { id: 'interpreter', label: 'Interpreter booth' },
  ];
  for (const d of departments.slice(0, 20)) out.push({ id: 'dept:' + d, label: d + ' (department)' });
  out.push({ id: 'operator', label: 'Only the operator (they decide)' });
  return out;
}

/**
 * The departments a Stagewatch's context names. Stagewatch lists each target by its newest cue: kind "department" while
 * that is a standby or a GO, "cue" once it is a message (as AGMessage's own) — both are the department, by its label;
 * its role targets (speaker, moderator…) are not.
 */
function departmentsOf(context) {
  const items = context && Array.isArray(context.items) ? context.items : [];
  const names = items.filter((i) => i && typeof i.label === 'string'
    && (i.kind === 'department' || (i.kind === 'cue' && typeof i.id === 'string' && i.id.startsWith('cue:'))))
    .map((i) => department(i.label)).filter((name) => name && !isRole(name));
  return Array.from(new Set(names));
}

/** Stagewatch's urgency for the word given: info / warn / crit (absent is info), or '' for any other word, never defaulted. */
function urgencyOf(urgency) {
  if (urgency === undefined || urgency === null || urgency === '') return 'info';
  return typeof urgency === 'string' && Object.hasOwn(URGENCY, urgency) ? URGENCY[urgency] : '';
}

/**
 * The line for a destination: {line, words} — or {error}. `urgency` is info / warn / crit (the speaker's screen colours
 * it; the role and department pages carry the words alone); an unknown one is refused, never defaulted. Every line fits
 * the 400 characters the desk keeps, so none loses its urgency or its "Got it" when it is stored.
 */
function lineFor(destination, text, urgency = 'info') {
  const u = urgencyOf(urgency);
  if (!u) return { error: 'Unknown urgency.' };
  const built = build(String(destination || 'speaker'), text, u);
  if (built.line && built.line.length > LINE_MAX) {
    // The room left is counted as Stagewatch counts it, in UTF-16 units: a character beyond them (an emoji) takes two.
    const room = LINE_MAX - (built.line.length - built.text.length);
    return { error: 'Asked of the show desk, this is at most ' + room + ' characters (' + (/[\uD800-\uDBFF]/.test(built.text) ? 'an emoji counts two; ' : '') + 'Stagewatch keeps ' + LINE_MAX + ' of a line) — shorten it' + (destination === 'speaker' || !destination ? ', or use Send now' : '') + '.' };
  }
  return built.line ? { line: built.line, words: built.words } : built;
}
function build(dest, text, u) {
  if (dest === 'speaker') {
    const t = words(text, MESSAGE_MAX);
    if (!t) return { error: 'Nothing to send.' };
    return { line: 'message ' + quote(t) + ' ' + u + ' off ack', words: 'the speaker\'s screen', text: t };
  }
  if (ROLES.includes(dest)) {
    const t = words(text, SIGNAL_MAX);
    if (!t) return { error: 'Nothing to send.' };
    return { line: 'signal message ' + dest + ' ' + quote(t), words: 'the ' + dest + ' screen', text: t };
  }
  if (dest.startsWith('dept:')) {
    const name = department(dest.slice(5));
    const t = words(text, SIGNAL_MAX);
    if (!name || isRole(name) || !t) return { error: 'Choose a department and type the message.' };
    return { line: 'signal message ' + quote(name) + ' ' + quote(t), words: name, text: t };
  }
  if (dest === 'operator') {
    const t = words(text, NOTE_MAX);
    if (!t) return { error: 'Nothing to send.' };
    return { line: 'note ' + quote(t), words: 'the operator', text: t };
  }
  return { error: 'Unknown destination.' };
}

// ---------------------------------------------------------------- the oracle: Stagewatch's grammar for these verbs

/** McpEndpoint.Tokenize: whitespace splits, a double quote toggles quoting, no escapes. */
function tokenize(line) {
  const out = [];
  let cur = '', quoted = false;
  for (const ch of String(line)) {
    if (ch === '"') { quoted = !quoted; continue; }
    if (!quoted && /\s/.test(ch)) { if (cur) { out.push(cur); cur = ''; } continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** ShowCommandParser for message / signal / note: {verb, …} or {error} in Stagewatch's own words. */
function parse(line) {
  const [verb, ...args] = tokenize(line);
  const arg = (i) => (args[i] === undefined ? '' : args[i]);
  switch ((verb || '').toLowerCase()) {
    case 'message': case 'msg': {
      const urgency = args.length > 1 ? arg(1).toLowerCase() : '';
      if (!['', 'info', 'warn', 'warning', 'crit', 'critical'].includes(urgency)) return { error: 'urgency must be info|warn|crit' };
      const flash = args.length > 2 ? arg(2).toLowerCase() : '';
      if (!['', 'off', 'slow', 'fast'].includes(flash)) return { error: 'flash must be off|slow|fast' };
      return { verb: 'message', text: arg(0).slice(0, 500), urgency: urgency || 'info', flash: flash || 'off', ack: args.slice(3).some((x) => x.trim().toLowerCase() === 'ack') };
    }
    case 'signal': case 'cue': {
      const kinds = { message: 'message', msg: 'message', standby: 'standby', sb: 'standby', go: 'go', call: 'call', nudge: 'nudge', haptic: 'nudge', buzz: 'nudge' };
      const kind = kinds[arg(0).toLowerCase()];
      if (!kind) return { error: 'signal takes message|standby|go|call|nudge|clear|resend' };
      return { verb: 'signal', kind, target: arg(1) || 'speaker', text: arg(2).slice(0, 200), ack: !args.slice(3).some((x) => x.trim().toLowerCase() === 'noack') };
    }
    case 'note': case 'log': return { verb: 'note', text: arg(0).slice(0, 300) };
    default: return { error: 'unknown command' };
  }
}

module.exports = { destinations, departmentsOf, lineFor, urgencyOf, tokenize, parse, clean, words, cut, department, flatten, oneLine, ROLES, LINE_MAX, MESSAGE_MAX };
