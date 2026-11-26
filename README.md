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
npm run verify -- a.pdsprj b.pdsprj [--svg outdir]   # check parser against real projects
```

Pushing to `main` deploys to GitHub Pages.

## Native format notes

A `.pdsprj` is a ZIP holding `ROOT.DSN` (schematic), `ROOT.LYT` (layout), `ROOT.CDB` (parts) and `PROJECT.XML`. The binary layouts are documented at the top of [`src/dsn.js`](src/dsn.js) and [`src/lyt.js`](src/lyt.js).

Verified against 12 public GitHub projects plus a private sample: 93–100% of wire ends and 100% of track ends on routed boards connect correctly.

**Not yet supported:** vias, copper pours, board-edge layer (the outline is estimated), bottom silk text. Exported PDFs/Gerbers take precedence when dropped alongside a `.pdsprj`.

## Tech

Vite + `vite-plugin-singlefile`, [tracespace](https://github.com/tracespace/tracespace) for Gerbers, pdf.js, JSZip.
