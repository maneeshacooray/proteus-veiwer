// Reads what can be read from a native Proteus project (.pdsprj).
//
// A .pdsprj is a ZIP containing:
//   PROJECT.XML  – release/version and timestamps
//   ROOT.DSN     – schematic ("ISIS SCHEMATIC FILE"), undocumented binary
//   ROOT.LYT     – PCB layout ("PCB LAYOUT FILE"), undocumented binary
//   ROOT.CDB     – parts database: length-prefixed strings + {KEY=VALUE} property blocks
//
// The schematic and layout drawings are binary records nobody has documented, so this
// extracts the readable parts (metadata, parts list, layer stack) rather than the geometry.

import JSZip from 'jszip'

const latin1 = new TextDecoder('windows-1252')

export async function readPdsprj(file) {
  const zip = await JSZip.loadAsync(file)
  const get = async (name) => {
    const entry = Object.values(zip.files).find((f) => f.name.toUpperCase() === name)
    return entry ? new Uint8Array(await entry.async('uint8array')) : null
  }

  const [xml, cdb, dsn, lyt] = await Promise.all(
    ['PROJECT.XML', 'ROOT.CDB', 'ROOT.DSN', 'ROOT.LYT'].map(get))

  return {
    name: file.name.replace(/\.pdsprj$/i, ''),
    files: Object.values(zip.files).filter((f) => !f.dir).map((f) => f.name),
    meta: xml ? parseProjectXml(latin1.decode(xml)) : {},
    parts: cdb ? parseParts(cdb) : [],
    hasSchematic: !!dsn && startsWith(dsn, 'ISIS SCHEMATIC FILE'),
    dsn,
    lyt,
    hasLayout: !!lyt && startsWith(lyt, 'PCB LAYOUT FILE'),
    layers: lyt ? parseLayers(lyt) : [],
  }
}

function startsWith(bytes, text) {
  return latin1.decode(bytes.subarray(0, text.length)) === text
}

function parseProjectXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  const ts = doc.querySelector('TIMESTAMP')
  if (!ts) return {}
  const date = (v) => (v ? new Date(Number(v) * 1000) : null)
  return {
    release: ts.getAttribute('RELEASE'),
    created: date(ts.getAttribute('CREATED')),
    modified: date(ts.getAttribute('MODIFIED')),
  }
}

const isText = (b) => b >= 0x20 && b < 0x7f

// Pascal-style string at i: [len][len printable bytes]. Returns [string, nextIndex] or null.
function pstr(d, i, { allowEmpty = false } = {}) {
  const len = d[i]
  if (len === undefined || len > 80 || (!allowEmpty && len === 0)) return null
  for (let k = 1; k <= len; k++) if (!isText(d[i + k])) return null
  return [latin1.decode(d.subarray(i + 1, i + 1 + len)), i + 1 + len]
}

/**
 * Part record layout seen in ROOT.CDB:
 *   pstr(name) 00 pstr(device) pstr(package) <1 byte> 00 00 00 "{KEY=VAL}\n…" 00
 */
function parseParts(d) {
  const parts = []
  for (let i = 0; i < d.length - 8; i++) {
    const a = pstr(d, i)
    if (!a || d[a[1]] !== 0) continue
    const b = pstr(d, a[1] + 1)
    if (!b) continue
    const c = pstr(d, b[1])
    if (!c) continue
    const p = c[1] + 1
    if (d[p] !== 0 || d[p + 1] !== 0 || d[p + 2] !== 0 || d[p + 3] !== 0x7b /* { */) continue

    let end = p + 3
    while (end < d.length && d[end] !== 0) end++
    const props = {}
    for (const m of latin1.decode(d.subarray(p + 3, end)).matchAll(/\{([^=}]+)=([^}]*)\}/g)) {
      props[m[1]] = m[2]
    }
    parts.push({ name: a[0], device: b[0], package: props.PACKAGE || c[0], props })
    i = end
  }
  return parts
}

// Layer stack: the layout's technology block lists "<kind>\0<name>" pairs such as "Copper", "Top Copper".
function parseLayers(d) {
  const text = latin1.decode(d.subarray(0, Math.min(d.length, 8192)))
  const names = new Set()
  for (const m of text.matchAll(/(Top|Bottom|Inner ?\d+|Internal ?\d+) (Copper|Resist|Silk|Paste|Mask)\w*/g)) {
    names.add(m[0])
  }
  return [...names]
}
