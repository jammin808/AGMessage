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
 */

const ROLES = ['moderator', 'backstage', 'interpreter'];
const URGENCY = { info: 'info', warn: 'warn', crit: 'crit', urgent: 'crit', warning: 'warn' };
const MESSAGE_MAX = 500;   // Stagewatch cuts a message at 500
const SIGNAL_MAX = 200;    // …and a signal's body at 200
const NOTE_MAX = 300;      // …and a note at 300

const quote = (t) => '"' + String(t).replace(/"/g, '\'') + '"';
const clean = (t, max) => String(t || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

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

/** The departments a Stagewatch's context names (its items of kind "department"). */
function departmentsOf(context) {
  const items = context && Array.isArray(context.items) ? context.items : [];
  const names = items.filter((i) => i && i.kind === 'department' && typeof i.label === 'string').map((i) => clean(i.label, 40)).filter(Boolean);
  return Array.from(new Set(names));
}

/**
 * The line for a destination: {line, words} — or {error}. `urgency` is info / warn / crit (the speaker's screen colours
 * it; the role and department pages carry the words alone).
 */
function lineFor(destination, text, urgency = 'info') {
  const dest = String(destination || 'speaker');
  if (dest === 'speaker') {
    const t = clean(text, MESSAGE_MAX);
    if (!t) return { error: 'Nothing to send.' };
    return { line: 'message ' + quote(t) + ' ' + (URGENCY[urgency] || 'info') + ' off ack', words: 'the speaker\'s screen' };
  }
  if (ROLES.includes(dest)) {
    const t = clean(text, SIGNAL_MAX);
    if (!t) return { error: 'Nothing to send.' };
    return { line: 'signal message ' + dest + ' ' + quote(t), words: 'the ' + dest + ' screen' };
  }
  if (dest.startsWith('dept:')) {
    const name = clean(dest.slice(5), 40);
    const t = clean(text, SIGNAL_MAX);
    if (!name || !t) return { error: 'Choose a department and type the message.' };
    return { line: 'signal message ' + quote(name) + ' ' + quote(t), words: name };
  }
  if (dest === 'operator') {
    const t = clean(text, NOTE_MAX);
    if (!t) return { error: 'Nothing to send.' };
    return { line: 'note ' + quote(t), words: 'the operator' };
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

module.exports = { destinations, departmentsOf, lineFor, tokenize, parse, ROLES };
