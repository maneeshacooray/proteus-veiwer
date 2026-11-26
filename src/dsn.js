// Reverse-engineered reader for Proteus ISIS schematic files (ROOT.DSN inside a .pdsprj).
//
// Nothing here is documented by Labcenter; it was worked out from sample files and may be
// incomplete. Findings so far (all integers little-endian, coordinates int32 in 10 nm units,
// so 1 inch = 2 540 000, Y axis pointing up):
//
//   "ISIS SCHEMATIC FILE" header, design config, then a symbol library:
//     pstr name, header, `count` graphics records, then `pins` packed pin records.
//     Device symbols have an 8-word header [ts, size, size2, pins, 0x10001, ?, count, 1];
//     pin styles / markers / terminals a 4-word one [ts, size, count, 1].
//   Graphics record: u32 length, u32 ?, u8 type, u8 2, style block, 0x02, flags,
//     style name\0, then type-specific data:
//       0 line   x1 y1 x2 y2
//       1 box    x y, i16 rotation about (x, y) in 0.1° + u16 flags, w h
//       2 circle cx cy r
//       3 arc    cubic Bézier, 4 points
//       4 text   x y …, string at the end
//       6/8      marker (symbol origin, pin node, label anchors)
//       7 path   n, bbox, u16, n points, then (kind, flag) per point: 0 move, 1 line, 2 Bézier ×3
//   Pin record: 4 flag bytes, x, y, u16 rotation (0.1°), u16 mirror, style\0, name\0, number\0
//     (the pin-style symbol is mirrored in X first, then rotated)
//
//   "ISIS CIRCUIT FILE" / "OBJECT DATA": the sheet.
//     Component: u16 pin count, pstr device (= library symbol), x, y, u32 rotation (0.1°)
//     Sub-circuit: 0x05, box x1 y1 x2 y2, u16, 0xff + pstr reference; ports are $SCP… terminals.
//     Sheet drawing: 0x20, x, y, i16 rot, u16 mirror, then a graphics record styled "2D GRAPHIC".
//     Bus: as a wire, styled "BUS WIRE".
//     Wire: style block, "WIRE\0", 00 00, u16 point count, points. A net label on a wire is a label
//       record (style "WIRE LABEL") followed by the wire: 4 bytes, u16 point count, points
//     Terminal: x, y, u32 rotation, pstr "$TER…" (library symbol)
//     Label: 0xff, pstr text, x, y, …, "Default Font\0", style ("COMPONENT ID", …)

const dec = new TextDecoder('windows-1252')
export const UNITS_PER_INCH = 2540000

