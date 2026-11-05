# Third-party notices

What AGMessage's pages load from others is listed here, file by file: each library vendored in `app/public/vendor`, its
package, version, licence and copyright, and the libraries bundled inside it. `app/public/vendor/VENDOR.json` is the same
list for machines, with where each file came from and its SHA-256. The licence text of each, with the copyright notice
it asks to be kept, is in `licenses/<package>/` beside this file. The portable folder carries this file and `licenses\`
at its top, and each release's SBOM (`agmessage-sbom.cdx.json`) lists these libraries beside npm's packages.
`app/test/vendor.test.js` holds the folder, `VENDOR.json`, `licenses/` and this file to each other.

Each file is shipped as its package published it, byte for byte. None is changed by AGMessage.

Not listed here: the npm packages the server runs, which ship with their own licence files in `app\node_modules` and
are listed in the SBOM (among them `supports-color` 8.1.1 and the `has-flag` 4.0.0 it requires, both MIT, Copyright (c)
Sindre Sorhus, each with its `license` file: AGMessage ships `supports-color` so that `debug`'s search for it ends in
`app\node_modules`, never in a folder above it); and the Node.js runtime (`node\`, Node.js 24.22.1) and cloudflared
(`bin\`, 2026.3.0), which `tools/fetch-runtime.ps1` downloads at pinned versions checked by their SHA-256. A checksum is
not a licence: the portable folder does not carry their licence texts yet. They are Node.js's
(https://github.com/nodejs/node/blob/v24.22.1/LICENSE, the MIT licence and the licences of what it bundles) and
cloudflared's (https://github.com/cloudflare/cloudflared/blob/2026.3.0/LICENSE, Apache-2.0).

## pdf.js 4.10.38, its legacy build

The legacy build is compiled for Chrome 103, Firefox ESR and Safari 16.4, the targets pdf.js's own build gives it
(`ENV_TARGETS`, https://github.com/mozilla/pdf.js/blob/v4.10.38/gulpfile.mjs#L81-L90). That is its floor: below it the
build is not meant to run, and on Safari before 16.4 (iOS and iPadOS included) the module does not load at all, since
it holds a class static block, which Safari parses from 16.4. Above it, core-js's polyfills supply what the browser
lacks, `Promise.withResolvers` among them (Safari and iPadOS have it only from 17.4). Each file carries pdf.js's own
licence notice at its top. https://github.com/mozilla/pdf.js

### `pdf.min.mjs` (the page's module)

| Package | Version | Licence | Copyright | Licence text |
|---|---|---|---|---|
| pdfjs-dist | 4.10.38 | Apache-2.0 | Copyright 2024 Mozilla Foundation | `licenses/pdfjs-dist/` |
| core-js (bundled) | 3.39.0 | MIT | Copyright (c) 2014-2024 Denis Pushkarev | `licenses/core-js/` |

### `pdf.worker.min.mjs` (pdf.js's worker)

| Package | Version | Licence | Copyright | Licence text |
|---|---|---|---|---|
| pdfjs-dist | 4.10.38 | Apache-2.0 | Copyright 2024 Mozilla Foundation | `licenses/pdfjs-dist/` |
| core-js (bundled) | 3.39.0 | MIT | Copyright (c) 2014-2024 Denis Pushkarev | `licenses/core-js/` |
| OpenJPEG (bundled) | — | BSD-2-Clause | Copyright (c) 2002-2014, Universite catholique de Louvain (UCL), Belgium | `licenses/openjpeg/` |

OpenJPEG decodes the JPEG 2000 images in a PDF. It is compiled to WebAssembly by pdf.js.openjpeg (BSD-2-Clause,
Copyright (c) 2024, Mozilla Foundation, `licenses/openjpeg/pdf.js.openjpeg-LICENSE`) at the OpenJPEG revision pdf.js
4.10.38's build pinned; the compiled decoder records no version. OpenJPEG's licence names its other copyright holders.

## mammoth 1.13.0

Word documents (`.docx`) become HTML in the page's document worker (`app/public/docworker.js`), which the page ends at its
deadline. https://github.com/mwilliamson/mammoth.js

### `mammoth.browser.min.js`

| Package | Version | Licence | Copyright | Licence text |
|---|---|---|---|---|
| mammoth | 1.13.0 | BSD-2-Clause | Copyright (c) 2013, Michael Williamson | `licenses/mammoth/` |
| @xmldom/xmldom (bundled) | 0.8.6 | MIT | Copyright 2019 - present Christopher J. Brody and other contributors | `licenses/xmldom/` |
| base64-js (bundled) | 1.5.1 | MIT | Copyright (c) 2014 Jameson Little | `licenses/base64-js/` |
| buffer (bundled) | 4.9.1 | MIT | Copyright (c) Feross Aboukhadijeh, and other contributors. | `licenses/buffer/` |
| dingbat-to-unicode (bundled) | 1.0.2 | BSD-2-Clause | Copyright (c) 2021, Michael Williamson | `licenses/dingbat-to-unicode/` |
| ieee754 (bundled) | 1.1.8 | BSD-3-Clause | Copyright (c) 2008, Fair Oaks Labs, Inc. | `licenses/ieee754/` |
| isarray (bundled) | 1.0.0 | MIT | Copyright (c) 2013 Julian Gruber | `licenses/isarray/` |
| jszip (bundled) | 3.7.1 | MIT OR GPL-3.0-or-later | Copyright (c) 2009-2016 Stuart Knightley, David Duponchel, Franz Buchinger, António Afonso | `licenses/jszip/` |
| pako (bundled in jszip) | 1.0.5 | MIT AND Zlib | Copyright (C) 2014-2017 by Vitaly Puzrin and Andrei Tuputcyn | `licenses/pako/` |
| lie (bundled in jszip) | 3.3.0 | MIT | Copyright (c) 2014-2018 Calvin Metcalf, Jordan Harband | `licenses/lie/` |
| immediate (bundled in jszip) | 3.0.6 | MIT | Copyright (c) 2012 Barnesandnoble.com, llc, Donavon West, Domenic Denicola, Brian Cavalier | `licenses/immediate/` |
| set-immediate-shim (bundled in jszip) | 1.0.1 | MIT | Copyright (c) Sindre Sorhus | `licenses/set-immediate-shim/` |
| lop (bundled) | 0.4.2 | BSD-2-Clause | Copyright (c) 2013, Michael Williamson | `licenses/lop/` |
| option (bundled) | 0.2.4 | BSD-2-Clause | Copyright (c) 2013, Michael Williamson | `licenses/option/` |
| process (bundled) | 0.11.9 | MIT | Copyright (c) 2013 Roman Shtylman | `licenses/process/` |
| underscore (bundled) | 1.13.1 | MIT | Copyright (c) 2009-2021 Jeremy Ashkenas, Julian Gonggrijp, and DocumentCloud and Investigative Reporters & Editors | `licenses/underscore/` |
| xmlbuilder (bundled) | 10.0.0 | MIT | Copyright (c) 2013 Ozgur Ozcitak | `licenses/xmlbuilder/` |

- The bundled packages and their versions are the ones mammoth's own build lists at the top of `mammoth.browser.js`,
  the unminified twin of this file in the same package. The four marked "in jszip" come inside jszip's own published
  bundle (`dist/jszip.min.js` of jszip 3.7.1, inside this file), which names no versions: each is the version jszip's
  lockfile pins at its tag (`package-lock.json` at https://github.com/Stuk/jszip/tree/v3.7.1), and the code in this
  file is that version's: pako's `assign` still tests `hasOwnProperty` on the object itself, which pako 1.0.6 replaced,
  and `app/test/vendor.test.js` holds that.
- jszip is offered under the MIT licence or GPL-3.0-or-later; AGMessage takes it under the MIT licence.
- pako ports parts of zlib: those carry zlib's licence (Copyright (C) 1995-2013 Jean-loup Gailly and Mark Adler), as
  each of pako's `lib/zlib` files begins, in `licenses/pako/zlib-LICENSE`.
- isarray 1.0.0 and set-immediate-shim 1.0.1 ship no licence file: their `LICENSE` here is the licence section of the
  package's own readme, as published, and for set-immediate-shim the MIT licence text it names.

## SheetJS Community Edition 0.20.3

Spreadsheets (`.xlsx`, `.xls`) are read in the page's document worker (`app/public/docworker.js`); a `.csv` is read by
AGMessage's own reader. Taken from SheetJS's own distribution
(https://cdn.sheetjs.com), never from npm's `xlsx`, which stopped at 0.18.5, before CVE-2023-30533 and CVE-2024-22363
were fixed. https://sheetjs.com

### `xlsx.full.min.js`

| Package | Version | Licence | Copyright | Licence text |
|---|---|---|---|---|
| xlsx | 0.20.3 | Apache-2.0 | Copyright (C) 2012-present   SheetJS LLC | `licenses/xlsx/` |
| codepage (bundled) | 1.15.0 | Apache-2.0 | Copyright (C) 2012-present   SheetJS LLC | `licenses/xlsx/` |
| crc-32 (bundled) | 1.2.0 | Apache-2.0 | Copyright (C) 2012-present   SheetJS LLC | `licenses/xlsx/` |
| cfb (bundled) | 1.2.2 | Apache-2.0 | Copyright (C) 2012-present   SheetJS LLC | `licenses/xlsx/` |

The bundled parts are SheetJS's own libraries, under the same licence.

## Advisories against the bundled libraries

Three of the libraries inside mammoth's file carry advisories published against their versions. mammoth 1.13.0, its
newest release, was built with them, and its file ships as mammoth published it, so each advisory is assessed instead:
`VENDOR.json` records each one on its library with whether it applies here and why (`assessments`), the release's SBOM
carries each with that analysis, and `tools/vendor-audit.js` (run by `npm run audit` and by the Security workflow, every
week too) asks npm's registry about every version listed here and fails on a high or critical advisory that is not
assessed. On 2026-11-01 the registry named none against pdf.js 4.10.38, core-js 3.39.0, SheetJS 0.20.3 or any other
library listed here.

| Library | Advisories | Applies here | Why |
|---|---|---|---|
| @xmldom/xmldom 0.8.6 | GHSA-8344-3jmq-59r6, GHSA-x4fp-j954-r2f4, GHSA-965w-775f-mr7g, GHSA-93r5-fhx6-vmg9 (high: quadratic time or memory, or a regular expression's backtracking, on crafted XML) | Yes | mammoth parses every part of a Word file with xmldom, so a crafted `.docx` keeps the page that draws it busy, or short of memory, until it is reloaded: the panel of whoever opens it, and every Board panel in the hall, where a file sent into the hall opens itself. The server and the other pages are not affected. mammoth runs in the page's document worker, which the page ends after 15 s, and is handed only a file that passed the archive check, with no part declaring a document type or an entity: a crafted file costs that worker its 15 s, and the page goes on. In 0.6.0's plan a file also stops opening itself on the Board's panel (unit 26). No mammoth release bundles the fixed xmldom (0.8.15). |
| @xmldom/xmldom 0.8.6 | GHSA-6h8r-xr42-gp59 (moderate: a not-well-formed end tag accepted) | Yes, harmlessly | Such a part is read instead of refused and the file drawn as read; nothing AGMessage decides rests on a part being well-formed. |
| @xmldom/xmldom 0.8.6 | GHSA-wh4c-j3r5-mjhp, GHSA-2v35-w6hq-6mfw, GHSA-f6ww-3ggp-fr8h, GHSA-x6wf-f3px-wcqx, GHSA-j759-j44w-7fr8, GHSA-w2rr-34g9-rvrj, GHSA-4w3w-2rp5-g8jm, GHSA-c7q8-3ch8-vqpv, GHSA-27p8-2357-5qqv (high), GHSA-6gmq-8vp8-gcm6 (moderate): serializing a DOM, or building one to serialize | No | mammoth uses xmldom only to parse. It never serializes a DOM nor builds one with `createElement`, `setAttribute`, `createProcessingInstruction` or `createDocumentType` (it writes XML with xmlbuilder), and AGMessage never calls xmldom. |
| jszip 3.7.1 | GHSA-36fh-84j7-cv5h (moderate: path traversal through an entry's name) | No | It needs a program that writes a zip's entries to disk under their own names; mammoth reads the Word file's parts in memory, and nothing is written. |
| underscore 1.13.1 | GHSA-qpx9-hpmf-5gmw (high: unbounded recursion in `_.flatten` and `_.isEqual`) | No | mammoth flattens only lists its own readers build, flattened at each level, so the depth is fixed by its code, not by the document; it compares only a style map's flat attributes, and AGMessage passes no style map. |
