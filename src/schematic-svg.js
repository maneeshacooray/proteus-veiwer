// Draws a parsed ISIS schematic (see dsn.js) as SVG.
import { transform, orientVec, UNITS_PER_INCH } from './dsn.js'

const PX_PER_INCH = 150 // CSS pixels per schematic inch at zoom 1
const k = PX_PER_INCH / UNITS_PER_INCH
const MIN_STROKE = 0.006 * UNITS_PER_INCH

export function schematicToSvg(sch) {
  const out = []
  const box = bbox()

  // parts
  for (const part of sch.parts) {
    const sym = sch.library.get(part.device)
    if (!sym) continue
    const T = (p) => transform(p, part)
    drawGraphics(sym.graphics, T, part.rot)
    const pinout = part.package && sch.pinouts?.get(part.package)
    for (const pin of sym.pins) {
      if (pin.flags & 4) continue // hidden (power) pin
      let number = pin.number
      if (pinout) number = pinout[pin.name] && pinout[pin.name] !== '*' ? pinout[pin.name] : ''
      drawPin({ ...pin, number }, T, part.rot)
    }
  }

  // terminals (power, ground, labels)
  for (const t of sch.terminals) {
    const sym = sch.library.get(t.symbol)
    if (sym) drawGraphics(sym.graphics, (p) => transform(p, t), t.rot)
  }

  // wires and junction dots
  for (const w of sch.wires) {
    const pts = w.map(([x, y]) => `${f(x)},${f(-y)}`).join(' ')
    out.push(`<polyline points="${pts}" fill="none" stroke="${w.color || '#004000'}" stroke-width="${f(Math.max(w.width || 0, MIN_STROKE))}" stroke-linejoin="round" stroke-linecap="round"/>`)
    w.forEach(([x, y]) => grow(x, y))
  }
  for (const [x, y] of junctions(sch.wires)) {
    out.push(`<circle cx="${f(x)}" cy="${f(-y)}" r="${f(0.025 * UNITS_PER_INCH)}" fill="#004000"/>`)
  }

  // part reference / value labels and terminal labels
  for (const l of sch.labels) {
    if (!l.text || l.text.includes('<')) continue
    if (!['COMPONENT ID', 'COMPONENT VALUE', 'TERMINAL LABEL', 'WIRE LABEL'].includes(l.style)) continue
    text(l.text, l.x, l.y, l.size, l.just, l.rot, '#000')
  }

  const pad = 0.4 * UNITS_PER_INCH
  const [x0, y0, x1, y1] = [box.minX - pad, box.minY - pad, box.maxX + pad, box.maxY + pad]
  const vb = [x0, -y1, x1 - x0, y1 - y0]
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.map(f).join(' ')}" width="${(vb[2] * k).toFixed(0)}" height="${(vb[3] * k).toFixed(0)}" font-family="Arial, Helvetica, sans-serif">
<rect x="${f(vb[0])}" y="${f(vb[1])}" width="${f(vb[2])}" height="${f(vb[3])}" fill="#fffff4"/>
${out.join('\n')}
</svg>`

  /* ---------- helpers ---------- */

  function drawGraphics(graphics, T, rot) {
    for (const g of graphics) {
      if (g.type === 6 || g.type === 8 || g.style?.startsWith('$')) continue
      if (g.style === 'INDICATOR') continue // simulation-only readouts
      const stroke = g.color || '#800000'
      const sw = f(Math.max(g.width || 0, MIN_STROKE))
      const fill = g.filled ? g.fill : 'none'
      const common = `stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"`
      if (g.type === 0) {
        const [a, b] = g.points.map(T)
        out.push(`<line x1="${f(a[0])}" y1="${f(-a[1])}" x2="${f(b[0])}" y2="${f(-b[1])}" ${common}/>`)
        grow(...a); grow(...b)
      } else if (g.type === 1) {
        const c = [[g.x, g.y], [g.x + g.w, g.y], [g.x + g.w, g.y + g.h], [g.x, g.y + g.h]].map(T)
        out.push(`<polygon points="${c.map(([x, y]) => `${f(x)},${f(-y)}`).join(' ')}" fill="${fill}" ${common}/>`)
        c.forEach((p) => grow(...p))
      } else if (g.type === 2) {
        const [cx, cy] = T([g.cx, g.cy])
        out.push(`<circle cx="${f(cx)}" cy="${f(-cy)}" r="${f(Math.abs(g.r))}" fill="${fill}" ${common}/>`)
        grow(cx - g.r, cy - g.r); grow(cx + g.r, cy + g.r)
      } else if (g.type === 3) {
        const [a, b, c, e] = g.points.map(T)
        out.push(`<path d="M${f(a[0])},${f(-a[1])} C${f(b[0])},${f(-b[1])} ${f(c[0])},${f(-c[1])} ${f(e[0])},${f(-e[1])}" fill="none" ${common}/>`)
        grow(...a); grow(...e)
      } else if (g.type === 4 && g.text) {
        const [x, y] = T([g.x, g.y])
        text(g.text, x, y, g.size || 0.08 * UNITS_PER_INCH, g.just, rot, stroke)
      }
    }
  }

  function drawPin(pin, T, rot) {
    const style = sch.library.get(pin.style)
    const at = (lx, ly) => {
      const [dx, dy] = orientVec(pin, lx, ly)
      return T([pin.x + dx, pin.y + dy])
    }
    if (style) {
      for (const g of style.graphics) {
        if (g.type === 0) {
          const [a, b] = g.points.map(([x, y]) => at(x, y))
          out.push(`<line x1="${f(a[0])}" y1="${f(-a[1])}" x2="${f(b[0])}" y2="${f(-b[1])}" stroke="${g.color || '#800000'}" stroke-width="${f(Math.max(g.width || 0, MIN_STROKE))}" stroke-linecap="round"/>`)
          grow(...a); grow(...b)
        } else if (g.type === 2) {
          const [cx, cy] = at(g.cx, g.cy)
          out.push(`<circle cx="${f(cx)}" cy="${f(-cy)}" r="${f(Math.abs(g.r))}" fill="none" stroke="${g.color || '#800000'}" stroke-width="${f(MIN_STROKE)}"/>`)
        }
      }
    }
    const marker = (name) => style?.graphics.find((g) => g.style === name)
    const size = 0.08 * UNITS_PER_INCH
    // Direction the pin points away from the body, in sheet space, decides text alignment.
    const [ox, oy] = at(0, 0)
    const [ex, ey] = at(-1000, 0)
    const out_ = [Math.sign(ex - ox), Math.sign(ey - oy)]
    if (pin.flags & 1 && pin.name) {
      const m = marker('$MKRPINNAME')
      const [x, y] = at(m ? m.x : 0.05 * UNITS_PER_INCH, m ? m.y : 0)
      pinText(pin.name, x, y, size, out_, 'name')
    }
    if (pin.flags & 2 && pin.number) {
      const m = marker('$MKRPINNUM')
      const [x, y] = at(m ? m.x : -0.1 * UNITS_PER_INCH, m ? m.y : 0)
      pinText(pin.number, x, y + (out_[1] === 0 ? 0.02 * UNITS_PER_INCH : 0), size * 0.85, out_, 'num')
    }
  }

  function pinText(s, x, y, size, [dx, dy], kind) {
    // names sit inside the body (anchor away from the pin), numbers ride above the pin line
    const vertical = dx === 0
    let anchor = 'middle'
    let baseline = kind === 'num' ? 'auto' : 'central'
    if (!vertical) anchor = kind === 'num' ? 'middle' : dx < 0 ? 'start' : 'end'
    // $X$ marks an overbar in Proteus; draw it with combining overline characters
    const label = s.replace(/\$([^$]*)\$/g, (_, t) => [...t].map((c) => c + '\u0305').join(''))
    const over = ''
    const rot = vertical ? ` transform="rotate(-90 ${f(x)} ${f(-y)})"` : ''
    if (vertical) { anchor = kind === 'num' ? 'middle' : dy < 0 ? 'start' : 'end' }
    out.push(`<text x="${f(x)}" y="${f(-y)}" font-size="${f(size)}" text-anchor="${anchor}" dominant-baseline="${baseline}" fill="#000"${over}${rot}>${esc(label)}</text>`)
  }

  function text(s, x, y, size, just = 0x31, rot = 0, color = '#000') {
    // Low bits: 1 = top, 2 = bottom, 4 = middle (vertical); high nibble 3 = left aligned.
    const v = just & 0x07
    const baseline = v & 2 ? 'auto' : v & 4 ? 'central' : 'hanging'
    const h = just >> 4
    const anchor = h === 3 ? 'start' : h === 2 ? 'middle' : h === 1 ? 'end' : 'start'
    const r = rot === 90 || rot === 270 ? ` transform="rotate(-90 ${f(x)} ${f(-y)})"` : ''
    out.push(`<text x="${f(x)}" y="${f(-y)}" font-size="${f(size)}" text-anchor="${anchor}" dominant-baseline="${baseline}" fill="${color}"${r}>${esc(s)}</text>`)
    grow(x, y)
  }

  function bbox() {
    return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  }
  function grow(x, y) {
    if (x < box.minX) box.minX = x
    if (x > box.maxX) box.maxX = x
    if (y < box.minY) box.minY = y
    if (y > box.maxY) box.maxY = y
  }
}

