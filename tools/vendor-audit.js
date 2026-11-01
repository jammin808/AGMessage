#!/usr/bin/env node
'use strict';
/**
 * The advisory audit of the browser libraries vendored in app/public/vendor, which `npm audit` cannot see: it reads
 * npm's packages from app/package-lock.json, and these files (and the libraries bundled inside them) are in none.
 *
 *   node tools/vendor-audit.js
 *       asks npm's registry (the bulk advisory endpoint `npm audit` uses) for the advisories against each version
 *       app/public/vendor/VENDOR.json lists; exit 0, or 1 with what is not assessed
 *
 * Each library with a version is asked about by its npm name at that version, a file's own package and every library
 * bundled in it alike (a library with no version recorded is named as not asked about). An advisory the registry
 * names is assessed when its library's entry lists it (`advisories`: its GHSA id, its severity and the key of its
 * assessment) and `assessments` holds that key: whether it applies here, why, and, when it does, what bounds it.
 *
 * Invariants:
 *   - Fail closed: a high or critical advisory against a listed version that VENDOR.json does not assess, or assesses
 *     at another severity than the registry now gives it, fails the run, and so does a registry that does not answer
 *     or answers what is not a list of advisories. A moderate or low one not assessed is named, and does not fail.
 *   - Each version is asked about on its own, so an advisory is always the version's that it was asked about.
 */
const fs = require('fs');
const path = require('path');

const MANIFEST = path.join(__dirname, '..', 'app', 'public', 'vendor', 'VENDOR.json');
const ENDPOINT = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk';
const FAILS = new Set(['high', 'critical']);

/** Every library VENDOR.json lists: each file's own package, then the libraries bundled in it, with where each is. */
function libraries(manifest) {
  const out = [];
  for (const [file, e] of Object.entries(manifest.files || {})) {
    out.push({ where: file, c: e });
    for (const b of e.bundles || []) out.push({ where: file + ' bundles ' + b.package, c: b });
  }
  return out;
}

/**
 * The registry's questions: one body per round, each naming every package at one version only, so the advisories a
 * round answers are that version's. A library listed twice at one version (core-js in both pdf.js files) is asked once.
 */
function rounds(manifest) {
  const versions = new Map();
  for (const { c } of libraries(manifest)) {
    if (typeof c.version !== 'string' || !c.version) continue;
    if (!versions.has(c.package)) versions.set(c.package, []);
    const list = versions.get(c.package);
    if (!list.includes(c.version)) list.push(c.version);
  }
  const out = [];
  for (const [name, list] of versions) list.forEach((v, i) => { (out[i] = out[i] || {})[name] = [v]; });
  return out;
}

/** A GHSA id from the registry's advisory (its url names it), or null. */
function ghsa(advisory) {
  const m = /\/(GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4})$/.exec(String((advisory && advisory.url) || ''));
  return m ? m[1] : null;
}

/**
 * What the registry's answers mean against VENDOR.json: `answers[i]` is round i's answer, keyed by package. Returns
 * { failures, notes }: a failure is an advisory that fails the run (above), a note one that is said and does not.
 */
function assess(manifest, asked, answers) {
  const failures = [];
  const notes = [];
  const assessments = manifest.assessments || {};
  asked.forEach((body, i) => {
    const answer = answers[i];
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) { failures.push('the registry gave no answer to round ' + (i + 1)); return; }
    for (const [name, list] of Object.entries(answer)) {
      if (!Object.hasOwn(body, name)) continue;
      if (!Array.isArray(list)) { failures.push(name + ': the registry\'s answer is not a list of advisories'); continue; }
      const version = body[name][0];
      const holders = libraries(manifest).filter(({ c }) => c.package === name && c.version === version);
      for (const a of list) {
        const id = ghsa(a);
        const severity = String((a && a.severity) || 'unknown');
        const said = name + ' ' + version + ': ' + (id || 'an advisory with no GHSA id') + ' (' + severity + ', ' + String((a && a.title) || '') + ')';
        for (const { where, c } of holders) {
          const rec = id && (c.advisories || []).find((r) => r.id === id);
          const known = rec && Object.hasOwn(assessments, rec.assessed);
          if (known && rec.severity === severity) { notes.push(where + ': ' + said + ' — assessed: ' + (assessments[rec.assessed].applies ? 'applies' : 'does not apply') + ' (' + rec.assessed + ')'); continue; }
          const why = !rec ? 'not assessed in VENDOR.json' : !known ? 'its assessment "' + rec.assessed + '" is not in VENDOR.json' : 'assessed at ' + rec.severity + '; assess it again';
          (FAILS.has(severity) ? failures : notes).push(where + ': ' + said + ' — ' + why);
        }
      }
    }
  });
  for (const { where, c } of libraries(manifest)) if (typeof c.version !== 'string' || !c.version) notes.push(where + ': not asked about, since no version is recorded (' + (c.unversioned || 'no reason given') + ')');
  return { failures, notes };
}

/** Ask the registry each round's question; a refusal, a timeout or what is not JSON is that round's missing answer. */
async function ask(asked) {
  const answers = [];
  for (const body of asked) {
    try {
      const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
      answers.push(res.ok ? await res.json() : null);
    } catch {
      answers.push(null);   // no answer: assess() fails the round
    }
  }
  return answers;
}

async function main() {
  let manifest;
  try { manifest = JSON.parse(await fs.promises.readFile(MANIFEST, 'utf8')); } catch (e) {
    console.error('vendor-audit: app/public/vendor/VENDOR.json could not be read: ' + e.message);
    return 1;
  }
  const asked = rounds(manifest);
  const { failures, notes } = assess(manifest, asked, await ask(asked));
  for (const n of notes) console.log('vendor-audit: ' + n);
  for (const f of failures) console.error('vendor-audit: FAIL ' + f);
  const count = asked.reduce((n, b) => n + Object.keys(b).length, 0);
  console.log('vendor-audit: ' + count + ' library versions asked about; ' + (failures.length ? failures.length + ' not assessed' : 'every high or critical advisory assessed'));
  return failures.length ? 1 : 0;
}

if (require.main === module) main().then((code) => { process.exitCode = code; });

module.exports = { ENDPOINT, libraries, rounds, assess, ghsa };
