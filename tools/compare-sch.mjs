#!/usr/bin/env node
// Compares the reverse-engineered schematic drawing of a .pdsprj with a schematic PDF that Proteus printed.
//
//   node tools/compare-sch.mjs project.pdsprj schematic.pdf [--json] [--overlay out.svg]
//
// Needs `pdftocairo` (poppler). Both drawings are reduced to line segments: the PDF page through
// pdftocairo's SVG output, ours from schematic-svg.js. Proteus prints text with its own stroked
// font, so most PDFs carry no text layer, and the alignment is found from the geometry: for each
// page rotation and scale, the offset most segment end points agree on, then refined.
// Reported per page (against the best-matching sheet), with distances in sheet mils:
//   pdfInk     – share of the PDF's drawing that ours covers (recall), split into long strokes
//                (wires, symbol bodies, pins) and short ones (mostly text)
//   ours       – share of each of our categories (wire, body, pin, junction) that the PDF has,
//                and of our text items with PDF ink where they sit (precision)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import JSZip from 'jszip'
import { parseDsn } from '../src/dsn.js'
import { schematicSheets } from '../src/schematic-svg.js'

const args = process.argv.slice(2)
const [file, pdf] = args.filter((a) => !a.startsWith('--') && !/\.svg$/.test(a))
const asJson = args.includes('--json')
const overlayAt = args.indexOf('--overlay')
const overlay = overlayAt >= 0 ? args[overlayAt + 1] : null
const TOL = 15 // mils
const STEP = 10 // mils between samples

/* ---------- minimal SVG → segments ---------- */

const I = [1, 0, 0, 1, 0, 0]
const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]]
const apply = (m, [x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
function parseTransform(t) {
  let m = I
  for (const [, fn, a] of (t || '').matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const v = a.split(/[\s,]+/).filter(Boolean).map(Number)
    let n = I
    if (fn === 'matrix') n = v
    else if (fn === 'translate') n = [1, 0, 0, 1, v[0], v[1] || 0]
    else if (fn === 'scale') n = [v[0], 0, 0, v[1] ?? v[0], 0, 0]
    else if (fn === 'rotate') {
      const r = (v[0] * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r)
      n = [c, s, -s, c, 0, 0]
      if (v.length === 3) n = mul(mul([1, 0, 0, 1, v[1], v[2]], n), [1, 0, 0, 1, -v[1], -v[2]])
    }
    m = mul(m, n)
  }
  return m
}
const attr = (s, name) => new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(s)?.[1]

function pathPolylines(d) {
  const out = []
  let cur = null, x = 0, y = 0, sx = 0, sy = 0
  const toks = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) || []
  let i = 0, cmd = ''
  const num = () => +toks[i++]
  while (i < toks.length) {
    if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++]
    const rel = cmd === cmd.toLowerCase()
    const C = cmd.toUpperCase()
    if (C === 'Z') { if (cur) cur.push([sx, sy]); x = sx; y = sy; cur = null; continue }
    if (C === 'M') { x = num() + (rel ? x : 0); y = num() + (rel ? y : 0); sx = x; sy = y; cur = [[x, y]]; out.push(cur); cmd = rel ? 'l' : 'L'; continue }
    if (!cur) { cur = [[x, y]]; out.push(cur) }
    if (C === 'L') { x = num() + (rel ? x : 0); y = num() + (rel ? y : 0); cur.push([x, y]) }
    else if (C === 'H') { x = num() + (rel ? x : 0); cur.push([x, y]) }
    else if (C === 'V') { y = num() + (rel ? y : 0); cur.push([x, y]) }
    else if (C === 'C') {
      const p = [x, y], q = [num(), num(), num(), num(), num(), num()]
      if (rel) for (let k = 0; k < 6; k++) q[k] += k % 2 ? y : x
      for (let k = 1; k <= 8; k++) {
        const t = k / 8, u = 1 - t
        cur.push([u * u * u * p[0] + 3 * u * u * t * q[0] + 3 * u * t * t * q[2] + t * t * t * q[4], u * u * u * p[1] + 3 * u * u * t * q[1] + 3 * u * t * t * q[3] + t * t * t * q[5]])
      }
      x = q[4]; y = q[5]
    } else { i++ } // unsupported command: skip a number
  }
  return out.filter((p) => p.length > 1)
}

