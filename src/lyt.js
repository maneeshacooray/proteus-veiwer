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
//     tracks [pstr net][u32 segments n][layer][…23 bytes…][n+1 points] ff ff ff ff,
//     board outline as a graphics box/lines outside any footprint.

const dec = new TextDecoder('windows-1252')
export const UNITS_PER_INCH = 2540000
const TOP_COPPER = 0x00
const BOTTOM_COPPER = 0x0f

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

  /* ---------- graphics records (shared layout with ISIS) ---------- */

  function readRecord(o, end) {
    if (o + 16 > end) return null
    const len = u32(o), len2 = u32(o + 4), type = d[o + 8]
    if (len < 40 || len > 4096 || len2 > len || o + len > end || d[o + 9] !== 2 || type > 15) return null
    if (type === 6 || type === 8) return { type, len }
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
    else if (type === 1) { rec.x = i32(body); rec.y = i32(body + 4); rec.w = i32(body + 12); rec.h = i32(body + 16) }
    else if (type === 2) { rec.cx = i32(body); rec.cy = i32(body + 4); rec.r = i32(body + 8) }
    else if (type === 3) rec.points = pts(4)
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
  const labels = []
  let outline = null

  for (let p = 0x200; p < d.length - 24; p++) {
    const L = d[p]
    if (L >= 2 && L <= 40 && p >= 16) {
      const name = tryStr(d, p + 1, L)
      if (name && footprints.has(name) && !libAt.has(p)) {
        const x = i32(p - 16), y = i32(p - 12), rotRaw = u32(p - 8)
        const ang = (rotRaw << 16) >> 16 // signed tenths of a degree (−900 = −90°)
        if (Math.abs(x) < 50 * UNITS_PER_INCH && Math.abs(y) < 50 * UNITS_PER_INCH && Math.abs(ang) <= 3600 && (rotRaw >>> 17) === 0) {
          const ref = readLabelAfter(p + 1 + L)
          placements.push({ footprint: name, x, y, rot: (((ang / 10) % 360) + 360) % 360, bottom: !!(rotRaw & 0x10000), ref })
        }
      }
      // track: [pstr net][u32 n][23 bytes][n+1 points] ffffffff
      if (name && /^[\x21-\x7e]+$/.test(name)) {
        const o = p + 1 + L
        const n = u32(o)
        const layer = d[o + 4]
        if (n >= 1 && n < 1000 && (layer === TOP_COPPER || layer === BOTTOM_COPPER || layer < 15)) {
          const end = o + 27 + 8 * (n + 1)
          if (end + 4 <= d.length && u32(end) === 0xffffffff) {
            const pts = []
            for (let k = 0; k <= n; k++) pts.push([i32(o + 27 + 8 * k), i32(o + 31 + 8 * k)])
            if (pts.every(([a, b]) => Math.abs(a) < 50 * UNITS_PER_INCH && Math.abs(b) < 50 * UNITS_PER_INCH)) {
              tracks.push({ net: name, layer, width: (d[o + 5] || 10) * 2540, points: pts })
              p = end + 3
              continue
            }
          }
        }
      }
    }
    // board outline: a graphics box outside the footprint library
    if (!outline && p > libEnd && d[p + 9] === 2 && d[p + 8] === 1) {
      const r = readRecord(p, d.length)
      if (r && r.type === 1 && r.w > 0 && r.h > 0) outline = r
    }
  }

  return { padStyles, footprints, placements, tracks, outline, labels }

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

export function placeTransform([x, y], pl) {
  const lx = pl.bottom ? -x : x
  const r = (pl.rot * Math.PI) / 180
  const c = Math.cos(r), s = Math.sin(r)
  return [pl.x + lx * c - y * s, pl.y + lx * s + y * c]
}
