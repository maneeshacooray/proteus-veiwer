// Reverse-engineered reader for Proteus PCB layouts (ROOT.LYT inside a .pdsprj).
//
// Undocumented format, worked out from sample files; expect gaps. Coordinates are int32 in
// 10 nm units (1 inch = 2 540 000), Y up.
//
//   "PCB LAYOUT FILE" header, layer stack (Top Copper = 0x00, Bottom Copper = 0x0f, …),
//   pad / trace style tables as text ("C-55-32,CPAD,55th,55th,32th,…", "T10,10th").
//   Footprint library: pstr name, header ending [record count, 1], graphics records
//     (same record layout as ISIS), then pads: 8 flag bytes, x, y, 16 bytes,
//     8-byte pin number, pad-style name\0.
//   Board: placements [x][y][i16 rotation (0.1°), u16 flags (bit 0 = bottom side)][u32 index][pstr footprint],
//     tracks [pstr net][u32 segments n][layer][trace-style index][…variable…][n+1 points] ff ff ff ff
//       (trace styles are the ";TS" text table; the header length varies, so points are found from the terminator),
//     vias [u32][ff ff 00 80][u8 index into the pad/via style table][00][u8][x][y] (with a pad style:
//       a placed pin, giving its actual pad style),
//     free pads: like a placement but naming a pad style instead of a footprint,
//     board graphics [03][u32 layer][x][y][u32 rotation][graphics record relative to x,y]
//       (layer 28 board edge, 16 top silk, 17 bottom silk).

import { trailingString, boxCorners } from './dsn.js'
const dec = new TextDecoder('windows-1252')
export const UNITS_PER_INCH = 2540000
const TOP_COPPER = 0x00
const BOTTOM_COPPER = 0x0f
export const EDGE_LAYER = 28, TOP_SILK = 16, BOTTOM_SILK = 17

/** Corner/vertex points of a board graphic, for extents. */
export function shapePoints(g) {
  if (g.type === 2) return [[g.cx - g.r, g.cy - g.r], [g.cx + g.r, g.cy + g.r]]
  if (g.type === 4) return [[g.x, g.y]]
  return g.points || []
}