/** Parses an SVG into {segs:[{a,b,k}], texts:[{x,y,w,h,k,s}], glyphs:[[x,y]], box}. */
function svgGeometry(svg, { ours = false } = {}) {
  const segs = [], texts = [], glyphs = []
  const stack = [{ m: I, cls: null }]
  let defs = 0
  const tagRe = /<(\/?)([a-zA-Z]+)((?:[^>"]|"[^"]*")*?)(\/?)>/g
  let t
  let lastText = null
  while ((t = tagRe.exec(svg))) {
    const [, close, name, rest, self] = t
    if (close) {
      if (name === 'defs' || name === 'clipPath' || name === 'symbol' || name === 'mask') { defs--; continue }
      if (defs > 0) continue
      if (name === 'g' || name === 'svg' || name === 'a') stack.pop()
      if (name === 'text' && lastText) { lastText.s = svg.slice(lastText.from, t.index).replace(/<[^>]*>/g, ''); finishText(lastText); lastText = null }
      continue
    }
    if (name === 'defs' || name === 'clipPath' || name === 'symbol' || name === 'mask') { if (!self) defs++; continue }
    if (defs > 0) continue
    const top = stack[stack.length - 1]
    const m = mul(top.m, parseTransform(attr(rest, 'transform')))
    const cls = attr(rest, 'class') || top.cls
    if (name === 'g' || name === 'svg' || name === 'a') { if (!self) stack.push({ m: name === 'svg' ? I : m, cls }); continue }
    const add = (pl, closed) => {
      const P = pl.map((p) => apply(m, p))
      if (closed) P.push(P[0])
      for (let k = 1; k < P.length; k++) segs.push({ a: P[k - 1], b: P[k], k: cls || 'ink', src: t.index })
    }
    const n = (a) => +(attr(rest, a) || 0)
    if (name === 'path') for (const pl of pathPolylines(attr(rest, 'd') || '')) add(pl, false)
    else if (name === 'line') add([[n('x1'), n('y1')], [n('x2'), n('y2')]], false)
    else if (name === 'polyline' || name === 'polygon') {
      const v = (attr(rest, 'points') || '').split(/[\s,]+/).filter(Boolean).map(Number)
      add(Array.from({ length: v.length >> 1 }, (_, k) => [v[2 * k], v[2 * k + 1]]), name === 'polygon')
    } else if (name === 'rect') {
      const x = n('x'), y = n('y'), w = n('width'), h = n('height')
      if (!ours) add([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], true)
    } else if (name === 'circle') {
      const cx = n('cx'), cy = n('cy'), r = n('r')
      add(Array.from({ length: 16 }, (_, k) => [cx + r * Math.cos((k * Math.PI) / 8), cy + r * Math.sin((k * Math.PI) / 8)]), true)
    } else if (name === 'use') glyphs.push(apply(m, [n('x'), n('y')]))
    else if (name === 'text' && !self) {
      lastText = { from: t.index + t[0].length, x: n('x'), y: n('y'), size: n('font-size'), anchor: attr(rest, 'text-anchor') || 'start', base: attr(rest, 'dominant-baseline') || 'auto', m, k: cls || 'text' }
    }
  }
  function finishText(o) {
    // box from the text's metrics (Proteus' stroke font is about 0.7 em wide per character)
    const w = 0.7 * o.size * [...o.s.replace(/̅/g, '')].length, h = o.size
    const x0 = o.anchor === 'middle' ? o.x - w / 2 : o.anchor === 'end' ? o.x - w : o.x
    const y0 = o.base === 'hanging' ? o.y : o.base === 'central' ? o.y - h / 2 : o.y - h
    const c = [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]].map((p) => apply(o.m, p))
    const xs = c.map((p) => p[0]), ys = c.map((p) => p[1])
    texts.push({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), k: o.k, s: o.s })
  }
  return { segs, texts, glyphs }
}

/* ---------- inputs ---------- */

const zip = await JSZip.loadAsync(fs.readFileSync(file))
const sch = parseDsn(await Object.values(zip.files).find((x) => x.name.toUpperCase() === 'ROOT.DSN').async('uint8array'))
const sheets = schematicSheets(sch).map((s) => ({ ...s, g: svgGeometry(s.svg, { ours: true }) }))

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmpsch-'))
const npages = +(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [pdf]).toString())?.[1] || 1)
const pages = []
for (let p = 1; p <= Math.min(npages, 12); p++) {
  const out = path.join(tmp, `p${p}.svg`)
  execFileSync('pdftocairo', ['-svg', '-f', String(p), '-l', String(p), pdf, out])
  const svg = fs.readFileSync(out, 'utf8')
  const vb = (attr(svg.slice(0, 600), 'viewBox') || '0 0 1000 1000').split(/\s+/).map(Number)
  const g = svgGeometry(svg)
  // drop page-sized frames and backgrounds: anything spanning most of the page
  const big = (s) => Math.abs(s.a[0] - s.b[0]) > 0.9 * vb[2] || Math.abs(s.a[1] - s.b[1]) > 0.9 * vb[3]
  g.segs = g.segs.filter((s) => !big(s))
  pages.push({ page: p, vb, g, svg: process.argv.includes('--details') ? svg : null })
}
fs.rmSync(tmp, { recursive: true, force: true })

