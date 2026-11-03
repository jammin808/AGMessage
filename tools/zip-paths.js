#!/usr/bin/env node
'use strict';
/**
 * Every path the portable zip makes once a person extracts it, held under Windows' MAX_PATH.
 *
 *   node tools/zip-paths.js <bundle.zip> [--base <folder>]
 *       lays each member where Explorer's Extract All lays it: under <base>\<the zip's own name without .zip>\, the
 *       folder Extract All proposes beside the zip, with the member's own folders below that (the bundle's one folder,
 *       AGMessage, among them); and again as a clean copy beside the bundle's folder, as make-shareable-copy.bat makes
 *       one there under the longest name it gives one (COPY). It says the longest file's path and the longest folder's,
 *       each with its length and what is left to spare. Exit 0 when every file's path is under 260 characters and every
 *       folder's under 248; 1 naming each that is not, the longest first; 2 when the zip cannot be read; 64 for a word it
 *       does not know.
 *
 * Why 260: a path handed to Windows' file calls without the \\?\ prefix holds MAX_PATH, 260 characters with its
 * terminating null, so 259 at most; a folder is held 12 shorter, so an 8.3 name still fits in it (CreateDirectory's 248,
 * so 247 at most) (https://learn.microsoft.com/en-us/windows/win32/fileio/maximum-file-path-limitation). Explorer is not
 * long-path aware, so the LongPathsEnabled policy does not lift either for Extract All: a member past them is not
 * extracted, and the bundle that lands is not whole.
 *
 * The base, unless --base names another (an absolute folder: C:\… or \\server\share\…): C:\Users\<20 characters>\Downloads,
 * where a browser saves the zip, under the profile folder of the longest user name Windows takes (20 characters). A
 * profile folder Windows names <name>.<COMPUTERNAME>, <name>.<DOMAIN> or <name>.000, because one of that name was there
 * already, is longer (up to 36 characters) and is not what is measured. What is measured is the zip downloaded on its own:
 * a release's, or a CI run's moved out of the artifact zip GitHub puts it in (README.txt); extracted inside that folder,
 * every path is longer by its name. A length is counted in UTF-16 code units, as Windows counts it. The zip's members are read from its central directory as the Windows evidence
 * lane reads them (tools/readings-take.js zipEntries), and a member named outside its folder is refused there too.
 *
 * Invariants: it reads the zip and writes nothing; it starts no program; it requires Node's own modules and that reader.
 */
const { zipEntries, memberParts } = require('./readings-take.js');

/** The longest path a file may have: MAX_PATH less its terminating null. */
const MAX_FILE = 259;
/** The longest path a folder may have: CreateDirectory's 248 less its terminating null. */
const MAX_FOLDER = 247;
/** A profile folder named after the longest user name Windows takes: 20 characters (a renamed one, <name>.<COMPUTERNAME>, is longer). */
const ACCOUNT = 'x'.repeat(20);
/** Where a browser saves the zip, under that profile. */
const BASE = 'C:\\Users\\' + ACCOUNT + '\\Downloads';
/**
 * The longest name make-shareable-copy.bat gives a clean copy, made beside the bundle's folder: its NAME with the time
 * (yyyyMMdd-HHmm) and the highest number it tries (-99). test/zippaths.test.js holds it to the .bat.
 */
const COPY = 'AGMessage-Portable-clean-yyyymmdd-hhmm-99';

/** A file's own name, whichever separator its path uses (pure). */
function fileName(file) {
  return String(file).split(/[\\/]/).pop();
}

/** The folder Extract All proposes for a zip: its own file name without `.zip` (pure). */
function stemOf(zipName) {
  return fileName(zipName).replace(/\.zip$/i, '');
}