export function parseLyt(bytes) {
  const d = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength)
  const i32 = (o) => dv.getInt32(o, true)
  const u32 = (o) => dv.getUint32(o, true)

  if (str(d, 0, 15) !== 'PCB LAYOUT FILE') throw new Error('Not a Proteus PCB layout file')
  const text = dec.decode(d)

  /* ---------- styles ---------- */

  const padStyles = new Map()
  for (const m of text.matchAll(/(?:^|[\n\0])([A-Za-z0-9_.\-]+),([A-Z]+PAD),([^,\n]+),([^,\n]+),([^,\n]+),/g)) {
    if (!padStyles.has(m[1])) {
      padStyles.set(m[1], { kind: m[2], w: units(m[3]), h: units(m[4]), hole: units(m[5]) })
    }
  }
  // stacks: "NAME,STACK,HOLE,32th,0\n+ C-55-32\n+ <NONE>…" – use the first real pad style
  for (const m of text.matchAll(/(?:^|[\n\0])([A-Za-z0-9_.\-]+),STACK,HOLE,([^,\n]+)[^\n]*\n((?:\+ [^\n]*\n?)+)/g)) {
    const first = m[3].split('\n').map((l) => l.slice(2).trim()).find((n) => n && n !== '<NONE>')
    const base = padStyles.get(first)
    if (base && !padStyles.has(m[1])) padStyles.set(m[1], { ...base, hole: units(m[2]) || base.hole })
  }

  // every pad/via/stack style in table order: vias refer to their style by this index
  const styleList = []
  {
    const seen = new Set()
    for (const m of text.matchAll(/(?:^|[\n\0])([^,\n\0]+),([A-Z]+PAD|[A-Z]+VIA|STACK),([^,\n]*),([^,\n]*),([^,\n]*)/g)) {
      if (seen.has(m[1])) continue
      seen.add(m[1])
      styleList.push({ name: m[1], kind: m[2], w: units(m[3]), h: units(m[4]), hole: units(m[5]) })
    }
  }

  // trace styles, in table order: tracks refer to them by index ("\n;TS\nDEFAULT,20th\nBRIDGE,25th\n…")
  const traceStyles = []
  const ts = text.indexOf('\n;TS\n')
  if (ts >= 0) {
    for (const line of text.slice(ts + 5, ts + 20000).split('\n')) {
      const m = /^([^,;*\0]+),([^,]+)$/.exec(line)
      if (!m) break
      traceStyles.push({ name: m[1], w: units(m[2]) })
    }
  }

  /* ---------- graphics records (shared layout with ISIS) ---------- */

  function readRecord(o, end) {
    if (o + 16 > end) return null
    const len = u32(o), len2 = u32(o + 4), type = d[o + 8]
    if (len < 40 || len > 4096 || o + len > end || d[o + 9] !== 2 || type > 15) return null
    // markers ($MKRORIGIN, $MKRREFERENCE…) can carry len2 > len
    if (type === 6 || type === 8) return { type, len }
    if (len2 > len) return null
    let p = o + 10, nameStart = -1
    for (; p < o + len - 2; p++) {
      if (d[p] === 0x02 && (d[p + 1] & 0x40) && isPrint(d[p + 2])) { nameStart = p + 2; break }
    }
    if (nameStart < 0) return { type: -1, len }
    let q = nameStart
    while (q < o + len && d[q] !== 0) q++
    const body = q + 1
    const sb = nameStart - 2 - 18
    const rec = { type, len, layer: u32(o + 10), width: i32(sb + 1) }
    const pts = (n) => Array.from({ length: n }, (_, k) => [i32(body + 8 * k), i32(body + 8 * k + 4)])
    if (type === 0) rec.points = pts(2)
    else if (type === 1) { rec.x = i32(body); rec.y = i32(body + 4); rec.angle = (((u32(body + 8) & 0xffff) << 16) >> 16) / 10; rec.w = i32(body + 12); rec.h = i32(body + 16) }
    else if (type === 2) { rec.cx = i32(body); rec.cy = i32(body + 4); rec.r = i32(body + 8) }
    else if (type === 3) rec.points = pts(4)
    else if (type === 4) { rec.x = i32(body); rec.y = i32(body + 4); rec.size = i32(body + 16); rec.text = trailingString(d, body, o + len) }
    else if (type === 7) { // path, see dsn.js
      const n = u32(body)
      if (n < 2 || n > 2000 || body + 22 + 10 * n > o + len) return { type: -1, len }
      rec.points = Array.from({ length: n }, (_, k) => [i32(body + 22 + 8 * k), i32(body + 26 + 8 * k)])
      rec.kinds = Array.from({ length: n }, (_, k) => d[body + 22 + 8 * n + 2 * k])
    }
    return rec
  }

  /* ---------- footprint library ---------- */

  const footprints = new Map()
  const padNames = new Set(padStyles.keys())
  let libEnd = 0x200
  let current = null
  const libAt = new Set()

  function tryFootprint(p) {
    const L = d[p]
    if (L < 2 || L > 40) return null
    // a real entry follows binary data; a length byte inside text (e.g. "\nY=-0.000mm") is a false hit
    if (p > 0 && (isPrint(d[p - 1]) || d[p - 1] === 0x0a)) return null
    for (let k = 1; k <= L; k++) if (!isPrint(d[p + k])) return null
    const h = p + 1 + L
    for (let words = 4; words <= 14; words++) {
      if (u32(h + 4 * (words - 1)) !== 1) continue
      const count = u32(h + 4 * (words - 2))
      if (count < 1 || count > 2000) continue
      let o = h + 4 * words
      const graphics = []
      let ok = true
      for (let k = 0; k < count; k++) {
        const r = readRecord(o, d.length)
        if (!r) { ok = false; break }
        graphics.push(r)
        o += r.len
      }
      if (ok) return { name: str(d, p + 1, L), graphics, pads: [], end: o }
    }
    return null
  }

  for (let p = 0x200; p < d.length - 64; p++) {
    const fp = tryFootprint(p)
    if (fp) {
      libAt.add(p)
      if (!footprints.has(fp.name)) footprints.set(fp.name, fp)
      current = footprints.get(fp.name)
      p = fp.end - 1
      libEnd = fp.end
      continue
    }
    // pad record ends in "<number, 8 bytes NUL padded><pad style>\0"
    if (current && d[p - 1] === 0 && isPrint(d[p])) {
      let e = p
      while (e < d.length && isPrint(d[e])) e++
      const name = str(d, p, e - p)
      if (d[e] === 0 && padNames.has(name) && p >= 40) {
        const num = str(d, p - 8, 8).replace(/\0.*$/s, '')
        if (num && /^[\x21-\x7e]+$/.test(num)) {
          current.pads.push({ number: num, x: i32(p - 32), y: i32(p - 28), style: name })
          p = e
        }
      }
    }
  }

  /* ---------- board ---------- */

  const placements = []
  const tracks = []
  const vias = []
  const freePads = []
  const pinPads = []
  const labels = []
  let outline = null

  for (let p = 0x200; p < d.length - 24; p++) {
    const L = d[p]
    if (L <= 40 && p >= 16) {
      const name = tryStr(d, p + 1, L)
      if (L >= 2 && name && footprints.has(name) && !libAt.has(p)) {
        const x = i32(p - 16), y = i32(p - 12), rotRaw = u32(p - 8)
        const ang = (rotRaw << 16) >> 16 // signed tenths of a degree (−900 = −90°)
        if (Math.abs(x) < 50 * UNITS_PER_INCH && Math.abs(y) < 50 * UNITS_PER_INCH && Math.abs(ang) <= 3600 && (rotRaw >>> 17) === 0) {
          const ref = readLabelAfter(p + 1 + L)
          placements.push({ footprint: name, x, y, rot: (((ang / 10) % 360) + 360) % 360, bottom: !!(rotRaw & 0x10000), ref })
        }
      } else if (L >= 2 && name && padStyles.has(name) && !libAt.has(p)) {
        // a pad placed on its own (mounting hole, test point): same layout as a placement,
        // with a pad-style name where the footprint name would be
        const x = i32(p - 16), y = i32(p - 12), rotRaw = u32(p - 8)
        const ang = (rotRaw << 16) >> 16
        if (Math.abs(x) < 50 * UNITS_PER_INCH && Math.abs(y) < 50 * UNITS_PER_INCH && (x || y) && Math.abs(ang) <= 3600 && (rotRaw >>> 17) === 0 && u32(p - 4) < 100000) {
          freePads.push({ style: name, x, y, rot: (((ang / 10) % 360) + 360) % 360 })
        }
      }
      // track: [pstr net (may be empty)][u32 n][layer][style][…][n+1 points] ffffffff
      if (name !== null && (L === 0 || /^[\x21-\x7e][\x20-\x7e]*$/.test(name))) {
        const o = p + 1 + L
        const n = u32(o)
        const layer = d[o + 4]
        // header length varies between Proteus versions; the n+1 points always end in ffffffff,
        // so find the start that puts the terminator exactly after them
        const styleOk = !traceStyles.length || d[o + 5] < traceStyles.length
        // layers: 0 top, 15 bottom, 1–14 inner. Inner-layer records without a net are other data.
        const inner = layer > TOP_COPPER && layer < BOTTOM_COPPER
        if (n >= 1 && n < 1000 && layer <= BOTTOM_COPPER && styleOk && !(inner && L === 0)) {
          let ps = -1
          for (let q = o + 18; q <= o + 40; q++) {
            const e = q + 8 * (n + 1)
            if (e + 4 > d.length || u32(e) !== 0xffffffff) continue
            // The terminator is 4 or (newer files) 8 bytes of ff, and a negative last y also ends in
            // ff, so measure the whole ff run: what is left over beyond the terminator belongs to y.
            let run = 0
            while (e + run < d.length && d[e + run] === 0xff) run++
            const term = run >= 8 ? 8 : 4
            q += run - term
            ps = q
            break
          }
          if (ps > 0) {
            const end = ps + 8 * (n + 1)
            const pts = []
            for (let k = 0; k <= n; k++) pts.push([i32(ps + 8 * k), i32(ps + 4 + 8 * k)])
            // real tracks: in range, never at the exact origin
            const sane = pts.every(([a, b]) => Math.abs(a) < 50 * UNITS_PER_INCH && Math.abs(b) < 50 * UNITS_PER_INCH &&
              !(Math.abs(a) < 2540 && Math.abs(b) < 2540))
            // a repeated point is harmless; a track that is nothing but one point is not a track
            for (let k = pts.length - 1; k > 0; k--) if (pts[k][0] === pts[k - 1][0] && pts[k][1] === pts[k - 1][1]) pts.splice(k, 1)
            if (sane && pts.length >= 2 && !(inner && pts.some(([a, b]) => Math.abs(a) < 2540 || Math.abs(b) < 2540))) {
              // two equal int32s in the header
              const raw = Array.from(d.subarray(o + 5, ps))
              const width = traceStyles[d[o + 5]]?.w || 10 * 2540
              tracks.push({ net: name, layer, width, style: traceStyles[d[o + 5]]?.name, raw, points: pts })
              p = end + 3
              continue
            }
          }
        }
      }
    }
    // via: [u32][ff ff 00 80][u8 style index → a *VIA style][00][u8 flags][x][y]
    if (d[p] === 0xff && d[p + 1] === 0xff && d[p + 2] === 0x00 && d[p + 3] === 0x80 && d[p + 5] === 0 && p + 15 < d.length) {
      const st = styleList[d[p + 4]]
      const x = i32(p + 7), y = i32(p + 11)
      if (st && Math.abs(x) < 50 * UNITS_PER_INCH && Math.abs(y) < 50 * UNITS_PER_INCH) {
        if (/VIA$/.test(st.kind)) vias.push({ x, y, d: st.w, hole: st.hole, style: st.name })
        // the same record with a pad style is a placed pin: its actual pad (overrides the footprint's)
        else pinPads.push({ x, y, style: st.name, net: u32(p + 28) === 1 && d[p + 32] ? tryStr(d, p + 33, d[p + 32]) : null })
        p += 14
        continue
      }
    }
  }

  const zones = parseZones()
  const graphics = parseBoardGraphics()
  const edge = graphics.filter((g) => g.layer === EDGE_LAYER)
  if (edge.length) {
    const pts = edge.flatMap(shapePoints)
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1])
    outline = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), shapes: edge }
  }

  return { padStyles, traceStyles, footprints, placements, freePads, pinPads, tracks, vias, zones, outline, graphics, labels }

  // Graphics placed on the board itself, moved from the record's local frame to board coordinates.
  function parseBoardGraphics() {
    const out = []
    for (let p = libEnd + 17; p < d.length - 48; p++) {
      if (d[p + 9] !== 2 || d[p - 17] !== 3) continue
      const layer = u32(p - 16)
      if (layer > 63) continue
      const ox = i32(p - 12), oy = i32(p - 8), rot = u32(p - 4)
      if (Math.abs(ox) > 50 * UNITS_PER_INCH || Math.abs(oy) > 50 * UNITS_PER_INCH || rot > 3600) continue
      const r = readRecord(p, d.length)
      if (!r || r.type < 0 || r.type === 6 || r.type === 8) continue
      const a = (rot / 10) * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a)
      const T = ([x, y]) => [Math.round(ox + x * c - y * sn), Math.round(oy + x * sn + y * c)]
      const g = { layer, type: r.type, width: r.width }
      if (r.type === 0 || r.type === 3 || r.type === 7) { g.points = r.points.map(T); if (r.kinds) g.kinds = r.kinds }
      else if (r.type === 1) g.points = boxCorners(r).map(T)
      else if (r.type === 2) { [g.cx, g.cy] = T([r.cx, r.cy]); g.r = Math.abs(r.r) }
      else if (r.type === 4) { [g.x, g.y] = T([r.x, r.y]); g.size = r.size; g.text = r.text; g.rot = rot / 10 }
      else continue
      out.push(g)
      p += r.len - 1
    }
    return out
  }


  // Copper zones (pours). Record: [net][00][01][layer][u32 len][outline as a path record body]
  // [net][boundary trace style][relief trace style][u32 clearance]…[outline again][islands…].
  // Proteus stores the computed fill as islands (outer polygon + holes); the copper is that area
  // plus half the boundary trace width all round.
  function parseZones() {
    const out = []
    const names = new Set(traceStyles.map((t) => t.name))
    const pstrAt = (q) => (d[q] >= 1 && d[q] <= 60 ? tryStr(d, q + 1, d[q]) : null)
    for (let p = 0x200; p < d.length - 64; p++) {
      const net = pstrAt(p)
      if (net === null) continue
      const q = p + 1 + net.length, bs = pstrAt(q)
      if (bs === null || !names.has(bs)) continue
      const r = q + 1 + bs.length, rs = pstrAt(r)
      if (rs === null || !names.has(rs)) continue
      // outline path ending exactly where the net name starts: [layer][u32 length = 26 + 10n][n][bbox][u16][pts][kinds]
      let layer = -1, outline = null
      for (let h = p - 40; h > Math.max(0, p - 40000); h--) {
        const n = u32(h + 4)
        if (n < 3 || n > 4000 || u32(h) !== 26 + 10 * n || h + 26 + 10 * n !== p) continue
        layer = d[h - 1]
        outline = Array.from({ length: n }, (_, k) => [i32(h + 26 + 8 * k), i32(h + 30 + 8 * k)])
        break
      }
      if (!outline || layer > BOTTOM_COPPER) continue
      const e = r + 1 + rs.length
      const clearance = u32(e)
      // fill: [u32 island count] then per island [outer polygon][u32 hole count][holes…],
      // each polygon [u32 n][n points] (n may be 0). Found a few bytes after the clearance.
      const xs = outline.map((q) => q[0]), ys = outline.map((q) => q[1])
      const box = [Math.min(...xs) - UNITS_PER_INCH, Math.max(...xs) + UNITS_PER_INCH, Math.min(...ys) - UNITS_PER_INCH, Math.max(...ys) + UNITS_PER_INCH]
      const poly = (s) => {
        const n = u32(s)
        if (n > 20000 || s + 4 + 8 * n > d.length) return null
        const pts = Array.from({ length: n }, (_, k) => [i32(s + 4 + 8 * k), i32(s + 8 + 8 * k)])
        return pts.every(([x, y]) => x > box[0] && x < box[1] && y > box[2] && y < box[3]) ? { pts, end: s + 4 + 8 * n } : null
      }
      const readFill = (o) => {
        const count = u32(o)
        if (count < 1 || count > 5000) return null
        const islands = []
        o += 4
        for (let k = 0; k < count; k++) {
          const outer = poly(o)
          if (!outer) return null
          const holes = u32(outer.end)
          if (holes > 10000) return null
          let s = outer.end + 4
          const hs = []
          for (let j = 0; j < holes; j++) { const hp = poly(s); if (!hp) return null; if (hp.pts.length >= 3) hs.push(hp.pts); s = hp.end }
          if (outer.pts.length >= 3) islands.push({ outer: outer.pts, holes: hs })
          o = s
        }
        return islands.length ? { islands, end: o } : null
      }
      let fill = null
      for (let s = e + 4; s < e + 64 && !fill; s++) fill = readFill(s)
      if (!fill) continue
      const islands = fill.islands, o = fill.end
      const bw = traceStyles.find((t) => t.name === bs)?.w || 0
      out.push({ net, layer, outline, boundaryWidth: bw, relief: rs, clearance, islands })
      p = o
    }
    return out
  }

  function readLabelAfter(o) {
    // "ff <pstr text> x y … Vector Font\0PART REFERENCE"
    if (d[o] !== 0xff) return null
    const tl = d[o + 1]
    const t = tryStr(d, o + 2, tl)
    if (t === null) return null
    const q = o + 2 + tl
    return { text: t, x: i32(q), y: i32(q + 4) }
  }
}

