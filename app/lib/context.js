'use strict';
/**
 * AGMessage's context for the show network (Show Bus 1.1 §6): what an AI on another node — or Patterns' Eye — needs
 * to understand this node, computed from facts with rules (no model), the same with or without AI.
 *
 * Privacy rule: no message text, no document names, no people's names, no room names or codes. Counts, roles, the
 * links' state and the open action prompts' questions (the board is asked them on stage) — nothing else.
 */

const LIGHTS = ['grey', 'green', 'amber', 'red'];
const worst = (lights) => lights.reduce((w, l) => (LIGHTS.indexOf(l) > LIGHTS.indexOf(w) ? l : w), 'green');
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many || one + 's');

/**
 * @param {object} f facts gathered by the server
 * @param {{id:string,name:string}} f.node
 * @param {Array<{users:Map, messages:Array}>} f.rooms
 * @param {{status:string, view:object|null, clock:object|null, context:object|null}} f.stage
 * @param {Array} f.peers Discovery.list()
 * @param {boolean} f.aiOn
 * @param {boolean} f.tunnel
 * @param {number} [f.help] open help requests across the halls (a count)
 * @param {Object<string,{light:string,headline:string}>} [f.peerContexts] linked Patterns / PlayMap nodes' own light and headline
 * @param {Array<{status:string, view:object|null, context:object|null}>} [f.halls] halls' own Stagewatch links
 * @param {Array<{at:number,text:string}>} f.recent role-level events, no content
 * @param {number} [f.now]
 */
function buildContext(f) {
  const now = f.now || Date.now();
  const items = [];
  const links = [];

  // People, by role (never by name).
  const roles = { board: 0, research: 0, observer: 0 };
  let open = [];
  let answeredCount = 0;
  let rooms = 0;
  for (const r of f.rooms || []) {
    rooms++;
    for (const u of r.users ? r.users.values() : []) if (u && roles[u.role] !== undefined) roles[u.role]++;
    for (const m of r.messages || []) {
      if (!m || m.type !== 'action') continue;
      // A prompt is open until someone on stage answers it; answered ones are only counted.
      if (Array.isArray(m.responses) && m.responses.length) { answeredCount++; continue; }
      open.push({ question: String(m.text || '').replace(/\s+/g, ' ').slice(0, 80), at: m.at || 0 });
    }
  }
  open = open.sort((a, b) => b.at - a.at).slice(0, 5);
  const people = roles.board + roles.research + roles.observer;
  items.push({
    id: 'meetings', kind: 'room', label: 'Meetings',
    light: rooms === 0 ? 'grey' : 'green',
    state: rooms === 0 ? 'no meeting open' : plural(rooms, 'meeting') + ' · ' + plural(people, 'person', 'people') + ' (' + roles.board + ' board, ' + roles.research + ' research, ' + roles.observer + ' observer)',
  });
  for (const [i, p] of open.entries()) {
    items.push({ id: 'prompt:' + (i + 1), kind: 'prompt', label: 'Action prompt', light: 'amber', state: 'waiting for the board: ' + p.question });
    links.push({ from: 'meetings', to: 'prompt:' + (i + 1), kind: 'sends', light: 'amber' });
  }

  // The Stagewatch link.
  const st = f.stage || {};
  const stLight = st.status === 'connected' ? 'green' : st.status === 'off' || !st.status ? 'grey' : st.status === 'stale' || st.status === 'reconnecting' || st.status === 'connecting' ? 'amber' : 'red';
  const clock = st.clock;
  let stState = st.status === 'off' || !st.status ? 'not linked' : st.status;
  if (st.status === 'connected' && st.view) stState = 'timer ' + (st.view.text || '—') + (st.view.title ? ' · ' + st.view.title : '');
  if (clock && clock.apart) stState += ' · CLOCKS APART (' + Math.round(clock.offsetMs / 100) / 10 + ' s)';
  items.push({ id: 'link:stagewatch', kind: 'link', label: 'Stagewatch (stage timer)', light: clock && clock.apart && stLight === 'green' ? 'amber' : stLight, state: stState });
  links.push({ from: 'meetings', to: 'link:stagewatch', kind: 'sends', light: stLight });

  // Help requests open across the halls: a count, never who asked or what for.
  if (f.help) items.push({ id: 'help', kind: 'room', label: 'Help requests', light: 'red', state: plural(f.help, 'help request') + ' open' });
  // Halls with a Stagewatch of their own: each link's state, by the Stagewatch's own name (never a hall's).
  for (const [i, h] of (f.halls || []).entries()) {
    const ok = h.status === 'connected';
    const name = h.context && h.context.node && typeof h.context.node.name === 'string' ? h.context.node.name.slice(0, 60) : 'a hall\'s';
    items.push({ id: 'link:stagewatch:' + (i + 2), kind: 'link', label: 'Stagewatch ' + name, light: ok ? 'green' : h.status === 'off' ? 'grey' : 'amber', state: ok && h.view ? 'timer ' + (h.view.text || '—') : h.status || 'off' });
    links.push({ from: 'meetings', to: 'link:stagewatch:' + (i + 2), kind: 'sends', light: ok ? 'green' : 'amber' });
  }
  items.push({ id: 'ai', kind: 'assistant', label: 'AI drafts', light: f.aiOn ? 'green' : 'grey', state: f.aiOn ? 'on (drafts only, a person sends)' : 'off — everything else works offline' });
  items.push({ id: 'tunnel', kind: 'link', label: 'Remote access (Cloudflare)', light: f.tunnel ? 'green' : 'grey', state: f.tunnel ? 'on' : 'off (venue network only)' });

  // Peers, one hop: what each says about itself (Stagewatch's own context when we hold it).
  const peers = (f.peers || []).map((p) => {
    const fromCtx = st.context && st.context.node && st.context.node.id === p.id ? st.context
      : f.peerContexts && f.peerContexts[p.id] ? f.peerContexts[p.id] : null;   // a linked Patterns or PlayMap's own words
    return {
      t: p.t, id: p.id, name: p.name,
      light: p.status === 'live' ? (fromCtx && LIGHTS.includes(fromCtx.light) ? fromCtx.light : 'green') : 'amber',
      headline: fromCtx && typeof fromCtx.headline === 'string' ? fromCtx.headline.slice(0, 160) : (p.status === 'live' ? 'heard' : 'not heard for ' + p.age + ' s'),
    };
  });

  const light = worst(items.filter((i) => i.light !== 'grey').map((i) => i.light).concat(['green']));
  const parts = [rooms ? plural(rooms, 'meeting') + ', ' + plural(people, 'person', 'people') : 'no meeting open'];
  if (f.help) parts.push(plural(f.help, 'help request') + ' open');
  if (open.length) parts.push(plural(open.length, 'action prompt') + ' waiting for the board');
  else if (answeredCount) parts.push(plural(answeredCount, 'action prompt') + ' answered');
  parts.push('Stagewatch ' + (st.status === 'connected' ? 'linked' : stState));
  if (clock && clock.apart) parts.push('CLOCKS APART');

  return {
    v: 1,
    node: { t: 'messenger', id: f.node.id, name: f.node.name },
    at: now,
    light,
    headline: parts.join(' · '),
    items,
    links,
    recent: (f.recent || []).slice(-20).map((r) => ({ at: r.at, text: String(r.text).slice(0, 160) })),
    // What another app may propose (through the show desk — a person approves): a notice to every open meeting.
    commands: [{ verb: 'notice <text>', risk: 'review', words: 'Show a notice to everyone in every open meeting' }],
    peers,
  };
}