export function parseDsn(bytes) {
  const d = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength)
  const i32 = (o) => dv.getInt32(o, true)
  const u32 = (o) => dv.getUint32(o, true)
  const u16 = (o) => dv.getUint16(o, true)
  const i16 = (o) => dv.getInt16(o, true)

  if (str(d, 0, 19) !== 'ISIS SCHEMATIC FILE') throw new Error('Not an ISIS schematic file')
  const sheetStart = indexOf(d, enc('ISIS CIRCUIT FILE'))
  if (sheetStart < 0) throw new Error('No sheet ("ISIS CIRCUIT FILE") found in schematic')

  /* ---------- graphics records ---------- */

  function readRecord(o, end) {
    if (o + 16 > end) return null
    const len = u32(o)
    const len2 = u32(o + 4)
    const type = d[o + 8]
    if (len < 40 || len > 4096 || o + len > end || d[o + 9] !== 2 || type > 15) return null
    if (len2 > len && type !== 6 && type !== 8) return null // markers can carry len2 > len
    if (type === 6 || type === 8) {
      // marker: x, y at +16/+20, then its "$MKR…" name
      const m = indexOf(d, [0x24], o + 24, o + len)
      if (m < 0) return null
      let e = m
      while (e < o + len && d[e] !== 0) e++
      return { type, len, style: str(d, m, e - m), x: i32(o + 16), y: i32(o + 20) }
    }
    // style name: first printable run terminated by NUL after the style block
    let p = o + 10
    let nameStart = -1
    for (; p < o + len; p++) {
      if (d[p] === 0x02 && isPrint(d[p + 2]) && (d[p + 1] & 0x40)) { nameStart = p + 2; break }
    }
    if (nameStart < 0) return null
    let q = nameStart
    while (q < o + len && d[q] !== 0) q++
    const style = str(d, nameStart, q - nameStart).replace(/^[{}]/, '')
    const body = q + 1
    // style block just before the 0x02 marker: u8, width, COLORREF line, u8 fill?, COLORREF fill
    const sb = nameStart - 2 - 18
    const rec = {
      type, style, len,
      width: i32(sb + 1), color: colorref(d, sb + 5), filled: d[sb + 9] !== 0, fill: colorref(d, sb + 10),
    }
    const pts = (n) => Array.from({ length: n }, (_, k) => [i32(body + 8 * k), i32(body + 8 * k + 4)])
    switch (type) {
      case 0: rec.points = pts(2); break
      case 1: rec.x = i32(body); rec.y = i32(body + 4); rec.angle = i16(body + 8) / 10; rec.w = i32(body + 12); rec.h = i32(body + 16); break
      case 2: rec.cx = i32(body); rec.cy = i32(body + 4); rec.r = i32(body + 8); break
      case 3: rec.points = pts(4); break
      case 7: { // path: n, bbox, u16, n points, then (kind, flag) per point
        const n = u32(body)
        if (n < 2 || n > 2000 || body + 22 + 10 * n > o + len) return null
        rec.points = Array.from({ length: n }, (_, k) => [i32(body + 22 + 8 * k), i32(body + 26 + 8 * k)])
        rec.kinds = Array.from({ length: n }, (_, k) => d[body + 22 + 8 * n + 2 * k])
        break
      }
      case 4: {
        rec.x = i32(body); rec.y = i32(body + 4)
        rec.just = d[body + 10]
        rec.size = i32(body + 16)
        rec.text = trailingString(d, body, o + len)
        break
      }
    }
    return rec
  }

  /* ---------- library ---------- */

  const library = new Map()

  function tryEntry(p) {
    const L = d[p]
    if (L < 2 || L > 40) return null
    for (let k = 1; k <= L; k++) if (!isPrint(d[p + k])) return null
    const name = str(d, p + 1, L)
    const h = p + 1 + L
    for (const form of [8, 4]) {
      const words = Array.from({ length: form }, (_, k) => u32(h + 4 * k))
      if (words[form - 1] !== 1) continue
      const count = words[form - 2]
      const pins = form === 8 ? words[3] & 0xffff : 0 // high half: count of animation states
      if (count < 1 || count > 2000 || pins > 2000) continue
      let o = h + 4 * form
      const graphics = []
      let ok = true
      for (let k = 0; k < count; k++) {
        const r = readRecord(o, sheetStart)
        if (!r) { ok = false; break }
        graphics.push(r)
        o += r.len
      }
      if (!ok) continue
      const pinList = []
      for (let k = 0; k < pins && ok; k++) {
        const flags = d[o]
        const x = i32(o + 4), y = i32(o + 8)
        const rot = i16(o + 12) / 10
        const mirror = u16(o + 14) & 1
        let q = o + 16
        const strs = []
        for (let s = 0; s < 3; s++) {
          const st = q
          while (q < sheetStart && d[q] !== 0) q++
          strs.push(str(d, st, q - st))
          q++
        }
        if (!strs[0].startsWith('$')) { ok = false; break }
        pinList.push({ x, y, rot, mirror, style: strs[0], name: strs[1], number: strs[2], flags })
        o = q
      }
      if (!ok) continue
      return { name, graphics, pins: pinList, end: o }
    }
    return null
  }

  for (let p = 0x100; p < sheetStart; p++) {
    const e = tryEntry(p)
    if (e) {
      if (!library.has(e.name)) library.set(e.name, e)
      p = e.end - 1
    }
  }

  /* ---------- sheet ---------- */

  const wires = []
  const parts = []
  const terminals = []
  const labels = []
  const wireTag = enc('WIRE\0')
  const busTag = enc('BUS WIRE\0') // a bus: same record, thicker and blue
  // a design can have several sheets, each starting with its own "ISIS CIRCUIT FILE"
  const sheetStarts = []
  for (let q = sheetStart; q >= 0; q = indexOf(d, enc('ISIS CIRCUIT FILE'), q + 1)) sheetStarts.push(q)
  const sheetOf = (q) => { let k = 0; while (k + 1 < sheetStarts.length && sheetStarts[k + 1] <= q) k++; return k }

  for (let p = sheetStart; p < d.length - 8; p++) {
    // wires
    const tag = d[p - 2] !== 0x02 ? 0 : d[p] === 0x57 && match(d, p, wireTag) ? wireTag.length : d[p] === 0x42 && match(d, p, busTag) ? busTag.length : 0
    if (tag) {
      const at = p + tag + 2 // after the style name: 00 00, u16 point count, points
      const n = u16(at)
      if (n >= 2 && n < 1000) {
        const pts = []
        for (let k = 0; k < n; k++) pts.push([i32(at + 2 + 8 * k), i32(at + 6 + 8 * k)])
        pts.color = colorref(d, p - 2 - 13)
        pts.width = i32(p - 2 - 17)
        pts.sheet = sheetOf(p)
        if (tag === busTag.length) pts.bus = true
        wires.push(pts)
        p = at + 2 + 8 * n - 1
        continue
      }
    }
    // pascal string naming a library symbol: component or terminal
    const L = d[p]
    if (L >= 2 && L <= 40 && isPrint(d[p + 1])) {
      const name = tryStr(d, p + 1, L)
      if (name && library.has(name)) {
        const sym = library.get(name)
        if (p >= 2 && u16(p - 2) === sym.pins.length && sym.pins.length > 0) {
          const o = p + 1 + L
          // the part's properties text (with its PACKAGE) sits just before the instance record
          const props = dec.decode(d.subarray(Math.max(sheetStart, p - 800), p))
          const pkg = [...props.matchAll(/\{PACKAGE=([^}]+)\}/g)].pop()?.[1]
          parts.push({ device: name, x: i32(o), y: i32(o + 4), rot: rotOf(i16(o + 8)), mirror: u16(o + 10), package: pkg, sheet: sheetOf(p) })
          p = o + 11
          continue
        }
        if ((name.startsWith('$TER') || name.startsWith('$SCP')) && p >= 12) { // terminals and sub-circuit ports
          terminals.push({ symbol: name, x: i32(p - 12), y: i32(p - 8), rot: rotOf(i16(p - 4)), mirror: u16(p - 2), sheet: sheetOf(p) })
          p += L
          continue
        }
      }
    }
    // labels: 0xff, pstr text, x, y … "Default Font\0<STYLE>\0"
    if (d[p] === 0xff && L !== undefined) {
      const tl = d[p + 1]
      const text = tl < 120 ? tryStr(d, p + 2, tl) : null
      if (text !== null) {
        const o = p + 2 + tl
        const font = indexOf(d, enc('Default Font\0'), o, o + 64)
        if (font > 0) {
          let e = font + 13
          while (d[e] !== 0 && e < d.length) e++
          const style = str(d, font + 13, e - font - 13)
          // just + text height sit between the coordinates and the font name
          const j = findJust(d, o + 12, font)
          labels.push({
            text, style, x: i32(o), y: i32(o + 4), rot: rotOf(i16(o + 8)),
            just: j.just, size: j.size || 254000, sheet: sheetOf(p),
          })
          p = e
          // a net label on a wire is followed by that wire: 4 bytes, u16 point count, points
          if (style === 'WIRE LABEL') {
            const n = u16(e + 5)
            const pts = []
            if (n >= 2 && n < 1000 && e + 7 + 8 * n <= d.length) for (let k = 0; k < n; k++) pts.push([i32(e + 7 + 8 * k), i32(e + 11 + 8 * k)])
            if (pts.length && pts.every(([x, y]) => Math.abs(x) < 60 * 2540000 && Math.abs(y) < 60 * 2540000)) {
              pts.sheet = sheetOf(p)
              pts.net = text // joined to the rest of its net by name, so a free end is fine
              wires.push(pts)
              p = e + 7 + 8 * n - 1
            }
          }
        }
      }
    }
  }

  // Sheet drawings (lines, boxes, circles, text drawn on the sheet itself, outside any part): ordinary
  // graphics records whose style is "2D GRAPHIC", each behind a 13-byte placement: 0x20, x, y, i16 rot,
  // u16 mirror. The record's own coordinates are relative to that placement.
  const graphics = []
  const g2d = enc('2D GRAPHIC\0')
  for (let q = indexOf(d, g2d, sheetStart); q >= 0; q = indexOf(d, g2d, q + 1)) {
    if (d[q - 2] !== 0x02) continue
    for (let o = q - 14; o >= q - 48; o--) {
      const r = u32(o) >= 40 && u32(o) <= 4096 && d[o + 9] === 2 && o + u32(o) > q ? readRecord(o, d.length) : null
      if (r && r.style === '2D GRAPHIC') { r.sheet = sheetOf(o); r.at = { x: i32(o - 12), y: i32(o - 8), rot: rotOf(i16(o - 4)), mirror: u16(o - 2) }; graphics.push(r); break }
    }
  }

  // Sub-circuit blocks: 0x05, box corners x1 y1 x2 y2, u16, 0xff + pstr reference, then its "SUBCKT ID" label.
  // Their ports are $SCP… terminals, picked up with the other terminals above.
  const subcircuits = []
  const sid = enc('SUBCKT ID\0')
  for (let q = indexOf(d, sid, sheetStart); q >= 0; q = indexOf(d, sid, q + 1)) {
    for (let o = q - 30; o >= Math.max(sheetStart, q - 160); o--) {
      if (d[o] !== 0x05 || d[o + 19] !== 0xff) continue
      const n = d[o + 20], name = tryStr(d, o + 21, n)
      if (!name || o + 21 + n > q) continue
      const [x1, y1, x2, y2] = [1, 5, 9, 13].map((k) => i32(o + k))
      if (!(x2 > x1 && y2 > y1 && x2 - x1 < 40 * 2540000 && y2 - y1 < 40 * 2540000)) continue
      if (!subcircuits.some((b) => b.x1 === x1 && b.y1 === y1 && b.sheet === sheetOf(o))) subcircuits.push({ name, x1, y1, x2, y2, sheet: sheetOf(o) })
      break
    }
  }

  // Package pinouts: "*PINOUT <pkg>\n{PIN "<name>" = <number>}…" text blocks
  const pinouts = new Map()
  const text = dec.decode(d)
  for (const m of text.matchAll(/\*PINOUT ([^\n]+)\n((?:\{[^}]*\}\n)+)/g)) {
    const map = {}
    for (const pm of m[2].matchAll(/\{PIN "([^"]*)" = ([^}]*)\}/g)) map[pm[1]] = pm[2].trim()
    if (!pinouts.has(m[1])) pinouts.set(m[1], map)
  }

  return { library, parts, wires, terminals, labels, graphics, subcircuits, pinouts }

  function findJust(d, from, to) {
    for (let q = from; q < to - 8; q++) {
      const v = d[q]
      if ((v & 0xf0) === 0x30 && d[q + 1] === 0 && d[q + 2] === 0 && d[q + 3] === 0) {
        return { just: v, size: i32(q + 4) }
      }
    }
    return { just: 0x31, size: 0 }
  }
}