function units(s) {
  const m = /^\s*(-?[\d.]+)\s*(th|in|mm)?/.exec(s || '')
  if (!m) return 0
  const v = parseFloat(m[1])
  const u = m[2] || 'th'
  return Math.round(u === 'in' ? v * UNITS_PER_INCH : u === 'mm' ? v * 100000 : v * 2540)
}

const isPrint = (b) => b >= 0x20 && b < 0x7f
const str = (d, o, n) => dec.decode(d.subarray(o, o + n))
function tryStr(d, o, n) {
  if (o + n > d.length) return null
  for (let k = 0; k < n; k++) if (!isPrint(d[o + k])) return null
  return str(d, o, n)
}

/** Looks up the pad style a placed pin actually uses (per-pin overrides), by board position. */
export function pinStyleLookup(pcb) {
  const m = new Map()
  const key = (x, y) => `${Math.round(x / 2540)},${Math.round(y / 2540)}`
  for (const p of pcb.pinPads || []) m.set(key(p.x, p.y), p.style)
  return (x, y) => m.get(key(x, y))
}

/** Pad records that no footprint pin or free pad accounts for: stand-alone pads (mounting holes…). */
export function loosePads(pcb) {
  const key = (x, y) => `${Math.round(x / 2540)},${Math.round(y / 2540)}`
  const used = new Set((pcb.freePads || []).map((p) => key(p.x, p.y)))
  for (const pl of pcb.placements) {
    const fp = pcb.footprints.get(pl.footprint)
    if (fp) for (const pad of fp.pads) used.add(key(...placeTransform([pad.x, pad.y], pl)))
  }
  // keep only pads on the board: inside the outline, or near the parts when there is none
  const o = pcb.outline, m = UNITS_PER_INCH / 2
  const xs = pcb.placements.map((p) => p.x), ys = pcb.placements.map((p) => p.y)
  const box = o ? [o.x, o.y, o.x + o.w, o.y + o.h] : [Math.min(...xs) - m, Math.min(...ys) - m, Math.max(...xs) + m, Math.max(...ys) + m]
  return (pcb.pinPads || []).filter((p) => !used.has(key(p.x, p.y)) && !(Math.abs(p.x) < 2540 && Math.abs(p.y) < 2540) &&
    p.x >= box[0] && p.x <= box[2] && p.y >= box[1] && p.y <= box[3]).map((p) => ({ ...p, rot: 0 }))
}

