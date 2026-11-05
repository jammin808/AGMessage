# Test fixtures

Files the tests read as bytes, each as it was made, with its SHA-256 (`.gitattributes` keeps every file here byte for
byte on every checkout). The Office files the tests need (Word, Excel and PowerPoint, with hidden parts and page breaks)
are built in the tests from XML (`test/helpers.js`), so none is kept here.

| File | How it was made | SHA-256 |
|---|---|---|
| `board-pack.fodt` | Written by hand as a flat OpenDocument text: six pages, each a heading and a paragraph, a page break before each heading but the first; page 3 holds a list and a 3 × 3 table, page 5 the word "quorum". The source of the two PDFs below. | `56fa590affa03c5a39223ec67dbf6a73ac8a5c8c0c56486a510e7c7452c808a6` |
| `board-pack-tagged.pdf` | `board-pack.fodt` exported by LibreOffice Writer 24.2.7.2: `soffice --headless --convert-to 'pdf:writer_pdf_Export:{"UseTaggedPDF":{"type":"boolean","value":"true"}}'`. Tagged: it has a structure tree. | `30eaf663e3258c451e573c7cd112e17fcf7b74cda5635ebd2de8ce5c67849228` |
| `board-pack-untagged.pdf` | The same export with `UseTaggedPDF` false: no structure tree. | `78f029a1378df8eba5e18784eb47c0fb484869653c86fcf7282d38590e796ac6` |
| `jpeg2000.pdf` | One page holding one picture compressed as JPEG 2000 (`/Filter /JPXDecode`): a 240 × 120 picture, blue with a yellow rectangle, written as a JP2 file by Pillow 12.3.0 with OpenJPEG 2.5.4 (lossless), and placed on a 612 × 792 page with the line "A JPEG 2000 picture above" by a PDF writer of a few lines (the PDF's objects written as text around the JP2 bytes). pdf.js 4.10.38 decodes JPEG 2000 only with WebAssembly in its worker, which `'wasm-unsafe-eval'` on that worker's own response allows (`lib/guard.js` `CSP_PDF_WORKER`). Before it, under the page's policy, the worker could not compile the decoder and the picture was left undrawn, the page's text drawn; with it, the picture draws on the panel and on a screen (the browser smoke). | `c595e479ab019e81fcd098330a81237fc35b85fdf02aaa260331ed6f9ca42fd6` |