function rotOf(v) {
  const a = (((Math.round(v / 10) % 360) + 360) % 360)
  return a
}

export function trailingString(d, from, end) {
  // last NUL-terminated printable run in [from, end)
  let e = end - 1
  while (e > from && d[e] === 0) e--
  let s = e
  while (s > from && isPrint(d[s - 1])) s--
  return str(d, s, e - s + 1)
}

const colorref = (d, o) => '#' + [d[o], d[o + 1], d[o + 2]].map((v) => v.toString(16).padStart(2, '0')).join('')
const isPrint = (b) => b >= 0x20 && b < 0x7f
const enc = (s) => Array.from(s, (c) => c.charCodeAt(0))
const str = (d, o, n) => dec.decode(d.subarray(o, o + n))

function tryStr(d, o, n) {
  for (let k = 0; k < n; k++) if (!isPrint(d[o + k])) return null
  return str(d, o, n)
}

function match(d, o, pat) {
  for (let k = 0; k < pat.length; k++) if (d[o + k] !== pat[k]) return false
  return true
}

function indexOf(d, pat, from = 0, to = d.length) {
  outer: for (let i = from; i <= to - pat.length; i++) {
    for (let k = 0; k < pat.length; k++) if (d[i + k] !== pat[k]) continue outer
    return i
  }
  return -1
}