/** A folder named with Windows' separators and no trailing one (pure). */
function windowsFolder(base) {
  return String(base).replace(/\//g, '\\').replace(/\\+$/, '');
}

/**
 * Each path the members make under `<base>\<stem>\` (pure): {files: [{path, length}], folders: [{path, length}]}, each
 * list the longest first. With `copy` (COPY unless null), each member inside the bundle's folder lands a second time in
 * a folder of that name beside it, as the clean copy holds it. The folders are every folder a member lies in or names,
 * the extraction's own folder among them.
 */
function extractedPaths(entries, { base = BASE, stem, copy = COPY }) {
  if (typeof stem !== 'string' || !stem) throw new Error('the zip\'s own name is needed: Extract All names its folder after it');
  const root = windowsFolder(base) + '\\' + stem;
  const folders = new Set([root]);
  const files = new Set();
  const lay = (parts, dir) => {
    let at = root;
    for (const [i, part] of parts.entries()) {
      at += '\\' + part;
      if (i < parts.length - 1 || dir) folders.add(at);
      else files.add(at);
    }
  };
  for (const e of entries) {
    const parts = memberParts(e.name);
    lay(parts, e.dir);
    if (copy && (parts.length > 1 || e.dir)) lay([copy, ...parts.slice(1)], e.dir);
  }
  const measured = (list) => [...list].map((p) => ({ path: p, length: p.length })).sort((a, b) => b.length - a.length || (a.path < b.path ? -1 : 1));
  return { files: measured(files), folders: measured(folders) };
}

/**
 * The check (pure): {files, folders, longestFile, longestFolder, over}; `over` holds every file past MAX_FILE and every
 * folder past MAX_FOLDER, each with its kind and its limit, the longest first.
 */
function check(entries, opts) {
  const { files, folders } = extractedPaths(entries, opts);
  const over = [
    ...files.filter((f) => f.length > MAX_FILE).map((f) => ({ ...f, kind: 'file', limit: MAX_FILE })),
    ...folders.filter((f) => f.length > MAX_FOLDER).map((f) => ({ ...f, kind: 'folder', limit: MAX_FOLDER })),
  ].sort((a, b) => b.length - a.length);
  return { files: files.length, folders: folders.length, longestFile: files[0] || null, longestFolder: folders[0] || null, over };
}

/** One line of what it found: the path's length against its limit and what is left (pure). */
function lengthWords(kind, p, limit) {
  if (!p) return 'no ' + kind;
  const left = limit - p.length;
  return 'the longest ' + kind + ' is ' + p.length + ' characters of ' + limit + ' (' + (left >= 0 ? left + ' to spare' : -left + ' too many') + '): ' + p.path;
}

/** An absolute Windows folder: a drive and its root (C:\), or a share (\\server\share). */
const ABSOLUTE = /^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+)/;

/** How many of the paths past their limit are named one by one; the rest are counted. */
const NAMED = 20;

function main(argv) {
  const rest = [...argv];
  let base = BASE;
  const at = rest.indexOf('--base');
  if (at >= 0) {
    // An absolute folder, as Extract All's always is: a drive's (C:\…) or a share's (\\server\share\…); a relative one would
    // measure every path shorter than Windows makes it.
    if (at + 1 >= rest.length || !ABSOLUTE.test(String(rest[at + 1]).replace(/\//g, '\\'))) { console.error('zip-paths: --base names an absolute folder (C:\\… or \\\\server\\share\\…)'); return 64; }
    base = rest[at + 1];
    rest.splice(at, 2);
  }
  if (rest.length !== 1 || rest[0].startsWith('--')) { console.error('zip-paths: <bundle.zip> [--base <folder>]'); return 64; }
  const zip = rest[0];
  let entries;
  try { entries = zipEntries(zip); } catch (e) { console.error('zip-paths: ' + zip + ' could not be read (' + e.message + ')'); return 2; }
  let r;
  try { r = check(entries, { base, stem: stemOf(zip) }); } catch (e) { console.error('zip-paths: ' + e.message); return 2; }
  console.log('zip-paths: ' + entries.length + ' members of ' + fileName(zip) + ', extracted under ' + windowsFolder(base) + '\\' + stemOf(zip) + '\\, and a clean copy beside the bundle\'s folder as ' + COPY + ' (' + r.files + ' files, ' + r.folders + ' folders)');
  console.log('  ' + lengthWords('file', r.longestFile, MAX_FILE));
  console.log('  ' + lengthWords('folder', r.longestFolder, MAX_FOLDER));
  if (!r.over.length) return 0;
  console.error('zip-paths: ' + r.over.length + ' path' + (r.over.length === 1 ? '' : 's') + ' too long for Extract All (a file holds ' + MAX_FILE + ' characters at most, a folder ' + MAX_FOLDER + '):');
  for (const p of r.over.slice(0, NAMED)) console.error('  ' + p.kind + ', ' + p.length + ' characters: ' + p.path);
  if (r.over.length > NAMED) console.error('  and ' + (r.over.length - NAMED) + ' more');
  return 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { MAX_FILE, MAX_FOLDER, ACCOUNT, BASE, COPY, fileName, stemOf, windowsFolder, extractedPaths, check, lengthWords, main };
