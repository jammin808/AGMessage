#!/usr/bin/env node
'use strict';
/**
 * The secret scan: no key, token or private key is ever committed. Reads every file git tracks (or, outside a checkout,
 * every file under the repository but the ignored folders) and fails on anything shaped like one of the credentials
 * AGMessage and its peers use. A test fixture that must hold a credential-shaped string marks its line
 * `secret-scan: fixture` and says why.
 *
 *   node tools/scan-secrets.js            exit 0 clean, 1 with each finding as file:line and the kind (never the value)
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'node', 'bin', 'artifacts', 'coverage', 'data', 'uploads']);
const SKIP_FILES = /(^|\/)app\/public\/vendor\/|package-lock\.json$|\.(png|jpe?g|gif|webp|ico|pdf|zip|exe|woff2?)$/i;

const KINDS = [
  ['an Anthropic API key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['a Stagewatch key', /\bswk_[A-Za-z0-9_-]{16,}/],
  ['an AGMessage context token', /\bagn_[A-Za-z0-9_-]{20,}/],
  ['a PEM private key', /-----BEGIN (?:EC |RSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
  ['a GitHub token', /\b(?:ghp|gho|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/],
  ['an AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['a Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['a sealed AGMessage secret', /\benc1:[A-Za-z0-9+/=]{40,}/],
];

function tracked() {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status === 0) return r.stdout.split('\0').filter(Boolean);
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = dir ? dir + '/' + e.name : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(rel); } else out.push(rel);
    }
  };
  walk('');
  return out;
}

let found = 0;
for (const rel of tracked()) {
  if (SKIP_FILES.test(rel)) continue;
  let text;
  try { text = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { continue; }   // removed in the working tree: nothing to scan
  if (text.includes('\u0000')) continue;   // binary
  text.split('\n').forEach((line, i) => {
    if (line.includes('secret-scan: fixture')) return;
    for (const [kind, re] of KINDS) if (re.test(line)) { console.error(rel + ':' + (i + 1) + ': ' + kind); found++; }
  });
}
if (found) { console.error('scan-secrets: ' + found + ' finding(s) — remove the secret, rotate it, and never commit it again'); process.exit(1); }
console.log('scan-secrets: clean');
