// Draws a parsed Proteus PCB layout (see lyt.js) as SVG, viewed from the top or the bottom.
import { placeTransform, pinStyleLookup, loosePads, thermals, UNITS_PER_INCH, TOP_SILK, BOTTOM_SILK } from './lyt.js'
import { pathData, boxCorners } from './dsn.js'

const PX_PER_INCH = 300
const COLORS = {
  board: '#1f4d2b',
  edge: '#e8d44d',
  top: '#d9534f',
  bottom: '#4a7fd6',
  inner: '#c0a040',
  pad: '#c9a227',
  hole: '#111',
  silk: '#f2f2f2',
}

export function pcbToSvg(pcb, { side = 'top' } = {}) {
  const els = { bottom: [], top: [], inner: [], pads: [], silk: [], silkBottom: [] }
  const zoneEls = { top: [], bottom: [], inner: [] }
  const layerName = (l) => (l === 0 ? 'top' : l === 15 ? 'bottom' : 'inner')
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  const grow = (x, y, r = 0) => {
    box.minX = Math.min(box.minX, x - r); box.maxX = Math.max(box.maxX, x + r)
    box.minY = Math.min(box.minY, y - r); box.maxY = Math.max(box.maxY, y + r)
  }

  // copper pours: stored fill area, stroked with the boundary trace width
  for (const z of pcb.zones || []) {
    const ring = (pts) => 'M' + pts.map(([x, y]) => `${f(x)},${f(-y)}`).join('L') + 'Z'
    for (const isl of z.islands) {
      isl.outer.forEach(([x, y]) => grow(x, y))
      const dd = ring(isl.outer) + isl.holes.map(ring).join('')
      zoneEls[layerName(z.layer)].push(`<path d="${dd}" fill-rule="evenodd" stroke-width="${f(Math.max(z.boundaryWidth, 2540))}" stroke-linejoin="round"><title>${esc(z.net)} pour</title></path>`)
    }
  }

  for (const t of thermals(pcb)) {
    zoneEls[layerName(t.layer)].push(`<line x1="${f(t.a[0])}" y1="${f(-t.a[1])}" x2="${f(t.b[0])}" y2="${f(-t.b[1])}" stroke-width="${f(t.width)}"/>`)
  }

  for (const t of pcb.tracks) {
    const pts = t.points.map(([x, y]) => (grow(x, y), `${f(x)},${f(-y)}`)).join(' ')
    const target = els[layerName(t.layer)]
    target.push(`<polyline points="${pts}" fill="none" stroke-width="${f(Math.max(t.width, 2540 * 6))}" stroke-linecap="round" stroke-linejoin="round"><title>${esc(t.net)}</title></polyline>`)
  }

  const pinStyle = pinStyleLookup(pcb)
  for (const pl of pcb.placements) {
    const fp = pcb.footprints.get(pl.footprint)
    if (!fp) continue
    const T = (p) => placeTransform(p, pl)
    const silk = pl.bottom ? els.silkBottom : els.silk // bottom-side silk is drawn only in the bottom view
    for (const g of fp.graphics) {
      const sw = f(Math.max(g.width || 0, 2540 * 6))
      if (g.type === 0) {
        const [a, b] = g.points.map(T)
        silk.push(`<line x1="${f(a[0])}" y1="${f(-a[1])}" x2="${f(b[0])}" y2="${f(-b[1])}" stroke-width="${sw}"/>`)
        grow(...a); grow(...b)
      } else if (g.type === 1) {
        const c = boxCorners(g).map(T)
        silk.push(`<polygon points="${c.map(([x, y]) => `${f(x)},${f(-y)}`).join(' ')}" fill="none" stroke-width="${sw}"/>`)
        c.forEach((p) => grow(...p))
      } else if (g.type === 2) {
        const [cx, cy] = T([g.cx, g.cy])
        silk.push(`<circle cx="${f(cx)}" cy="${f(-cy)}" r="${f(Math.abs(g.r))}" fill="none" stroke-width="${sw}"/>`)
      } else if (g.type === 3) {
        const [a, b, c, e] = g.points.map(T)
        silk.push(`<path d="M${f(a[0])},${f(-a[1])} C${f(b[0])},${f(-b[1])} ${f(c[0])},${f(-c[1])} ${f(e[0])},${f(-e[1])}" fill="none" stroke-width="${sw}"/>`)
      } else if (g.type === 7 && g.points) {
        const pts = g.points.map(T)
        silk.push(`<path d="${pathData(pts, g.kinds, f)}" fill="none" stroke-width="${sw}"/>`)
        pts.forEach((p) => grow(...p))
      }
    }
    const fallback = fp.pads.find((p) => pcb.padStyles.get(p.style)?.w)?.style
    for (const pad of fp.pads) {
      const [x, y] = T([pad.x, pad.y])
      const style = pinStyle(x, y) || pad.style
      const st = pcb.padStyles.get(style)?.w ? pcb.padStyles.get(style) : pcb.padStyles.get(fallback)
      if (!st) continue
      grow(x, y, Math.max(st.w, st.h) / 2)
      const square = /^S|SPAD|RSMPAD|SQ/.test(st.kind) || (pad.number === '1' && /SPDIL|DIL/.test(style))
      const rotated = ((pl.rot / 90) % 2) === 1
      const w = rotated ? st.h : st.w, h = rotated ? st.w : st.h
      const title = `<title>${esc(pl.ref?.text || pl.footprint)} pin ${esc(pad.number)}</title>`
      if (square) {
        els.pads.push(`<rect x="${f(x - w / 2)}" y="${f(-y - h / 2)}" width="${f(w)}" height="${f(h)}">${title}</rect>`)
      } else if (st.kind === 'DPAD' || w !== h) {
        const r = Math.min(w, h) / 2
        els.pads.push(`<rect x="${f(x - w / 2)}" y="${f(-y - h / 2)}" width="${f(w)}" height="${f(h)}" rx="${f(r)}">${title}</rect>`)
      } else {
        els.pads.push(`<circle cx="${f(x)}" cy="${f(-y)}" r="${f(w / 2)}">${title}</circle>`)
      }
      if (st.hole) els.pads.push(`<circle cx="${f(x)}" cy="${f(-y)}" r="${f(st.hole / 2)}" fill="${COLORS.hole}"/>`)
    }
    if (pl.ref?.text) (pl.bottom ? els.silkBottom : els.silk).push(text(pl.ref.x, pl.ref.y, pl.ref.text, 0.05 * UNITS_PER_INCH, pl.bottom))
  }

  for (const fp of [...(pcb.freePads || []), ...loosePads(pcb)]) {
    const st = pcb.padStyles.get(fp.style)
    if (!st) continue
    const quarter = Math.round(fp.rot / 90) % 2 === 1
    const w = quarter ? st.h : st.w, h = quarter ? st.w : st.h
    grow(fp.x, fp.y, Math.max(w, h) / 2)
    const sq = /^S|SPAD|RSMPAD|SQ/.test(st.kind)
    els.pads.push(sq || w !== h
      ? `<rect x="${f(fp.x - w / 2)}" y="${f(-fp.y - h / 2)}" width="${f(w)}" height="${f(h)}"${sq ? '' : ` rx="${f(Math.min(w, h) / 2)}"`}><title>pad ${esc(fp.style)}</title></rect>`
      : `<circle cx="${f(fp.x)}" cy="${f(-fp.y)}" r="${f(w / 2)}"><title>pad ${esc(fp.style)}</title></circle>`)
    if (st.hole) els.pads.push(`<circle cx="${f(fp.x)}" cy="${f(-fp.y)}" r="${f(st.hole / 2)}" fill="${COLORS.hole}"/>`)
  }
  for (const v of pcb.vias || []) {
    grow(v.x, v.y, v.d / 2)
    els.pads.push(`<circle cx="${f(v.x)}" cy="${f(-v.y)}" r="${f(v.d / 2)}"><title>via</title></circle>`)
    if (v.hole) els.pads.push(`<circle cx="${f(v.x)}" cy="${f(-v.y)}" r="${f(v.hole / 2)}" fill="${COLORS.hole}"/>`)
  }

  // silk drawn on the board itself (not part of a footprint)
  for (const gr of pcb.graphics || []) {
    if (gr.layer !== TOP_SILK && gr.layer !== BOTTOM_SILK) continue
    const list = gr.layer === TOP_SILK ? els.silk : els.silkBottom
    if (gr.type === 4) { if (gr.text) list.push(text(gr.x, gr.y, gr.text, gr.size || 0.05 * UNITS_PER_INCH, gr.layer === BOTTOM_SILK)) }
    else list.push(shapeSvg(gr, `fill="none" stroke-width="${f(Math.max(gr.width || 0, 2540 * 6))}"`))
  }

  // Board shape: the drawn outline when it really encloses the parts, else the parts' extent.
  const o = pcb.outline
  const slack = 0.05 * UNITS_PER_INCH
  const encloses = o && o.x <= box.minX + slack && o.y <= box.minY + slack && o.x + o.w >= box.maxX - slack && o.y + o.h >= box.maxY - slack
  const margin = 0.1 * UNITS_PER_INCH
  const b = encloses ? { x0: o.x, y0: o.y, x1: o.x + o.w, y1: o.y + o.h }
    : { x0: box.minX - margin, y0: box.minY - margin, x1: box.maxX + margin, y1: box.maxY + margin }
  // How the outline was found: 'edge' (board-edge layer), 'none' (the design has no board edge),
  // 'outside' (a board edge exists but doesn't contain the parts). The last two are estimated.
  const outlineStatus = encloses ? 'edge' : o ? 'outside' : 'none'
  const pad = 0.15 * UNITS_PER_INCH
  const capH = encloses ? 0 : 0.14 * UNITS_PER_INCH
  const vb = [b.x0 - pad, -(b.y1 + pad + capH), b.x1 - b.x0 + 2 * pad, b.y1 - b.y0 + 2 * pad + capH]
  const caption = encloses ? '' : `<text x="${f(b.x0)}" y="${f(-(b.y1 + pad * 0.6))}" font-size="${f(0.075 * UNITS_PER_INCH)}" fill="${COLORS.edge}">${
    outlineStatus === 'none' ? 'No board edge in this design: dashed outline estimated from the parts' : 'Board edge does not contain the parts: dashed outline estimated from the parts'}</text>`
  const flip = side === 'bottom' ? ` transform="translate(${f(2 * vb[0] + vb[2])},0) scale(-1,1)"` : ''

  const zone = (name, list, opacity) => `<g class="zone-${name}" fill="${COLORS[name]}" stroke="${COLORS[name]}" opacity="${opacity}">${list.join('')}</g>`
  const inner = [zone('inner', zoneEls.inner, 0.15), g('inner', els.inner, 0.4)]
  const copper = side === 'bottom'
    ? [zone('top', zoneEls.top, 0.2), g('top', els.top, 0.35), ...inner, zone('bottom', zoneEls.bottom, 0.55), g('bottom', els.bottom, 0.95)]
    : [zone('bottom', zoneEls.bottom, 0.25), g('bottom', els.bottom, 0.45), ...inner, zone('top', zoneEls.top, 0.55), g('top', els.top, 0.95)]
  const shape = encloses && o.shapes ? boardPath(o.shapes) : null

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.map(f).join(' ')}" width="${(vb[2] / UNITS_PER_INCH * PX_PER_INCH).toFixed(0)}" height="${(vb[3] / UNITS_PER_INCH * PX_PER_INCH).toFixed(0)}" font-family="Arial, Helvetica, sans-serif" data-outline="${outlineStatus}">
${caption}
<g${flip}>
${shape
    ? `<path d="${shape}" fill="${COLORS.board}" fill-rule="evenodd" stroke="${COLORS.edge}" stroke-width="${f(2540 * 8)}" stroke-linejoin="round"/>`
    : `<rect x="${f(b.x0)}" y="${f(-b.y1)}" width="${f(b.x1 - b.x0)}" height="${f(b.y1 - b.y0)}" rx="${f(0.03 * UNITS_PER_INCH)}" fill="${COLORS.board}" stroke="${COLORS.edge}" stroke-width="${f(2540 * 8)}" ${encloses ? '' : 'stroke-dasharray="40 30"'}/>`}