/**
 * Thermal-relief spokes: pads on a pour's net that sit in a clearance hole of that pour are tied
 * to it by four spokes of the pour's relief trace width. Returns [{layer, width, a, b, net}].
 */
export function thermals(pcb) {
  const out = []
  if (!pcb.zones?.length) return out
  const key = (x, y) => `${Math.round(x / 2540)},${Math.round(y / 2540)}`
  const bottomAt = new Set(), quarterAt = new Set()
  for (const pl of pcb.placements) {
    const fp = pcb.footprints.get(pl.footprint)
    if (!fp) continue
    for (const pad of fp.pads) {
      const k = key(...placeTransform([pad.x, pad.y], pl))
      if (pl.bottom) bottomAt.add(k)
      if (Math.round(pl.rot / 90) % 2 === 1) quarterAt.add(k)
    }
  }
  const inside = (x, y, r) => {
    let c = false
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j]
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c
    }
    return c
  }
  for (const z of pcb.zones) {
    const width = pcb.traceStyles.find((t) => t.name === z.relief)?.w || z.boundaryWidth
    for (const p of pcb.pinPads || []) {
      if (p.net !== z.net) continue
      const st = pcb.padStyles.get(p.style)
      if (!st) continue
      const onLayer = st.hole ? true : z.layer === (bottomAt.has(key(p.x, p.y)) ? 15 : 0)
      if (!onLayer) continue
      const isl = z.islands.find((i) => inside(p.x, p.y, i.outer) && i.holes.some((h) => inside(p.x, p.y, h)))
      if (!isl) continue
      // a spoke is only made where it reaches poured copper (Proteus drops blocked ones)
      const inFill = (x, y) => z.islands.some((i) => inside(x, y, i.outer) && !i.holes.some((h) => inside(x, y, h)))
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const q = quarterAt.has(key(p.x, p.y))
        const half = (dx ? (q ? st.h : st.w) : (q ? st.w : st.h)) / 2
        const reach = half + z.clearance + z.boundaryWidth
        const probe = half + z.clearance + z.boundaryWidth / 2 + width
        if (!inFill(p.x + dx * probe, p.y + dy * probe)) continue
        out.push({ layer: z.layer, width, net: z.net, a: [p.x, p.y], b: [p.x + dx * reach, p.y + dy * reach] })
      }
    }
  }
  return out
}

export function placeTransform([x, y], pl) {
  const lx = pl.bottom ? -x : x
  const r = (pl.rot * Math.PI) / 180
  const c = Math.cos(r), s = Math.sin(r)
  return [pl.x + lx * c - y * s, pl.y + lx * s + y * c]
}
