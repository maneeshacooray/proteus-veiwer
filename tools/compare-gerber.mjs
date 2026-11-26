#!/usr/bin/env node
// Compares the reverse-engineered PCB parse of a .pdsprj with the Gerbers Proteus itself exported.
//
//   node tools/compare-gerber.mjs project.pdsprj gerberDir [--json] [--overlay out.svg]
//
// The Gerbers are the ground truth. Reports, after aligning the two coordinate systems:
//   holes   – drill holes that a parsed pad (or via) has at the same spot, and whether the size agrees
//   pads    – copper flashes matched by a parsed pad, and whether the pad size agrees
//   tracks  – share of Gerber track length (board edge and zone hatching set aside) that the parsed tracks cover on the same layer (recall),
//             share of parsed track length that is in the Gerber (precision), and width agreement
import fs from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'
import { parseLyt, placeTransform } from '../src/lyt.js'
import { classifyGerber } from '../src/layers.js'

const U = 2540000 // units per inch
const MIL = U / 1000
const [file, dir] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const asJson = process.argv.includes('--json')

/* ---------- ground truth: Gerber + Excellon ---------- */

function parseGerber(text) {
  let fmt = { int: 2, dec: 4 }, scale = U, ap = null, x = 0, y = 0, region = false
  const apertures = new Map(), flashes = [], draws = []
  for (let cmd of text.replace(/\r?\n/g, '').split('*')) {
    cmd = cmd.replace(/%/g, '').trim()
    let m
    if ((m = /^FS[LT]?A?X(\d)(\d)Y\d\d/.exec(cmd))) fmt = { int: +m[1], dec: +m[2] }
    else if (cmd === 'MOIN') scale = U
    else if (cmd === 'MOMM') scale = U / 25.4
    else if ((m = /^ADD(\d+)([A-Z]+),([\d.]+)(?:X([\d.]+))?/.exec(cmd))) {
      const w = +m[3] * scale, h = m[4] ? +m[4] * scale : w
      apertures.set(+m[1], { shape: m[2], w, h })
    } else if (cmd === 'G36') region = true
    else if (cmd === 'G37') region = false
    else if ((m = /^(?:G54)?D(\d+)$/.exec(cmd)) && +m[1] >= 10) ap = apertures.get(+m[1])
    else if ((m = /^(?:G0?[123])?(?:X([+-]?\d+(?:\.\d+)?))?(?:Y([+-]?\d+(?:\.\d+)?))?(?:I[+-]?\d+)?(?:J[+-]?\d+)?D0?([123])$/.exec(cmd))) {
      const nx = m[1] !== undefined ? num(m[1]) : x, ny = m[2] !== undefined ? num(m[2]) : y
      if (m[3] === '1' && !region && ap) draws.push({ a: [x, y], b: [nx, ny], w: ap.w })
      if (m[3] === '3' && ap) flashes.push({ x: nx, y: ny, ...ap })
      x = nx; y = ny
    }
  }
  return { flashes, draws }
  function num(s) {
    return (s.includes('.') ? parseFloat(s) : parseInt(s, 10) / 10 ** fmt.dec) * scale
  }
}

function parseDrill(text) {
  let scale = U, dec = 4
  const tools = new Map(), holes = []
  let tool = null
  for (const line of text.split(/\r?\n/)) {
    let m
    if (/^METRIC/.test(line)) { scale = U / 25.4; dec = 3 }
    else if (/^INCH/.test(line)) { scale = U; dec = 4 }
    else if ((m = /^T(\d+)C([\d.]+)/.exec(line))) tools.set(+m[1], +m[2] * scale)
    else if ((m = /^T(\d+)$/.exec(line))) tool = tools.get(+m[1])
    else if ((m = /^X([+-]?[\d.]+)Y([+-]?[\d.]+)/.exec(line))) {
      const n = (s) => (s.includes('.') ? parseFloat(s) : parseInt(s, 10) / 10 ** dec) * scale
      holes.push({ x: n(m[1]), y: n(m[2]), d: tool })
    }
  }
  return holes
}

/* ---------- parsed model ---------- */

