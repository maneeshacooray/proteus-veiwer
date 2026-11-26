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
node tools/compare-pdf.mjs a.pdsprj schematic.pdf     # part references vs Proteus's schematic PDF
node tools/compare-sch.mjs a.pdsprj schematic.pdf [--details] [--overlay out.svg]  # line work vs the PDF
```

Pushing to `main` deploys to GitHub Pages.

## Native format notes

A `.pdsprj` is a ZIP holding `ROOT.DSN` (schematic), `ROOT.LYT` (layout), `ROOT.CDB` (parts) and `PROJECT.XML`. The binary layouts are documented at the top of [`src/dsn.js`](src/dsn.js) and [`src/lyt.js`](src/lyt.js).

Checked against Proteus's own exports from public GitHub projects (`tools/compare-gerber.mjs`, `tools/compare-sch.mjs`, `tools/compare-pdf.mjs`):

| | Matches Proteus |
|---|---|
| Pad positions and sizes, drill holes | 100% on 9 of 13 boards, 93–98% on the rest |
| Copper (tracks, pours, thermal reliefs, all layers) | 99–100% on 11 of 13 boards, 95% on the other two |
| Track width | 99–100% |
| Schematic drawing (symbols, pins, wires, buses, junctions) found in Proteus's PDF | 99–100% on all 20 pages (11 designs) |
| Proteus's schematic line work found in ours | 94–100% on 19 of 20 pages |
| Part references on the schematic PDF | 86–100% |

Boards and schematics whose exports predate later edits were excluded. `compare-sch` lines the PDF up with the drawing by voting over offsets at Proteus's 1:1 print scale, then scores both directions; `--details` names the PDF elements we miss most.

**Limits:** pours are drawn as Proteus last filled them (it refills on export), boards with nothing on the board-edge layer (and very old files) get an outline estimated from the parts, and some per-pin pad rotations are approximate. On schematics, the title-block template and fields (`@DTITLE`, `@PAGE`…) that Proteus fills in when printing aren't drawn, nor are simulation logic-state markers. Files saved by Proteus 9 use a new layout that isn't decoded yet; the viewer says so and asks for exports instead. Exported PDFs/Gerbers take precedence when dropped alongside a `.pdsprj`.

## Tech

Vite + `vite-plugin-singlefile`, [tracespace](https://github.com/tracespace/tracespace) for Gerbers, pdf.js, JSZip.