/** The show network in words, for the AI's brief (facts are evidence; unknown stays unknown). */
function showBrief(stage, peers) {
  const lines = [];
  const ctx = stage && stage.context;
  if (stage && stage.status === 'connected' && stage.view) {
    const v = stage.view;
    lines.push(`Stage timer (Stagewatch, live): ${v.title || '(no title)'} — ${v.text || ''}${v.next ? '; next: ' + v.next : ''}${v.message ? '; on the speaker screen: "' + v.message + '"' + (v.messageAck ? ' (' + v.messageAck + ')' : '') : ''}${v.playout ? '; video "' + v.playout.title + '" ' + (v.playout.remaining ?? '?') + ' s left' : ''}`);
  } else if (stage && stage.status && stage.status !== 'off') {
    lines.push('Stage timer: Stagewatch link is ' + stage.status + ' — its last values may be out of date.');
  }
  if (ctx) {
    lines.push(`Stagewatch says: ${ctx.headline || ''} [${ctx.light || 'grey'}]`);
    for (const p of (ctx.peers || []).slice(0, 6)) lines.push(`  peer ${p.t} "${p.name || ''}": ${p.headline || ''} [${p.light || 'grey'}]`);
  }
  const linked = new Map(((stage && stage.linked) || []).map((l) => [l.id, l]));
  for (const l of linked.values()) {
    lines.push(`${l.t === 'playmap' ? 'PlayMap' : 'Patterns'} "${l.name}" (linked, ${l.status}): ${l.headline || 'no headline yet'} [${l.light}]`);
    for (const i of (l.items || []).filter((x) => x.light === 'red' || x.light === 'amber').slice(0, 4)) lines.push(`  ${i.label}: ${i.state} [${i.light}]`);
  }
  for (const p of (peers || []).slice(0, 8)) if ((!ctx || !ctx.node || p.id !== ctx.node.id) && !linked.has(p.id)) lines.push(`Heard on the network: ${p.t} "${p.name || ''}" (${p.status})`);
  return lines.join('\n');
}

module.exports = { buildContext, showBrief, worst };
