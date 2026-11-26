<p align="center"><img src="public/logo.svg" width="96" alt="Proteus Viewer logo"></p>

# Proteus Viewer

View Proteus Design Suite schematics and PCBs in the browser. Runs entirely client-side; nothing is uploaded.

**Live:** https://maneeshacooray.github.io/proteus-veiwer/ · try [demo.zip](https://maneeshacooray.github.io/proteus-veiwer/demo.zip)

## What you can open

- **`.pdsprj`** directly: schematic, PCB top/bottom and parts list, read with a reverse-engineered parser.
- **Exports**, for exact rendering:
  - Schematic: *File → Print* to PDF, or *Export Graphics* → SVG/PDF/PNG
  - PCB: *Output → Generate Gerber/Excellon Files*
- A `.zip` of any of the above.

Drag files onto the page. Keys `1`–`5` switch tabs; scroll to zoom, drag to pan.

## Develop

```sh
npm install
npm run dev      # local server
npm run build    # single self-contained dist/index.html
npm run verify -- a.pdsprj b.pdsprj [--svg outdir]   # parser self-checks
node tools/compare-gerber.mjs a.pdsprj gerberDir      # compare with Proteus's Gerbers
node tools/compare-pdf.mjs a.pdsprj schematic.pdf     # compare with Proteus's schematic PDF
```

Pushing to `main` deploys to GitHub Pages.

## Native format notes

A `.pdsprj` is a ZIP holding `ROOT.DSN` (schematic), `ROOT.LYT` (layout), `ROOT.CDB` (parts) and `PROJECT.XML`. The binary layouts are documented at the top of [`src/dsn.js`](src/dsn.js) and [`src/lyt.js`](src/lyt.js).

Checked against Proteus's own exports from 15 public GitHub boards (`tools/compare-gerber.mjs`, `tools/compare-pdf.mjs`):

| | Matches Proteus |
|---|---|
| Pad positions and sizes, drill holes | 100% on 9 of 13 boards, 93–98% on the rest |
| Copper (tracks, pours, thermal reliefs, all layers) | 99–100% on 11 of 13 boards, 95% on the other two |
| Track width | 99–100% |
| Part references on the schematic PDF | 86–100% |

Two boards whose Gerbers predate later edits were excluded.

**Limits:** pours are drawn as Proteus last filled them (it refills on export), boards with nothing on the board-edge layer (and very old files) get an outline estimated from the parts, and some per-pin pad rotations are approximate. Exported PDFs/Gerbers take precedence when dropped alongside a `.pdsprj`.

## Tech

Vite + `vite-plugin-singlefile`, [tracespace](https://github.com/tracespace/tracespace) for Gerbers, pdf.js, JSZip.