async function model(file) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file))
  const f = Object.values(zip.files).find((x) => x.name.toUpperCase() === 'ROOT.LYT')
  const b = parseLyt(await f.async('uint8array'))
  const pads = []
  for (const pl of b.placements) {
    const fp = b.footprints.get(pl.footprint)
    if (!fp) continue
    for (const p of fp.pads) {
      const st = b.padStyles.get(p.style)
      const [x, y] = placeTransform([p.x, p.y], pl)
      const quarter = Math.round(pl.rot / 90) % 2 === 1
      pads.push({ x, y, w: st ? (quarter ? st.h : st.w) : 0, h: st ? (quarter ? st.w : st.h) : 0, hole: st?.hole || 0, ref: `${pl.ref?.text || pl.footprint}.${p.number}`, smd: st && !st.hole, style: p.style, fp: pl.footprint, rot: pl.rot })
    }
  }
  for (const fp of b.freePads || []) {
    const st = b.padStyles.get(fp.style)
    const quarter = Math.round(fp.rot / 90) % 2 === 1
    pads.push({ x: fp.x, y: fp.y, w: st ? (quarter ? st.h : st.w) : 0, h: st ? (quarter ? st.w : st.h) : 0, hole: st?.hole || 0, ref: `pad.${fp.style}`, smd: st && !st.hole, style: fp.style })
  }
  const segs = b.tracks.flatMap((t) => t.points.slice(1).map((q, i) => ({ a: t.points[i], b: q, w: t.width, side: t.layer === 0 ? 'top' : 'bottom' })))
  const vias = (b.vias || []).map((v) => ({ x: v.x, y: v.y, hole: v.hole || 0, w: v.d, h: v.d }))
  return { pads, segs, vias, placements: b.placements.length }
}

/* ---------- compare ---------- */

const m = await model(file)
const files = fs.readdirSync(dir)
const gt = { holes: [], flashes: { top: [], bottom: [] }, draws: { top: [], bottom: [] } }
for (const n of files) {
  const c = classifyGerber(n)
  if (!c || /read-?me/i.test(n)) continue
  const text = fs.readFileSync(path.join(dir, n), 'latin1')
  if (c.type === 'drill') {
    // newer Proteus writes drill data as a Gerber X2 file (flashes = holes)
    if (/^G04|%FS/m.test(text.slice(0, 2000))) gt.holes.push(...parseGerber(text).flashes.map((f) => ({ x: f.x, y: f.y, d: f.w })))
    else gt.holes.push(...parseDrill(text))
  }
  else if (c.type === 'copper' && (c.side === 'top' || c.side === 'bottom')) {
    const g = parseGerber(text)
    gt.flashes[c.side].push(...g.flashes)
    gt.draws[c.side].push(...g.draws)
  }
}

// Align: the offset most hole/flash pairs agree on (Gerber origin can differ from the design's).
const ref = gt.holes.length ? gt.holes : [...gt.flashes.top, ...gt.flashes.bottom]
const mine = m.pads.length ? m.pads : []
const votes = new Map()
for (const g of ref.slice(0, 400)) for (const p of mine.slice(0, 400)) {
  const k = `${Math.round((g.x - p.x) / MIL)},${Math.round((g.y - p.y) / MIL)}`
  votes.set(k, (votes.get(k) || 0) + 1)
}
// track vertices vote too, so a board whose pads are off can still be lined up by its copper
const gv = Object.values(gt.draws).flat().filter((d) => d.w >= 5 * MIL).flatMap((d) => [d.a, d.b])
const mv = m.segs.flatMap((s) => [s.a, s.b])
const sample = (arr, n) => arr.filter((_, i) => i % Math.max(1, Math.floor(arr.length / n)) === 0)
for (const g of sample(gv, 300)) for (const p of sample(mv, 300)) {
  const k = `${Math.round((g[0] - p[0]) / MIL)},${Math.round((g[1] - p[1]) / MIL)}`
  votes.set(k, (votes.get(k) || 0) + 1)
}
const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]
let [ox, oy] = best ? best[0].split(',').map((v) => +v * MIL) : [0, 0]
// refine: the coarse vote is on a 1 mil grid; take the median residual of close pairs (a few rounds)
for (let round = 0; round < 4; round++) {
  const dx = [], dy = []
  for (const g of ref.slice(0, 800)) {
    let bd = Infinity, bp = null
    for (const p of mine) { const dd = Math.hypot(g.x - p.x - ox, g.y - p.y - oy); if (dd < bd) { bd = dd; bp = p } }
    if (bp && bd < 25 * MIL) { dx.push(g.x - bp.x - ox); dy.push(g.y - bp.y - oy) }
  }
  if (dx.length < 5) break
  const med = (a) => a.sort((u, v) => u - v)[a.length >> 1]
  ox += med(dx); oy += med(dy)
}
const shift = (p) => ({ ...p, x: p.x + ox, y: p.y + oy })
const pads = m.pads.map(shift)
const vias = m.vias.map(shift)
const segs = m.segs.map((s) => ({ ...s, a: [s.a[0] + ox, s.a[1] + oy], b: [s.b[0] + ox, s.b[1] + oy] }))