/* ---------- geometry helpers ---------- */

const len = (s) => Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1])
function samples(segs, step) {
  const out = []
  for (const s of segs) {
    const n = Math.max(1, Math.round(len(s) / step))
    for (let k = 0; k <= n; k++) out.push({ x: s.a[0] + ((s.b[0] - s.a[0]) * k) / n, y: s.a[1] + ((s.b[1] - s.a[1]) * k) / n, s })
  }
  return out
}
class Grid {
  constructor(cell) { this.c = cell; this.m = new Map() }
  key(x, y) { return Math.floor(x / this.c) + ',' + Math.floor(y / this.c) }
  addSeg(s) {
    const x0 = Math.min(s.a[0], s.b[0]), x1 = Math.max(s.a[0], s.b[0]), y0 = Math.min(s.a[1], s.b[1]), y1 = Math.max(s.a[1], s.b[1])
    for (let i = Math.floor(x0 / this.c); i <= Math.floor(x1 / this.c); i++) for (let j = Math.floor(y0 / this.c); j <= Math.floor(y1 / this.c); j++) {
      const k = i + ',' + j
      if (!this.m.has(k)) this.m.set(k, [])
      this.m.get(k).push(s)
    }
  }
  near(x, y, tol) {
    const i0 = Math.floor((x - tol) / this.c), i1 = Math.floor((x + tol) / this.c), j0 = Math.floor((y - tol) / this.c), j1 = Math.floor((y + tol) / this.c)
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (const s of this.m.get(i + ',' + j) || []) if (distSeg([x, y], s.a, s.b) <= tol) return s
    return null
  }
}
function distSeg([px, py], [x1, y1], [x2, y2]) {
  const dx = x2 - x1, dy = y2 - y1
  const t = dx || dy ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy))) : 0
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}
const bboxOf = (segs) => {
  const b = [Infinity, Infinity, -Infinity, -Infinity]
  for (const s of segs) for (const p of [s.a, s.b]) { b[0] = Math.min(b[0], p[0]); b[1] = Math.min(b[1], p[1]); b[2] = Math.max(b[2], p[0]); b[3] = Math.max(b[3], p[1]) }
  return b
}
const ROT = [[1, 0, 0, 1], [0, -1, 1, 0], [-1, 0, 0, -1], [0, 1, -1, 0]] // 0, 90, 180, 270
const rot = (r, [x, y]) => [r[0] * x + r[1] * y, r[2] * x + r[3] * y]

/** Feature points: end points of the longer straight segments, de-duplicated on a grid. */
function features(segs, minLen, cell, max) {
  const seen = new Set(), out = []
  for (const s of segs) {
    if (len(s) < minLen) continue
    for (const p of [s.a, s.b]) {
      const k = Math.round(p[0] / cell) + ',' + Math.round(p[1] / cell)
      if (!seen.has(k)) { seen.add(k); out.push(p) }
    }
  }
  // spread evenly when there are too many
  if (out.length > max) { const step = out.length / max; return Array.from({ length: max }, (_, i) => out[Math.floor(i * step)]) }
  return out
}

/** Best transform pdf → ours: x' = s·R·x + t, by offset voting. Proteus prints 1:1 (1 pt = 1000/72 mil),
 *  so that scale is tried first; other printers may scale to fit, so a sweep follows if it fails. */
