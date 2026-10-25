'use strict';
/**
 * The halls board (pure, tested): what a project manager or a tech sees of every hall they may see — its countdown, who
 * is in, its last message, its open help requests and its displays — and the help requests themselves.
 *
 * A help request is a message of its own type: a category from a short list and a few words ("Sound — radio mic 3
 * dead"). It is open until someone says they are on the way, and stays on the board until someone marks it resolved:
 * who did each, and when, rides on the message, so the board, the hall and the transcript tell the same story.
 */

const HELP_CATEGORIES = Object.freeze(['Sound', 'Vision', 'Lighting', 'Stage', 'Presenter', 'IT / network', 'Other']);
const HELP_STATES = Object.freeze(['open', 'coming', 'resolved']);

/** A help message from a person's payload, or null (pure). */
function helpMessage(base, payload, cleanText) {
  const category = HELP_CATEGORIES.includes(payload.category) ? payload.category : 'Other';
  const text = cleanText(payload.text, 300);
  return { ...base, type: 'help', priority: true, category, text, help: { state: 'open', by: '', at: base.at } };
}

/** The words a message reads as in one line on the board (never more than 120 characters). */
function lineOf(m) {
  if (!m) return '';
  const cut = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (m.type === 'text') return cut(m.text);
  if (m.type === 'file') return cut('📄 ' + (m.filename || 'a file') + (m.caption ? ' — ' + m.caption : ''));
  if (m.type === 'action') return cut('❓ ' + m.text);
  if (m.type === 'help') return cut('Help: ' + m.category + (m.text ? ' — ' + m.text : ''));
  return '';
}

/** The newest message a person sent (system lines and presence are not news). */
function lastMessage(room) {
  for (let i = room.messages.length - 1; i >= 0; i--) {
    const m = room.messages[i];
    if (m && m.type !== 'system' && m.from) return { name: String(m.from.name || '').slice(0, 40), text: lineOf(m), at: m.at };
  }
  return null;
}

/** Help requests not yet resolved, oldest first. */
function openHelp(room) {
  return room.messages.filter((m) => m && m.type === 'help' && m.help && m.help.state !== 'resolved').map((m) => ({
    code: room.code, hallName: room.name || room.code, id: m.id, category: m.category, text: m.text || '',
    from: (m.from && m.from.name) || '', at: m.at, state: m.help.state, by: m.help.by || '',
  }));
}

/** How many people are in a hall: people, not sockets (an account with it open on a laptop and a phone is one). */
const peopleIn = (room) => (room.users ? new Set(Array.from(room.users.values(), (u) => u.uid)).size : 0);

/** One hall's row on the board. `stage` is the hall's Stagewatch as a page shows it (or null); `displays` its screens. */
function hallRow(room, { stage = null, displays = [], now = Date.now() } = {}) {
  return {
    code: room.code, name: room.name || '', people: peopleIn(room),
    last: lastMessage(room), help: openHelp(room).length, stage, displays, at: now,
  };
}

module.exports = { HELP_CATEGORIES, HELP_STATES, helpMessage, lineOf, lastMessage, openHelp, peopleIn, hallRow };
