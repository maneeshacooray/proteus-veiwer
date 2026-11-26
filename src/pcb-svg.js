// Draws a parsed Proteus PCB layout (see lyt.js) as SVG, viewed from the top or the bottom.
import { placeTransform, UNITS_PER_INCH } from './lyt.js'
import { pathData } from './dsn.js'

const PX_PER_INCH = 300
const COLORS = {
  board: '#1f4d2b',
  edge: '#e8d44d',
  top: '#d9534f',
  bottom: '#4a7fd6',
  pad: '#c9a227',
  hole: '#111',
  silk: '#f2f2f2',
}

export function pcbToSvg(pcb, { side = 'top' } = {}) {
  const els = { bottom: [], top: [], pads: [], silk: [] }
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  const grow = (x, y, r = 0) => {
    box.minX = Math.min(box.minX, x - r); box.maxX = Math.max(box.maxX, x + r)
    box.minY = Math.min(box.minY, y - r); box.maxY = Math.max(box.maxY, y + r)
  }

  for (const t of pcb.tracks) {
    const pts = t.points.map(([x, y]) => (grow(x, y), `${f(x)},${f(-y)}`)).join(' ')
    const target = t.layer === 0 ? els.top : els.bottom // parser keeps only top (0) and bottom (15)
    target.push(`<polyline points="${pts}" fill="none" stroke-width="${f(Math.max(t.width, 2540 * 6))}" stroke-linecap="round" stroke-linejoin="round"><title>${esc(t.net)}</title></polyline>`)
  }

  for (const pl of pcb.placements) {
    const fp = pcb.footprints.get(pl.footprint)
    if (!fp) continue
    const T = (p) => placeTransform(p, pl)
    const silk = pl.bottom ? [] : els.silk // bottom-side silk is drawn only in the bottom view
    for (const g of fp.graphics) {
      const sw = f(Math.max(g.width || 0, 2540 * 6))
      if (g.type === 0) {
        const [a, b] = g.points.map(T)
        silk.push(`<line x1="${f(a[0])}" y1="${f(-a[1])}" x2="${f(b[0])}" y2="${f(-b[1])}" stroke-width="${sw}"/>`)
        grow(...a); grow(...b)
      } else if (g.type === 1) {
        const c = [[g.x, g.y], [g.x + g.w, g.y], [g.x + g.w, g.y + g.h], [g.x, g.y + g.h]].map(T)
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
      const st = pcb.padStyles.get(pad.style)?.w ? pcb.padStyles.get(pad.style) : pcb.padStyles.get(fallback)
      if (!st) continue
      const [x, y] = T([pad.x, pad.y])
      grow(x, y, Math.max(st.w, st.h) / 2)
      const square = /^S|SPAD|RSMPAD|SQ/.test(st.kind) || (pad.number === '1' && /SPDIL|DIL/.test(pad.style))
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
    if (pl.ref?.text && !pl.bottom) {
      const [x, y] = [pl.ref.x, pl.ref.y]
      els.silk.push(`<text x="${f(x)}" y="${f(-y)}" font-size="${f(0.05 * UNITS_PER_INCH)}" fill="${COLORS.silk}" stroke="none">${esc(pl.ref.text)}</text>`)
    }
  }

  for (const fp of pcb.freePads || []) {
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

  // Board shape: the drawn outline when it really encloses the parts, else the parts' extent.
  const o = pcb.outline
  const encloses = o && o.x <= box.minX && o.y <= box.minY && o.x + o.w >= box.maxX && o.y + o.h >= box.maxY
  const margin = 0.1 * UNITS_PER_INCH
  const b = encloses ? { x0: o.x, y0: o.y, x1: o.x + o.w, y1: o.y + o.h }
    : { x0: box.minX - margin, y0: box.minY - margin, x1: box.maxX + margin, y1: box.maxY + margin }
  const pad = 0.15 * UNITS_PER_INCH
  const vb = [b.x0 - pad, -(b.y1 + pad), b.x1 - b.x0 + 2 * pad, b.y1 - b.y0 + 2 * pad]
  const flip = side === 'bottom' ? ` transform="translate(${f(2 * vb[0] + vb[2])},0) scale(-1,1)"` : ''

  const copper = side === 'bottom'
    ? [g('top', els.top, 0.35), g('bottom', els.bottom, 0.95)]
    : [g('bottom', els.bottom, 0.45), g('top', els.top, 0.95)]

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.map(f).join(' ')}" width="${(vb[2] / UNITS_PER_INCH * PX_PER_INCH).toFixed(0)}" height="${(vb[3] / UNITS_PER_INCH * PX_PER_INCH).toFixed(0)}" font-family="Arial, Helvetica, sans-serif">
<g${flip}>
<rect x="${f(b.x0)}" y="${f(-b.y1)}" width="${f(b.x1 - b.x0)}" height="${f(b.y1 - b.y0)}" rx="${f(0.03 * UNITS_PER_INCH)}" fill="${COLORS.board}" stroke="${COLORS.edge}" stroke-width="${f(2540 * 8)}" ${encloses ? '' : 'stroke-dasharray="40 30"'}/>
${copper.join('\n')}
<g fill="${COLORS.pad}">${els.pads.join('')}</g>
${side === 'top' ? `<g stroke="${COLORS.silk}" fill="none" stroke-linecap="round">${els.silk.join('')}</g>` : ''}
</g>
</svg>`

  function g(name, list, opacity) {
    return `<g class="layer-${name}" stroke="${COLORS[name]}" opacity="${opacity}">${list.join('')}</g>`
  }
}

// mils, so browsers don't clamp font sizes
const f = (v) => +(v / 2540).toFixed(2)
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
