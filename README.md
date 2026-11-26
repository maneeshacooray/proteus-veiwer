# Proteus Viewer

A browser viewer for Proteus designs: the schematic and the PCB (top, bottom and individual layers).
Everything runs locally in the browser. Nothing is uploaded.

**Live:** https://maneeshacooray.github.io/proteus-veiwer/ (try [demo.zip](https://maneeshacooray.github.io/proteus-veiwer/demo.zip))

## Export from Proteus

| View | In Proteus |
|---|---|
| Schematic | Schematic Capture → **File → Print** to a PDF printer, or **File → Export Graphics → SVG/PDF** |
| PCB | PCB Layout → **Output → Generate Gerber/Excellon Files** (gives the `… - CADCAM Top Copper.GBR`, `… Drill.DRL` etc. set) |

You can also drop the `.pdsprj` itself, with no exports needed. The viewer reads Proteus's
undocumented binary schematic (`ROOT.DSN`) and layout (`ROOT.LYT`) with a reverse-engineered
parser (`src/dsn.js`, `src/lyt.js`) and draws the Schematic, PCB Top and PCB Bottom from them,
plus a Project tab with the parts list. Since the format was worked out from sample files, some
details can differ from Proteus (fonts, unusual graphics; the board outline is estimated from the
parts when none is found). Exported PDFs/Gerbers, when dropped in too, take precedence.

### What the reverse engineering found

- A `.pdsprj` is a ZIP: `ROOT.DSN`, `ROOT.LYT`, `ROOT.CDB` (parts DB), `PROJECT.XML`.
- Coordinates are int32 in 10 nm units (1 in = 2 540 000), Y up.
- Both files start with an embedded library (symbols / footprints): a Pascal-string name, a header
  ending in `[record count, 1]`, length-prefixed graphics records (line, box, circle, Bézier arc,
  text, markers), then pin or pad records.
- The schematic sheet follows `ISIS CIRCUIT FILE`: components `[u16 pins][name][x][y][rot 0.1°]`,
  wires (`WIRE` style + point list), terminals and text labels. Pin connection points come from
  the pin-style symbol's `$MKRNODE`; real pin numbers come from the `*PINOUT` blocks.
- The board holds placements `[x][y][rot | bottom flag][index][footprint]` and tracks
  `[net][segments][layer 0x00 top / 0x0f bottom]…[points]`.

See the comments at the top of `src/dsn.js` and `src/lyt.js` for the byte layouts.

### Verifying against real projects

`npm run verify -- a.pdsprj b.pdsprj … [--svg outdir]` parses each project and prints
self-consistency checks that only pass when the byte layouts are decoded correctly: pin ends that
land on wires, wire ends joined to a pin/terminal/wire, track ends that land on pads or tracks.

Checked against 12 public projects from GitHub (Proteus 8.x: PIC/AVR boards, a metal detector,
op-amp labs, a 555 timer, LED/7-segment demos) plus the original sample:

| Check | Result |
|---|---|
| Placed parts whose library symbol / footprint was found | 100% in every project |
| Wire ends connected to a pin, terminal or wire | 93–100% per project |
| Pin ends on a wire (unused pins legitimately miss) | 92–100% on most projects |
| PCB track ends on a pad or another track | 100% on all three routed boards |

Fixes this turned up: pin and placement rotations are signed 16-bit (−900 = −90°), pins carry
their own rotation + mirror, the pin count is the low 16 bits of its header word, and footprint
names must not be matched inside property text.


Drop a `.zip` of the CADCAM output (plus the schematic PDF if you like) onto the page, or use **Open files…**.

## Use

- Drag to pan, scroll to zoom, double-click or `F` to fit
- `1`–`5` switch between Project / Schematic / PCB Top / PCB Bottom / Layers
- In **Layers**, toggle each layer and change its colour

## Develop

```sh
npm install
npm run dev      # local dev server
npm run build    # dist/index.html: one self-contained file, open it straight from disk
```

`samples/` and `demo.zip` hold a tiny test board in Proteus CADCAM naming.

Gerber rendering: [tracespace](https://github.com/tracespace/tracespace). PDF: pdf.js.
Proteus file names are classified by `src/layers.js`, because tracespace doesn't recognise them.