function align(ourSegs, pdfSegs) {
  const ob = bboxOf(ourSegs), pb = bboxOf(pdfSegs)
  const ow = ob[2] - ob[0], oh = ob[3] - ob[1]
  const A = features(ourSegs, 40, 5, 4000)
  const vote = (B, s, cell) => {
    const h = new Map()
    let top = { c: 0, k: '0,0' }
    for (const p of B) {
      const seen = new Set() // one vote per PDF point and offset cell
      for (const q of A) {
        const k = Math.round((q[0] - s * p[0]) / cell) + ',' + Math.round((q[1] - s * p[1]) / cell)
        if (seen.has(k)) continue
        seen.add(k)
        const c = (h.get(k) || 0) + 1
        h.set(k, c)
        if (c > top.c) top = { c, k }
      }
    }
    const [i, j] = top.k.split(',').map(Number)
    return { votes: top.c, t: [i * cell, j * cell], s }
  }
  const featsFor = (ri, s) => features(pdfSegs, 40 / s, 5 / s, 200).map((p) => rot(ROT[ri], p))
  const refine = (b) => {
    const B = featsFor(b.ri, b.s)
    for (let e = -0.03; e <= 0.0301; e += 0.003) { const v = vote(B, b.s * Math.exp(e), 10); if (v.votes > b.votes) b = { ...v, ri: b.ri } }
    return b
  }
  let best = null
  const ONE = 1000 / 72
  for (let ri = 0; ri < 4; ri++) for (const e of [-0.02, 0, 0.02]) {
    const v = vote(featsFor(ri, ONE), ONE * Math.exp(e), 20)
    if (!best || v.votes > best.votes) best = { ...v, ri }
  }
  if (best.votes >= 40) return refine(best)
  for (let ri = 0; ri < 4; ri++) {
    const [pw, ph] = ri % 2 ? [pb[3] - pb[1], pb[2] - pb[0]] : [pb[2] - pb[0], pb[3] - pb[1]]
    const s0 = Math.sqrt((ow * oh) / Math.max(1e-9, pw * ph))
    for (let e = -1.2; e <= 1.2001; e += 0.03) {
      const s = s0 * Math.exp(e)
      const v = vote(featsFor(ri, s), s, 20)
      if (v.votes > best.votes) best = { ...v, ri }
    }
  }
  return refine(best)
}

/* ---------- scoring ---------- */

function score(sheet, page) {
  const ours = sheet.g
  const al = align(ours.segs, page.g.segs)
  const R = ROT[al.ri]
  const T = (p) => { const q = rot(R, p); return [al.s * q[0] + al.t[0], al.s * q[1] + al.t[1]] }
  let pdfSegs = page.g.segs.map((s) => ({ a: T(s.a), b: T(s.b), k: 'pdf', src: s.src }))
  // median refinement of the offset from close pairs
  const og = new Grid(50)
  ours.segs.forEach((s) => og.addSeg(s))
  const dx = [], dy = []
  for (const p of features(pdfSegs, 40, 5, 2000)) {
    const s = og.near(p[0], p[1], 25)
    if (!s) continue
    for (const q of [s.a, s.b]) if (Math.hypot(q[0] - p[0], q[1] - p[1]) < 25) { dx.push(q[0] - p[0]); dy.push(q[1] - p[1]) }
  }
  const med = (v) => (v.length ? v.sort((a, b) => a - b)[v.length >> 1] : 0)
  const [mx, my] = [med(dx), med(dy)]
  pdfSegs = pdfSegs.map((s) => ({ ...s, a: [s.a[0] + mx, s.a[1] + my], b: [s.b[0] + mx, s.b[1] + my] }))
  const glyphs = page.g.glyphs.map((p) => { const q = T(p); return [q[0] + mx, q[1] + my] })

  const pg = new Grid(50)
  pdfSegs.forEach((s) => pg.addSeg(s))
  const inText = (x, y) => ours.texts.some((b) => x >= b.x0 - TOL && x <= b.x1 + TOL && y >= b.y0 - TOL && y <= b.y1 + TOL)

  // recall over the PDF's ink: long strokes (≥ 60 mil) vs short ones (mostly lettering)
  const rec = { long: [0, 0], short: [0, 0] }
  const missed = []
  for (const p of samples(pdfSegs, STEP)) {
    const kind = len(p.s) >= 60 ? 'long' : 'short'
    rec[kind][1]++
    if (og.near(p.x, p.y, TOL) || inText(p.x, p.y)) rec[kind][0]++
    else if (missed.length < 20000) missed.push(p)
  }
  // precision per category of ours
  const prec = {}
  for (const p of samples(ours.segs, STEP)) {
    const k = p.s.k
    prec[k] ||= [0, 0]
    prec[k][1]++
    if (pg.near(p.x, p.y, TOL)) prec[k][0]++
  }
  // text: an item counts when PDF ink (strokes or glyphs) falls inside its box
  const textHit = {}
  for (const b of ours.texts) {
    textHit[b.k] ||= [0, 0]
    textHit[b.k][1]++
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2, r = Math.max(b.x1 - b.x0, b.y1 - b.y0) / 2
    const ink = pg.near(cx, cy, r * 0.8) || glyphs.some(([x, y]) => x >= b.x0 - TOL && x <= b.x1 + TOL && y >= b.y0 - TOL && y <= b.y1 + TOL)
    if (ink) textHit[b.k][0]++
  }
  const pct = ([a, b]) => (b ? Math.round((100 * a) / b) : null)
  const total = rec.long[1] + rec.short[1]
  return {
    sheet: sheet.sheet + 1, page: page.page, rotation: al.ri * 90, scale: +al.s.toFixed(4), votes: al.votes,
    pdfInk: { all: pct([rec.long[0] + rec.short[0], total]), long: pct(rec.long), short: pct(rec.short) },
    ours: Object.fromEntries(Object.entries(prec).map(([k, v]) => [k, pct(v)])),
    text: Object.fromEntries(Object.entries(textHit).map(([k, v]) => [k, pct(v)])),
    _pdfSegs: pdfSegs, _missed: missed, _ours: ours,
  }
}

