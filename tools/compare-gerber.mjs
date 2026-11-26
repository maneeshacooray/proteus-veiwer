#!/usr/bin/env node
// Compares the reverse-engineered PCB parse of a .pdsprj with the Gerbers Proteus itself exported.
//
//   node tools/compare-gerber.mjs project.pdsprj gerberDir [--json] [--overlay out.svg]
//
// The Gerbers are the ground truth. Reports, after aligning the two coordinate systems:
//   holes   – drill holes that a parsed pad (or via) has at the same spot, and whether the size agrees
//   pads    – copper flashes matched by a parsed pad, and whether the pad size agrees
//   zones   – share of Proteus's pour hatching that falls inside the parsed pour fill
//   tracks  – share of Gerber track length (board edge and zone hatching set aside) that the parsed tracks cover on the same layer (recall),
//             share of parsed track length that is in the Gerber (precision), and width agreement
import fs from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'
import { parseLyt, placeTransform, pinStyleLookup, loosePads, thermals } from '../src/lyt.js'
import { classifyGerber } from '../src/layers.js'

const U = 2540000 // units per inch
const MIL = U / 1000
const [file, dir] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const asJson = process.argv.includes('--json')

/* ---------- ground truth: Gerber + Excellon ---------- */

function parseGerber(text) {
  let fmt = { int: 2, dec: 4 }, scale = U, ap = null, x = 0, y = 0, region = false
  const apertures = new Map(), flashes = [], draws = []
  const macros = new Map()
  let macro = null // aperture macro being read: extent of its primitives
  for (let cmd of text.replace(/\r?\n/g, '').split('*')) {
    cmd = cmd.replace(/%/g, '').trim()
    let m
    if (macro && /^\d+,/.test(cmd)) {
      // primitives: 1 circle (d, x, y), 4 outline (n, points…), 21 centre rect (w, h, x, y)
      const v = cmd.split(',').map(Number), b = macro.box
      const add = (x, y) => { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y) }
      if (v[0] === 1) { add(v[3] - v[2] / 2, v[4] - v[2] / 2); add(v[3] + v[2] / 2, v[4] + v[2] / 2) }
      else if (v[0] === 4) for (let k = 0; k <= v[2]; k++) add(v[3 + 2 * k], v[4 + 2 * k])
      else if (v[0] === 21) { add(v[4] - v[2] / 2, v[5] - v[3] / 2); add(v[4] + v[2] / 2, v[5] + v[3] / 2) }
      continue
    }
    macro = null
    if ((m = /^AM([\w.$]+)$/.exec(cmd))) { macro = { box: [Infinity, Infinity, -Infinity, -Infinity] }; macros.set(m[1], macro) }
    else if ((m = /^ADD(\d+)([A-Za-z_$][\w.$]*)$/.exec(cmd)) && macros.has(m[2])) {
      const b = macros.get(m[2]).box
      if (b[0] <= b[2]) apertures.set(+m[1], { shape: 'M', w: (b[2] - b[0]) * scale, h: (b[3] - b[1]) * scale })
    }
    else if ((m = /^FS[LT]?A?X(\d)(\d)Y\d\d/.exec(cmd))) fmt = { int: +m[1], dec: +m[2] }
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
  const pinStyle = pinStyleLookup(b)
  for (const pl of b.placements) {
    const fp = b.footprints.get(pl.footprint)
    if (!fp) continue
    for (const p of fp.pads) {
      const [x, y] = placeTransform([p.x, p.y], pl)
      const style = pinStyle(x, y) || p.style
      const st = b.padStyles.get(style)
      const quarter = Math.round(pl.rot / 90) % 2 === 1
      pads.push({ x, y, w: st ? (quarter ? st.h : st.w) : 0, h: st ? (quarter ? st.w : st.h) : 0, hole: st?.hole || 0, ref: `${pl.ref?.text || pl.footprint}.${p.number}`, smd: st && !st.hole, style, fp: pl.footprint, rot: pl.rot })
    }
  }
  for (const fp of [...(b.freePads || []), ...loosePads(b)]) {
    const st = b.padStyles.get(fp.style)
    const quarter = Math.round(fp.rot / 90) % 2 === 1
    pads.push({ x: fp.x, y: fp.y, w: st ? (quarter ? st.h : st.w) : 0, h: st ? (quarter ? st.w : st.h) : 0, hole: st?.hole || 0, ref: `pad.${fp.style}`, smd: st && !st.hole, style: fp.style })
  }
  const segs = b.tracks.flatMap((t) => t.points.slice(1).map((q, i) => ({ a: t.points[i], b: q, w: t.width, side: sideOf(t.layer) })))
  // zone fill outlines are stroked with the boundary width in the Gerber, so they count as copper strokes
  const zones = []
  for (const z of b.zones || []) for (const isl of z.islands) {
    const side = sideOf(z.layer), rings = [isl.outer, ...isl.holes]
    zones.push({ side, rings, w: z.boundaryWidth })
    for (const ring of rings) ring.forEach((p, i) => segs.push({ a: p, b: ring[(i + 1) % ring.length], w: z.boundaryWidth, side, zone: true }))
  }
  for (const t of thermals(b)) segs.push({ a: t.a, b: t.b, w: t.width, side: sideOf(t.layer), zone: true })
  const vias = (b.vias || []).map((v) => ({ x: v.x, y: v.y, hole: v.hole || 0, w: v.d, h: v.d }))
  return { pads, segs, vias, zones, placements: b.placements.length }
}