// A dot wherever a wire end lands part-way along another wire, or three or more ends meet.
function junctions(wires) {
  const dots = new Map()
  const count = new Map()
  for (const w of wires) for (const e of [w[0], w[w.length - 1]]) {
    const key = e.join(',')
    count.set(key, (count.get(key) || 0) + 1)
  }
  for (const [key, n] of count) if (n >= 3) dots.set(key, key.split(',').map(Number))
  wires.forEach((w, wi) => {
    for (const e of [w[0], w[w.length - 1]]) {
      for (let j = 0; j < wires.length; j++) {
        if (j === wi) continue
        const v = wires[j]
        for (let i = 1; i < v.length; i++) {
          if (onSegmentInterior(e, v[i - 1], v[i]) || (i < v.length - 1 && e[0] === v[i][0] && e[1] === v[i][1])) {
            dots.set(e.join(','), e)
          }
        }
      }
    }
  })
  return [...dots.values()]
}

function onSegmentInterior([x, y], [x1, y1], [x2, y2]) {
  if (x1 === x2 && x === x1) return y > Math.min(y1, y2) && y < Math.max(y1, y2)
  if (y1 === y2 && y === y1) return x > Math.min(x1, x2) && x < Math.max(x1, x2)
  return false
}

// Emit coordinates in mils (1/1000 in): browsers cap absurd font sizes in raw 10 nm units.
const f = (v) => +(v / 2540).toFixed(2)
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