const TOL = 3 * MIL
const near = (list, x, y) => {
  let bestD = Infinity, hit = null
  for (const q of list) { const d = Math.hypot(q.x - x, q.y - y); if (d < bestD) { bestD = d; hit = q } }
  return bestD <= TOL ? hit : null
}
const close = (a, b) => Math.abs(a - b) <= Math.max(2 * MIL, 0.05 * b)

// holes
const holeSrc = [...pads.filter((p) => p.hole), ...vias]
let hMatch = 0, hSize = 0
const unmatchedHoles = []
for (const h of gt.holes) {
  const p = near(holeSrc, h.x, h.y)
  if (p) { hMatch++; if (close(p.hole, h.d)) hSize++ } else unmatchedHoles.push(h)
}
// unmatched holes sitting on a track vertex are vias
const trackVerts = Object.values(gt.draws).flat().flatMap((d) => [d.a, d.b])
const viaHoles = unmatchedHoles.filter((h) => trackVerts.some(([x, y]) => Math.hypot(x - h.x, y - h.y) <= TOL))

// pads vs flashes (a via is also flashed on copper; don't count those)
let fTotal = 0, fMatch = 0, fSize = 0
const missedFlashes = []
for (const side of ['top', 'bottom']) for (const fl of gt.flashes[side]) {
  if (vias.length ? near(vias, fl.x, fl.y) : viaHoles.some((h) => Math.hypot(h.x - fl.x, h.y - fl.y) <= TOL)) continue
  fTotal++
  const p = near(pads, fl.x, fl.y)
  if (!p) { missedFlashes.push(fl); continue }
  fMatch++
  if ((close(p.w, fl.w) && close(p.h, fl.h)) || (close(p.w, fl.h) && close(p.h, fl.w))) fSize++
}
const extraPads = pads.filter((p) => !Object.values(gt.flashes).flat().some((fl) => Math.hypot(fl.x - p.x, fl.y - p.y) <= TOL))

// tracks: sample along segments
const STEP = 5 * MIL
function coverage(from, to, withWidth) {
  let total = 0, hit = 0, wOk = 0, wN = 0
  for (const s of from) {
    const L = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1])
    const n = Math.max(1, Math.round(L / STEP))
    const others = to.filter((t) => t.side === s.side)
    for (let k = 0; k <= n; k++) {
      const x = s.a[0] + ((s.b[0] - s.a[0]) * k) / n, y = s.a[1] + ((s.b[1] - s.a[1]) * k) / n
      total++
      let bestD = Infinity, bestT = null
      for (const t of others) { const d = distSeg([x, y], t.a, t.b); if (d < bestD) { bestD = d; bestT = t } }
      if (bestD <= TOL) {
        hit++
        if (withWidth) { wN++; if (close(bestT.w, s.w)) wOk++ }
      }
    }
  }
  return { total, hit, wOk, wN }
}
// Proteus repeats the board edge on every copper layer and draws copper zones as thin hatch
// strokes; neither is a track, so set them aside.
const key = (d) => [d.a, d.b].map((p) => p.map((v) => Math.round(v / MIL)).join(',')).sort().join(' ')
const onTop = new Set(gt.draws.top.map(key)), onBottom = new Set(gt.draws.bottom.map(key))
const isEdge = (d) => onTop.has(key(d)) && onBottom.has(key(d))
const isHatch = (d) => d.w < 5 * MIL
const allDraws = ['top', 'bottom'].flatMap((side) => gt.draws[side].map((d) => ({ ...d, side })))
const gtSegs = allDraws.filter((d) => !isEdge(d) && !isHatch(d))
const edgeSegs = allDraws.filter(isEdge).length, hatchSegs = allDraws.filter((d) => !isEdge(d) && isHatch(d)).length
const recall = coverage(gtSegs, segs, true)
const precision = coverage(segs, allDraws, false)
const widths = [...new Set(gtSegs.map((s) => +(s.w / MIL).toFixed(1)))].sort((a, b) => a - b)
const myWidths = [...new Set(segs.map((s) => +(s.w / MIL).toFixed(1)))].sort((a, b) => a - b)

