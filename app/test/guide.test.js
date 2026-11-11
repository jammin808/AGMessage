'use strict';
// The admin's guide (public/guide/): five pages AGMessage serves to read, held to the code they describe. Every label the
// guide draws as a control (`<span class="ui">`) and every line it quotes as a page's words (`<q>`) is found, as written, in
// what ships (the pages, their scripts, the server, the laptop's commands, the installer and the portable folder's
// scripts), so a label renamed in the code fails here until the guide says the new one. Each page is a page with people
// (theme-init.js first, and no script of its own), links only to pages and places that are there, names the five parts
// the same way with its own marked, and uses the house's words. Served: each answers with the strict policy, checked at
// every load; a part that is not there is a 404.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ROOT, REPO, readSource, filesUnder, startServer, stopServer } = require('./helpers');

const GUIDE = path.join(ROOT, 'public', 'guide');
const PAGES = ['index.html', 'setup.html', 'laptops.html', 'devices.html', 'accounts.html'];
const PARTS = [['/guide/', 'Contents'], ['/guide/setup.html', 'Setting up'], ['/guide/laptops.html', 'Laptops'], ['/guide/devices.html', 'Tablets and phones'], ['/guide/accounts.html', 'People and accounts']];
const read = (f) => readSource(path.join(GUIDE, f));
/** The text of a piece of HTML as a reader sees it: tags dropped, the five entities read, white space as one space. */
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': '\'' };
const textOf = (html) => html.replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot|#39);/g, (_m, e) => ENTITIES[e]).replace(/\s+/g, ' ').trim();
/** Every match of `re`'s first group in `html`, as text. */
const all = (html, re) => [...html.matchAll(re)].map((m) => textOf(m[1]));