/* ---------- compare ---------- */

// LYT layer ids: 0 top, 15 bottom, 1–14 inner layers; Gerber inner files are numbered the same way
function sideOf(layer) { return layer === 0 ? 'top' : layer === 15 ? 'bottom' : 'in' + layer }
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
  else if (c.type === 'copper') {
    const side = c.side === 'inner' ? 'in' + (/inner\D*(\d+)/i.exec(n)?.[1] || 1) : c.side
    if (!['top', 'bottom'].includes(side) && !side.startsWith('in')) continue
    const g = parseGerber(text)
    gt.flashes[side] = (gt.flashes[side] || []).concat(g.flashes)
    gt.draws[side] = (gt.draws[side] || []).concat(g.draws)
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
const zones = m.zones.map((z) => ({ ...z, rings: z.rings.map((r) => r.map(([x, y]) => [x + ox, y + oy])) }))
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
const sizeMiss = new Map()
for (const side of ['top', 'bottom']) for (const fl of gt.flashes[side]) {
  if (vias.length ? near(vias, fl.x, fl.y) : viaHoles.some((h) => Math.hypot(h.x - fl.x, h.y - fl.y) <= TOL)) continue
  fTotal++
  const p = near(pads, fl.x, fl.y)
  if (!p) { missedFlashes.push(fl); continue }
  fMatch++
  if ((close(p.w, fl.w) && close(p.h, fl.h)) || (close(p.w, fl.h) && close(p.h, fl.w))) fSize++
  else { const k = `${p.style || p.ref} mine ${(p.w / MIL).toFixed(0)}x${(p.h / MIL).toFixed(0)} gerber ${fl.shape} ${(fl.w / MIL).toFixed(0)}x${(fl.h / MIL).toFixed(0)}`; sizeMiss.set(k, (sizeMiss.get(k) || 0) + 1) }
}
const extraPads = pads.filter((p) => !Object.values(gt.flashes).flat().some((fl) => Math.hypot(fl.x - p.x, fl.y - p.y) <= TOL))

// tracks: sample along segments
const STEP = 5 * MIL
const missed = []
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
      if (bestD > TOL && withWidth && missed.length < 4000) missed.push({ side: s.side, w: s.w, x, y })
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
const allDraws = Object.keys(gt.draws).flatMap((side) => gt.draws[side].map((d) => ({ ...d, side })))
const gtSegs = allDraws.filter((d) => !isEdge(d) && !isHatch(d))
const edgeSegs = allDraws.filter(isEdge).length, hatchSegs = allDraws.filter((d) => !isEdge(d) && isHatch(d)).length
const recall = coverage(gtSegs, segs, true)
const precision = coverage(segs, allDraws, false)
const perLayer = Object.fromEntries(Object.keys(gt.draws).map((side) => { const r = coverage(gtSegs.filter((d) => d.side === side), segs, false); return [side, r.total ? Math.round((100 * r.hit) / r.total) : null] }))
// pours: share of Proteus's hatch strokes (sampled) that fall inside a parsed fill area
const inRings = (x, y, rings) => {
  let c = false
  for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c
  }
  return c
}
let zTotal = 0, zHit = 0
for (const d of allDraws.filter((d) => !isEdge(d) && isHatch(d))) {
  const L = Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]), n = Math.max(1, Math.round(L / (25 * MIL)))
  for (let k = 0; k <= n; k++) {
    const x = d.a[0] + ((d.b[0] - d.a[0]) * k) / n, y = d.a[1] + ((d.b[1] - d.a[1]) * k) / n
    zTotal++
    if (zones.some((z) => z.side === d.side && (inRings(x, y, z.rings) || z.rings.some((r) => r.some((p, i) => distSeg([x, y], p, r[(i + 1) % r.length]) <= z.w / 2 + TOL))))) zHit++
  }
}
const widths = [...new Set(gtSegs.map((s) => +(s.w / MIL).toFixed(1)))].sort((a, b) => a - b)
const myWidths = [...new Set(segs.map((s) => +(s.w / MIL).toFixed(1)))].sort((a, b) => a - b)