const pct = (a, b) => (b ? Math.round((100 * a) / b) : null)
const report = {
  project: file.split('/').slice(-2).join('/'), tag: file.split('/').slice(-2)[0],
  offsetMil: [Math.round(ox / MIL), Math.round(oy / MIL)], alignVotes: best?.[1] || 0,
  holes: { gerber: gt.holes.length, matched: hMatch, pct: pct(hMatch, gt.holes.length), sizeOk: pct(hSize, hMatch), vias: viaHoles.length, otherMissed: unmatchedHoles.length - viaHoles.length },
  pads: { gerberFlashes: fTotal, matched: fMatch, pct: pct(fMatch, fTotal), sizeOk: pct(fSize, fMatch), parsedPads: pads.length, notInGerber: extraPads.length },
  tracks: { gerberSegs: gtSegs.length, edgeSegs, zoneHatchSegs: hatchSegs, parsedSegs: segs.length, recallPct: pct(recall.hit, recall.total), precisionPct: pct(precision.hit, precision.total), widthOk: pct(recall.wOk, recall.wN), gerberWidthsMil: widths, parsedWidthsMil: myWidths },
}
const ovIdx = process.argv.indexOf('--overlay')
if (ovIdx > 0) {
  // Gerber in red, parsed model in blue; both in mils, y flipped
  const F = (v) => (v / MIL).toFixed(1)
  const all = [...Object.values(gt.flashes).flat(), ...pads]
  const xs = all.map((p) => p.x), ys = all.map((p) => p.y)
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${F(x0 - 50 * MIL)} ${F(-y1 - 50 * MIL)} ${F(x1 - x0 + 100 * MIL)} ${F(y1 - y0 + 100 * MIL)}" width="1400"><rect x="-1e6" y="-1e6" width="2e6" height="2e6" fill="#fff"/>`]
  for (const d of gtSegs) out.push(`<line x1="${F(d.a[0])}" y1="${F(-d.a[1])}" x2="${F(d.b[0])}" y2="${F(-d.b[1])}" stroke="#f99" stroke-width="${F(d.w)}" stroke-linecap="round"/>`)
  for (const sg of segs) out.push(`<line x1="${F(sg.a[0])}" y1="${F(-sg.a[1])}" x2="${F(sg.b[0])}" y2="${F(-sg.b[1])}" stroke="#36c" stroke-width="${F(sg.w / 3)}" opacity=".8"/>`)
  for (const fl of Object.values(gt.flashes).flat()) out.push(`<rect x="${F(fl.x - fl.w / 2)}" y="${F(-fl.y - fl.h / 2)}" width="${F(fl.w)}" height="${F(fl.h)}" fill="#e33" opacity=".5"/>`)
  for (const p of pads) out.push(`<circle cx="${F(p.x)}" cy="${F(-p.y)}" r="${F(Math.max(8 * MIL, Math.min(p.w, p.h) / 4))}" fill="#14c"/>`)
  out.push('</svg>')
  fs.writeFileSync(process.argv[ovIdx + 1], out.join('\n'))
}
if (asJson) console.log(JSON.stringify(report))
else {
  console.log(JSON.stringify(report, null, 1))
  if (process.argv.includes('--details')) {
    console.log('missed flashes (sample):', missedFlashes.slice(0, 10).map((f) => `${(f.x / U).toFixed(3)},${(f.y / U).toFixed(3)} ${f.shape} ${(f.w / MIL).toFixed(0)}x${(f.h / MIL).toFixed(0)}`))
    console.log('pads not in gerber (sample):', extraPads.slice(0, 10).map((p) => `${p.ref} ${(p.x / U).toFixed(3)},${(p.y / U).toFixed(3)}`))
  }
}

function distSeg([px, py], [x1, y1], [x2, y2]) {
  const dx = x2 - x1, dy = y2 - y1
  const t = dx || dy ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy))) : 0
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}