/** What ships, as one text to search: a page's words as its source writes them (a script's quotes and escapes read). */
function shipped() {
  const under = (dir, re, skip) => filesUnder(dir, re, { skip }).map((f) => path.join(ROOT, f));
  const files = [
    ...under('public', /\.(?:js|mjs|html)$/, ['vendor', 'guide']),
    ...under('lib', /\.js$/),
    ...['server.js', 'launch.js', 'machine.js', 'supervise.js'].map((f) => path.join(ROOT, f)),
    ...['installer/AGMessage.iss', 'start-agmessage.bat', 'make-shareable-copy.bat'].map((f) => path.join(REPO, f)),
  ];
  return files.map((f) => readSource(f)).join('\n')
    .replace(/\\(['"`])/g, '$1').replace(/&(amp|lt|gt|quot|#39);/g, (_m, e) => ENTITIES[e]).replace(/\s+/g, ' ');
}

test('the guide is its five pages, each a page with people: theme-init.js first and no script of its own, its title, the parts named the same way with its own marked', () => {
  assert.deepEqual(fs.readdirSync(GUIDE).sort(), [...PAGES].sort(), 'the guide\'s pages (a new one joins PAGES and the parts)');
  for (const f of PAGES) {
    const html = read(f);
    assert.match(html, /^<!doctype html>\n<html lang="en">/, f + ': a document in English');
    assert.deepEqual([...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]), ['<script src="/theme-init.js">'], f + ': theme-init.js alone, so the floor and the theme are read and nothing else runs');
    assert.ok(html.indexOf('/styles.css') < html.indexOf('/theme-init.js'), f + ': the stylesheet first, as every page with people');
    assert.match(html, /<title>AGMessage — (?:the admin's guide|guide: [a-z ]+)<\/title>/, f + ': its title');
    assert.equal((html.match(/<h1\b/g) || []).length, 1, f + ': one heading of the first level');
    const parts = [...html.match(/<nav class="guide-parts"[^>]*>([\s\S]*?)<\/nav>/)[1].matchAll(/<a href="([^"]+)"( aria-current="page")?>([^<]+)<\/a>/g)];
    assert.deepEqual(parts.map((m) => [m[1], m[3]]), PARTS, f + ': the five parts, in order, named the same way');
    const own = f === 'index.html' ? '/guide/' : '/guide/' + f;
    assert.deepEqual(parts.filter((m) => m[2]).map((m) => m[1]), [own], f + ': its own part marked');
  }
});

test('every label the guide draws and every line it quotes is the code\'s own words', () => {
  const code = shipped();
  const missing = [];
  let count = 0;
  for (const f of PAGES) {
    const html = read(f);
    const words = [...all(html, /<span class="ui">([\s\S]*?)<\/span>/g), ...all(html, /<q>([\s\S]*?)<\/q>/g)];
    count += words.length;
    for (const w of new Set(words)) if (!code.includes(w)) missing.push(f + ': ' + w);
  }
  assert.ok(count >= 300, 'the guide quotes the pages throughout (' + count + ')');
  assert.deepEqual(missing, [], 'each found as written in what ships (a label renamed in the code is renamed here)');
});

test('the guide links only to what is there: its parts and their places, the pages it names, and no other site', () => {
  const ids = Object.fromEntries(PAGES.map((f) => [f, new Set([...read(f).matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]))]));
  const ROUTES = new Set(['/', '/tls', '/admin.html', '/halls.html', '/users.html']);
  const broken = [];
  for (const f of PAGES) {
    for (const [, href] of read(f).matchAll(/\bhref="([^"]+)"/g)) {
      if (href === '/styles.css') continue;
      const [where, place] = href.split('#');
      const page = where === '' ? f : where === '/guide/' ? 'index.html' : where.startsWith('/guide/') ? where.slice(7) : null;
      if (page === null) { if (!ROUTES.has(where) || place) broken.push(f + ': ' + href); continue; }
      if (!PAGES.includes(page) || (place && !ids[page].has(place))) broken.push(f + ': ' + href);
    }
  }
  assert.deepEqual(broken, [], 'every link lands');
  for (const r of ROUTES) if (r.endsWith('.html')) assert.ok(fs.existsSync(path.join(ROOT, 'public', r.slice(1))), r);
});

test('the guide speaks the house\'s words and names nothing secret', () => {
  for (const f of PAGES) {
    const text = textOf(read(f).replace(/<(script|style)[\s\S]*?<\/\1>/g, ''));
    assert.doesNotMatch(text, /\b(?:sessions?|meetings?|directors?|research|displays?)\b/i, f + ': hall, room, seat, the Board, screens, the backstage team');
    assert.doesNotMatch(text, /\bHelp section\b|\bhelp pages?\b/i, f + ': the guide is the guide; Help is a help request');
    assert.doesNotMatch(read(f), /\b[0-9a-f]{16}\b|swk_[A-Za-z0-9]{8,}|sk-ant-[A-Za-z0-9]/, f + ': no token, key or code of any AGMessage');
  }
});

test('served: each part answers with the strict policy, checked at every load, and a part that is not there is a 404', async () => {
  const s = await startServer();
  try {
    for (const [p] of PARTS) {
      const r = await fetch(s.base + p);
      assert.equal(r.status, 200, p);
      assert.match(r.headers.get('content-type') || '', /^text\/html/, p);
      assert.equal(r.headers.get('cache-control'), 'no-cache', p + ': checked with the server at every load');
      assert.match(r.headers.get('content-security-policy') || '', /script-src 'self'/, p + ': the strict policy');
      assert.match(await r.text(), /<main class="guide">/, p);
    }
    const bare = await fetch(s.base + '/guide', { redirect: 'manual' });
    assert.ok([301, 302, 308].includes(bare.status) && /\/guide\/$/.test(bare.headers.get('location') || ''), '/guide goes to /guide/');
    assert.equal((await fetch(s.base + '/guide/nothing.html')).status, 404);
  } finally {
    await stopServer(s.child);
  }
});
