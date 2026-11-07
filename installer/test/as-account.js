'use strict';
/**
 * The installer's life cycle's probe, run by a task as the standard account the life cycle made and gave start and stop
 * (installer/test/lifecycle.test.js): each request of its plan written into that account's own inbox and its own control
 * task run (schtasks.exe /Run), as Start AGMessage and Stop AGMessage… do (app/launch.js), then the control task's answer
 * to that request's id waited for in the account's outbox; what each met written to ran.json beside its plan.
 *
 *   node as-account.js <folder>      the folder holds plan.json: {task, inbox, answer, runMs, answerMs, requests: [{id, verb, …}]}
 *
 * Its first act is ran.json with the account it runs as, so the life cycle tells a probe that ran as the account from a
 * task whose logon Windows refused; ran.json says `done` once the probe has ended, however it ended. Each /Run is bounded
 * by the plan's `runMs` and each answer by its `answerMs` (installer/test/expect.js PROBE), which the life cycle's own wait
 * is made from.
 *
 * Invariants: Node's own modules only; schtasks.exe by its absolute path in the Windows folder; it reads and writes no
 * secret (a request holds none, and the answers say none).
 */
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
/** A bound of the plan's: a whole number of milliseconds, up to ten minutes. */
const bound = (v, what) => {
  if (!Number.isSafeInteger(v) || v < 1000 || v > 600_000) throw new Error('the plan\'s ' + what + ' is not a bound of 1 s to 10 minutes');
  return v;
};

async function main(dir, out) {
  const save = () => fs.writeFileSync(path.join(dir, 'ran.json'), JSON.stringify(out, null, 2));
  save();
  const plan = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'));
  const runMs = bound(plan.runMs, 'runMs');
  const answerMs = bound(plan.answerMs, 'answerMs');
  const schtasks = path.win32.join(String(process.env.SystemRoot || 'C:\\Windows'), 'System32', 'schtasks.exe');
  for (const request of plan.requests) {
    const step = { verb: request.verb, id: request.id };
    out.steps.push(step);
    save();
    try { fs.writeFileSync(plan.inbox, JSON.stringify(request)); } catch (e) { step.wrote = String(e.code || e.message); break; }
    const r = childProcess.spawnSync(schtasks, ['/Run', '/TN', plan.task], { encoding: 'utf8', windowsHide: true, timeout: runMs });
    step.ran = r.status;
    if (r.status !== 0) { step.err = String(r.stderr || r.stdout || (r.error && r.error.code) || '').trim().slice(0, 300); break; }
    const t0 = Date.now();
    while (Date.now() - t0 < answerMs) {
      try {
        const a = JSON.parse(fs.readFileSync(plan.answer, 'utf8'));
        if (a && a.id === request.id) { step.answer = { code: a.code, words: String(a.words || '').slice(0, 400), ranAs: String(a.ranAs || ''), for: String(a.for || '') }; break; }
      } catch { /* not written yet, or being written */ }
      await sleep(500);
    }
    if (!step.answer) { step.err = 'no answer to ' + request.id + ' within ' + answerMs / 1000 + ' s'; break; }
  }
}

const dir = process.argv[2];
const out = { user: os.userInfo().username, steps: [], done: false };
main(dir, out).catch((e) => {
  out.error = String((e && e.message) || e).slice(0, 400);
  process.exitCode = 1;
}).finally(() => {
  out.done = true;
  try { fs.writeFileSync(path.join(dir, 'ran.json'), JSON.stringify(out, null, 2)); } catch { /* nothing to write into: the life cycle says the probe left no answer */ }
});
