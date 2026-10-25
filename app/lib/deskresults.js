'use strict';
/**
 * The results of approved show-desk proposals this AGMessage ran, until Stagewatch's desk takes them (Show Bus 1.2 §11).
 *
 * Stagewatch hands an approved proposal over once, never lists it again, and turns it "undelivered: <name> didn't report
 * back" five minutes later unless a result came — and it still takes a late one. So a result is posted until the desk
 * takes it or refuses it for good, it outlives a restart of AGMessage, and after the first try it goes only to the desk's
 * proposal that is still the one that ran: a restarted Stagewatch numbers from p1 again, and its p1 is another proposal.
 * Pure: what an answer means, whether a proposal read back is still ours, and which records read off the disk are kept.
 */

const MAX_WAITING = 200;           // results kept until taken; the next one pushes out the oldest, which is said
const RETRY_CAP_MS = 60_000;       // no answer or a 5xx: 3 s, doubling, at most a minute
const HOLD_MAX_S = 120;            // a Retry-After asking for longer is taken as 120 s
const ID = /^[A-Za-z0-9_-]{1,40}$/;
const LINK = /^(default|hall:[A-Z0-9]{4,12})$/;
const TAG = /^[0-9a-f]{12}$/;

/** How long Stagewatch asks a key to wait (a 429, or a 503 that says): its Retry-After in 1-120 s, 60 s when unsaid. */
const holdMs = (retryAfter) => (Number.isInteger(retryAfter) ? Math.min(HOLD_MAX_S, Math.max(1, retryAfter)) * 1000 : 60_000);

/**
 * What one answer to a result post means: {final: 'taken' | 'refused' | 'gone'} or {waitMs}. `attempt` counts from 1.
 * 2xx: taken. 404: gone (no desk there, or no such proposal on one). 409 (every refusal of the desk's: no such proposal,
 * another node's key, not waiting for a result) and any other 4xx (a body it cannot read): refused for good. 429, or a
 * 503 with Retry-After: as long as Stagewatch says. 401 and 403: a key Stagewatch does not take now (its lockout minute,
 * a revoked or read-only key the admin replaces): `authWaitMs`. No answer and other 5xx: 3 s doubling to a minute.
 */
function postVerdict({ status, retryAfter = null }, attempt, { authWaitMs = 60_000 } = {}) {
  if (status >= 200 && status < 300) return { final: 'taken' };
  if (status === 429 || (status === 503 && Number.isInteger(retryAfter))) return { waitMs: holdMs(retryAfter) };
  if (status === 401 || status === 403) return { waitMs: authWaitMs };
  if (status === 404) return { final: 'gone' };
  if (status >= 400 && status < 500) return { final: 'refused' };
  return { waitMs: Math.min(RETRY_CAP_MS, 3000 * 2 ** Math.max(0, attempt - 1)) };
}

/**
 * The desk's proposal under the record's number, read back before a result is posted again: 'post' while it is the one
 * that ran (its line, its target, when it was made) and still waits for a result (approved; or undelivered, which
 * Stagewatch still takes); 'taken' when it is done or failed (an earlier post landed and its answer was lost); 'wait'
 * while its state cannot be read; 'gone' for anything else — another proposal under that number, or one that no longer
 * waits. A record without the time it was made is ours only on the Stagewatch it was collected from (`sameStagewatch`).
 */
function readBack(rec, p, { sameStagewatch = false } = {}) {
  if (!p || p.gone || p.line !== rec.line || !p.target || p.target.id !== rec.target) return 'gone';
  if (rec.created ? p.created !== rec.created : !sameStagewatch) return 'gone';
  if (p.state === 'approved' || p.state === 'undelivered') return 'post';
  if (p.state === 'done' || p.state === 'failed') return 'taken';
  return p.state === 'unknown' ? 'wait' : 'gone';
}

/** What is kept on disk of a record: what ran and what to tell, never a key, token or link. */
const persisted = (r) => ({ sw: r.sw, link: r.link, id: r.id, created: r.created, line: r.line, target: r.target, ok: r.ok, words: r.words, ran: r.ran });

/**
 * The records read off the disk that may be reported, each read by type and refused when anything is off (fail closed):
 * a record for another node, without the time its proposal was made (it could not be told from a restarted desk's), or
 * of a shape this build did not write is dropped. At most MAX_WAITING, the newest.
 */
function readRecords(json, nodeId) {
  const list = json && typeof json === 'object' && Array.isArray(json.results) ? json.results : [];
  const out = [];
  for (const r of list) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
    const ok = typeof r.sw === 'string' && TAG.test(r.sw) && typeof r.link === 'string' && LINK.test(r.link)
      && typeof r.id === 'string' && ID.test(r.id) && Number.isFinite(r.created) && r.created > 0
      && typeof r.line === 'string' && r.line.length <= 600 && typeof r.words === 'string' && r.words.length <= 300
      && typeof r.ok === 'boolean' && r.target === nodeId && Number.isFinite(r.ran) && r.ran > 0;
    if (ok) out.push(persisted(r));
  }
  return out.slice(-MAX_WAITING);
}

module.exports = { MAX_WAITING, holdMs, postVerdict, readBack, persisted, readRecords };
