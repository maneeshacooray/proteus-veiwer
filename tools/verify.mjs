#!/usr/bin/env node
// Checks the reverse-engineered .pdsprj parsers against real projects.
//
//   node tools/verify.mjs a.pdsprj b.pdsprj …   [--svg outdir]
//
// For each project it parses ROOT.DSN / ROOT.LYT and reports self-consistency checks that only
// pass if the byte layouts were decoded correctly:
//   schematic: every placed part's device has a library symbol; pin ends land on wires;
//              wire ends land on a pin, a terminal or another wire
//   pcb:       every placement's footprint exists; track ends land on pads or other tracks
import fs from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'
import { parseDsn, transform, pinEnd } from '../src/dsn.js'
import { parseLyt, placeTransform } from '../src/lyt.js'
import { schematicToSvg } from '../src/schematic-svg.js'
import { pcbToSvg } from '../src/pcb-svg.js'

const args = process.argv.slice(2)
const svgIdx = args.indexOf('--svg')
const svgDir = svgIdx >= 0 ? args.splice(svgIdx, 2)[1] : null
const pct = (a, b) => (b ? `${a}/${b} (${Math.round((100 * a) / b)}%)` : '-')

for (const file of args) {
  const tag = path.basename(path.dirname(file)) + '/' + path.basename(file)
  let zip
  try {
    zip = await JSZip.loadAsync(fs.readFileSync(file))
  } catch (e) {
    console.log(`${tag}: not a zip (${e.message})`)
    continue
  }
  const get = async (n) => {
    const f = Object.values(zip.files).find((x) => x.name.toUpperCase() === n)
    return f ? f.async('uint8array') : null
  }
  const report = { file: tag }

  const dsn = await get('ROOT.DSN')
  if (dsn) {
    try {
      const s = parseDsn(dsn)
      const segs = s.wires.flatMap((w) => w.slice(1).map((q, i) => [w[i], q]))
      const onWire = (p) => segs.some(([a, b]) => onSeg(p, a, b))
      let pins = 0, pinsOnWire = 0, missingSym = 0
      const nodeEnds = new Set()
      for (const part of s.parts) {
        const sym = s.library.get(part.device)
        if (!sym) { missingSym++; continue }
        for (const pin of sym.pins) {
          const e = transform(pinEnd(pin, s.library), part)
          nodeEnds.add(e.join(','))
          pins++
          if (onWire(e)) pinsOnWire++
        }
      }
      for (const t of s.terminals) {
        const sym = s.library.get(t.symbol)
        for (const g of sym?.graphics || []) if (g.style === '$MKRNODE') nodeEnds.add(transform([g.x, g.y], t).join(','))
      }
      let ends = 0, endsOk = 0
      s.wires.forEach((w, wi) => {
        for (const e of [w[0], w[w.length - 1]]) {
          ends++
          if (nodeEnds.has(e.join(','))) { endsOk++; continue }
          if (s.wires.some((v, j) => j !== wi && v.slice(1).some((q, i) => onSeg(e, v[i], q)))) endsOk++
        }
      })
      Object.assign(report, {
        symbols: s.library.size, parts: s.parts.length, missingSym, wires: s.wires.length,
        terminals: s.terminals.length, pinsOnWire: pct(pinsOnWire, pins), wireEndsConnected: pct(endsOk, ends),
      })
      if (svgDir) fs.writeFileSync(path.join(svgDir, tag.replace(/\W+/g, '_') + '.sch.svg'), schematicToSvg(s))
    } catch (e) {
      report.dsnError = e.message
    }
  } else report.dsn = 'none'

  const lyt = await get('ROOT.LYT')
  if (lyt) {
    try {
      const b = parseLyt(lyt)
      const pads = []
      let missingFp = 0
      for (const pl of b.placements) {
        const fp = b.footprints.get(pl.footprint)
        if (!fp) { missingFp++; continue }
        for (const p of fp.pads) pads.push(placeTransform([p.x, p.y], pl))
      }
      const near = (a, list, tol) => list.some((q) => Math.hypot(a[0] - q[0], a[1] - q[1]) <= tol)
      const tsegs = b.tracks.flatMap((t) => t.points.slice(1).map((q, i) => [t.points[i], q]))
      let ends = 0, onPad = 0, onTrack = 0
      b.tracks.forEach((t) => {
        for (const e of [t.points[0], t.points[t.points.length - 1]]) {
          ends++
          if (near(e, pads, 2540 * 5)) onPad++
          else if (tsegs.some(([a, c]) => distSeg(e, a, c) < 2540 && !(a === e || c === e))) onTrack++
        }
      })
      Object.assign(report, {
        footprints: b.footprints.size, placements: b.placements.length, missingFp,
        tracks: b.tracks.length, layers: [...new Set(b.tracks.map((t) => t.layer))].join('/'),
        trackEndsOnPad: pct(onPad, ends), trackEndsOnTrack: onTrack, outline: b.outline ? 'yes' : 'no',
      })
      if (svgDir && b.placements.length) fs.writeFileSync(path.join(svgDir, tag.replace(/\W+/g, '_') + '.pcb.svg'), pcbToSvg(b))
    } catch (e) {
      report.lytError = e.message
    }
  } else report.lyt = 'none'

  console.log(JSON.stringify(report))
}

function onSeg([x, y], [x1, y1], [x2, y2]) {
  if (x1 === x2 && x === x1) return y >= Math.min(y1, y2) && y <= Math.max(y1, y2)
  if (y1 === y2 && y === y1) return x >= Math.min(x1, x2) && x <= Math.max(x1, x2)
  // diagonal wires
  const cross = (x - x1) * (y2 - y1) - (y - y1) * (x2 - x1)
  return cross === 0 && x >= Math.min(x1, x2) && x <= Math.max(x1, x2) && y >= Math.min(y1, y2) && y <= Math.max(y1, y2)
}

function distSeg([px, py], [x1, y1], [x2, y2]) {
  const dx = x2 - x1, dy = y2 - y1
  const t = dx || dy ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy))) : 0
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}