const results = []
for (const page of pages) {
  if (page.g.segs.length < 20) { results.push({ page: page.page, note: 'no vector drawing on this page' }); continue }
  let best = null
  for (const sheet of sheets) {
    if (!sheet.g.segs.length) continue
    const r = score(sheet, page)
    const key = (r.pdfInk.long || 0) + (r.ours.wire ?? r.ours.body ?? 0)
    if (!best || key > best.key) best = { ...r, key }
  }
  if (best) results.push(best)
}

if (overlay && results.find((r) => r._ours)) {
  // PDF in red, ours in blue, the PDF's uncovered ink in thick orange
  const r = results.filter((x) => x._ours).sort((a, b) => b.key - a.key)[0]
  const b = bboxOf(r._ours.segs)
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${b[0] - 200} ${b[1] - 200} ${b[2] - b[0] + 400} ${b[3] - b[1] + 400}" width="2000"><rect x="-1e6" y="-1e6" width="2e6" height="2e6" fill="#fff"/>`]
  const L = (s, c, w) => `<line x1="${s.a[0].toFixed(1)}" y1="${s.a[1].toFixed(1)}" x2="${s.b[0].toFixed(1)}" y2="${s.b[1].toFixed(1)}" stroke="${c}" stroke-width="${w}"/>`
  for (const s of r._pdfSegs) out.push(L(s, '#f55', 6))
  for (const s of r._ours.segs) out.push(L(s, '#25c', 3))
  for (const t of r._ours.texts) out.push(`<rect x="${t.x0}" y="${t.y0}" width="${t.x1 - t.x0}" height="${t.y1 - t.y0}" fill="none" stroke="#2a2" stroke-width="2"/>`)
  for (const p of r._missed) out.push(`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="7" fill="#f90" opacity=".6"/>`)
  out.push('</svg>')
  fs.writeFileSync(overlay, out.join('\n'))
}

if (args.includes('--details')) {
  // the PDF's long strokes ours doesn't cover, in sheet units (mils, y up) to look up in the DSN
  for (const r of results.filter((x) => x._missed)) {
    const segs = new Set(r._missed.filter((p) => len(p.s) >= 60).map((p) => p.s))
    const pg = pages.find((x) => x.page === r.page)
    const srcs = new Map()
    for (const p of r._missed) { const e = srcs.get(p.s.src) || { c: 0, x: 0, y: 0 }; e.c++; e.x += p.x; e.y += p.y; srcs.set(p.s.src, e) }
    console.error(`page ${r.page}: most-missed PDF elements:`, [...srcs].sort((a, b) => b[1].c - a[1].c).slice(0, 12).map(([i, e]) => `${e.c} × at (${Math.round(e.x / e.c)},${Math.round(-e.y / e.c)}) ` + (pg.svg.slice(i, i + 400).match(/ d="([^"]{0,90})/)?.[1] || pg.svg.slice(i, i + 80))).join('\n  '))
    console.error(`page ${r.page}: ${segs.size} missed long strokes`, [...segs].slice(0, 25).map((q) => `(${Math.round(q.a[0])},${Math.round(-q.a[1])})-(${Math.round(q.b[0])},${Math.round(-q.b[1])})`).join(' '))
  }
}
const clean = results.map(({ _pdfSegs, _missed, _ours, key, ...r }) => r)
const report = { project: file.split('/').slice(-2)[0], pdf: pdf.split('/').pop(), sheets: sheets.length, pages: clean }
console.log(asJson ? JSON.stringify(report) : JSON.stringify(report, null, 1))