${copper.join('\n')}
<g fill="${COLORS.pad}">${els.pads.join('')}</g>
<g stroke="${COLORS.silk}" fill="none" stroke-linecap="round">${(side === 'top' ? els.silk : els.silkBottom).join('')}</g>
</g>
</svg>`

  function g(name, list, opacity) {
    return `<g class="layer-${name}" stroke="${COLORS[name]}" opacity="${opacity}">${list.join('')}</g>`
  }
}

// Silk text; bottom-side text is stored mirrored, so it reads correctly once the bottom view flips it.
function text(x, y, s, size, mirrored) {
  const t = `<text font-size="${f(size)}" fill="${COLORS.silk}" stroke="none">${esc(s)}</text>`
  return `<g transform="translate(${f(x)},${f(-y)})${mirrored ? ' scale(-1,1)' : ''}">${t}</g>`
}

// SVG for one board graphic (absolute coordinates, see lyt.js parseBoardGraphics)
function shapeSvg(g, attrs) {
  if (g.type === 2) return `<circle cx="${f(g.cx)}" cy="${f(-g.cy)}" r="${f(g.r)}" ${attrs}/>`
  return `<path d="${shapeD(g)}" ${attrs}/>`
}
function shapeD(g) {
  const P = ([x, y]) => `${f(x)},${f(-y)}`
  if (g.type === 0) return `M${P(g.points[0])}L${P(g.points[1])}`
  if (g.type === 1) return `M${g.points.map(P).join('L')}Z`
  if (g.type === 3) return `M${P(g.points[0])}C${g.points.slice(1).map(P).join(' ')}`
  if (g.type === 7) return pathData(g.points, g.kinds, f)
  if (g.type === 2) return `M${f(g.cx - g.r)},${f(-g.cy)}a${f(g.r)},${f(g.r)} 0 1,0 ${f(2 * g.r)},0a${f(g.r)},${f(g.r)} 0 1,0 ${f(-2 * g.r)},0Z`
  return ''
}

// Board-edge shapes as one fillable path: closed shapes as they are, open lines and curves
// chained end to end into loops.
function boardPath(shapes) {
  const parts = []
  const open = []
  for (const g of shapes) {
    if (g.type === 0 || g.type === 3) open.push(g.points)
    else if (g.type === 1 || g.type === 2 || g.type === 7) parts.push(shapeD(g))
  }
  const P = ([x, y]) => `${f(x)},${f(-y)}`
  const same = (a, b) => Math.abs(a[0] - b[0]) < 2540 && Math.abs(a[1] - b[1]) < 2540
  const seg = (pts) => (pts.length === 4 ? `C${pts.slice(1).map(P).join(' ')}` : `L${P(pts[pts.length - 1])}`)
  while (open.length) {
    let cur = open.shift()
    const start = cur[0]
    let d = `M${P(start)}${seg(cur)}`
    for (;;) {
      const end = cur[cur.length - 1]
      if (same(end, start)) break
      const i = open.findIndex((s) => same(s[0], end) || same(s[s.length - 1], end))
      if (i < 0) break
      cur = open.splice(i, 1)[0]
      if (!same(cur[0], end)) cur = [...cur].reverse()
      d += seg(cur)
    }
    parts.push(d + 'Z')
  }
  return parts.join('')
}

// mils, so browsers don't clamp font sizes
const f = (v) => +(v / 2540).toFixed(2)
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