/* ---------- geometry helpers shared with the renderer ---------- */

// Symbol → sheet: mirror (bit 0 = X, bit 1 = Y), then rotate, then translate.
export function transform([x, y], part) {
  if (part.mirror & 1) x = -x
  if (part.mirror & 2) y = -y
  const r = (part.rot * Math.PI) / 180
  const c = Math.round(Math.cos(r)), s = Math.round(Math.sin(r))
  return [part.x + x * c - y * s, part.y + x * s + y * c]
}

// Where a pin's connection node sits, in symbol coordinates.
export function pinEnd(pin, library) {
  const style = library.get(pin.style)
  const node = style?.graphics.find((g) => g.style === '$MKRNODE')
  const nx = node ? node.x : -508000
  const ny = node ? node.y : 0
  const [dx, dy] = orientVec(pin, nx, ny)
  return [pin.x + dx, pin.y + dy]
}

// Pin-style coordinates → symbol coordinates, relative to the pin's position.
export function orientVec(pin, x, y) {
  if (pin.mirror) x = -x
  const r = ((pin.rot || 0) * Math.PI) / 180
  const c = Math.round(Math.cos(r)), s = Math.round(Math.sin(r))
  return [x * c - y * s, x * s + y * c]
}

// SVG path data for a type-7 path record (kind per point: 0 move, 1 line, 2 Bézier in groups of 3)
/** Corners of a box record (rotated about its x, y corner by its own angle). */
export function boxCorners(g) {
  const a = ((g.angle || 0) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a)
  return [[0, 0], [g.w, 0], [g.w, g.h], [0, g.h]].map(([u, v]) => [g.x + u * c - v * s, g.y + u * s + v * c])
}

export function pathData(points, kinds, fmt) {
  let dd = ''
  for (let i = 0; i < points.length; i++) {
    const [x, y] = points[i]
    if (kinds[i] === 2 && i + 2 < points.length) {
      const [b, c] = [points[i + 1], points[i + 2]]
      dd += `C${fmt(x)},${fmt(-y)} ${fmt(b[0])},${fmt(-b[1])} ${fmt(c[0])},${fmt(-c[1])} `
      i += 2
    } else dd += `${i === 0 || kinds[i] === 0 ? 'M' : 'L'}${fmt(x)},${fmt(-y)} `
  }
  return dd.trim()
}