const pct = (a, b) => (b ? Math.round((100 * a) / b) : null)
const report = {
  project: file.split('/').slice(-2).join('/'), tag: file.split('/').slice(-2)[0],
  offsetMil: [Math.round(ox / MIL), Math.round(oy / MIL)], alignVotes: best?.[1] || 0,
  holes: { gerber: gt.holes.length, matched: hMatch, pct: pct(hMatch, gt.holes.length), sizeOk: pct(hSize, hMatch), vias: viaHoles.length, otherMissed: unmatchedHoles.length - viaHoles.length },
  pads: { gerberFlashes: fTotal, matched: fMatch, pct: pct(fMatch, fTotal), sizeOk: pct(fSize, fMatch), parsedPads: pads.length, notInGerber: extraPads.length },
  zones: { parsed: zones.length, hatchSamples: zTotal, coveredPct: pct(zHit, zTotal) },
  tracks: { gerberSegs: gtSegs.length, edgeSegs, zoneHatchSegs: hatchSegs, parsedSegs: segs.length, recallPct: pct(recall.hit, recall.total), recallByLayer: perLayer, precisionPct: pct(precision.hit, precision.total), widthOk: pct(recall.wOk, recall.wN), gerberWidthsMil: widths, parsedWidthsMil: myWidths },
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
    const mb = new Map(); for (const q of missed) { const k = `${q.side} ${(q.w / MIL).toFixed(0)}th`; mb.set(k, (mb.get(k) || 0) + 1) }
    console.log('missed track samples by layer/width:', [...mb].sort((x, y) => y[1] - x[1]).slice(0, 8))
    const cl = []; for (const q of missed) if (!cl.some((c) => c.side === q.side && Math.hypot(c.x - q.x, c.y - q.y) < 100 * MIL)) cl.push(q)
    console.log('missed track places:', cl.slice(0, 12).map((q) => `${q.side} ${(q.w / MIL).toFixed(0)}th ${(q.x / U).toFixed(3)},${(q.y / U).toFixed(3)}`))
    console.log('size mismatches by style:', [...sizeMiss].sort((x, y) => y[1] - x[1]).slice(0, 12))
    console.log('pads not in gerber (sample):', extraPads.slice(0, 14).map((p) => `${p.ref} ${(p.w / MIL).toFixed(0)}x${(p.h / MIL).toFixed(0)} ${(p.x / U).toFixed(3)},${(p.y / U).toFixed(3)}`))
  }
}

function distSeg([px, py], [x1, y1], [x2, y2]) {
  const dx = x2 - x1, dy = y2 - y1
  const t = dx || dy ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy))) : 0
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}
