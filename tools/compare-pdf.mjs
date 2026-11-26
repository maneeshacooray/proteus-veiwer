#!/usr/bin/env node
// Compares the reverse-engineered schematic parse of a .pdsprj with a schematic PDF Proteus printed.
//
//   node tools/compare-pdf.mjs project.pdsprj schematic.pdf [--json]
//
// Needs `pdftotext` (poppler). Takes the part references (R1, U3, …) in the PDF and in the parse,
// fits scale + offset on the ones that appear once in both, and reports:
//   found    – PDF references that the parse also has
//   placed   – of those, how many sit where the PDF has them (within 0.15 in on the sheet)
//   extra    – parsed references the PDF doesn't show
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import JSZip from 'jszip'
import { parseDsn } from '../src/dsn.js'

const U = 2540000
const [file, pdf] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const asJson = process.argv.includes('--json')
const REF = /^[A-Z]{1,4}\d{1,4}[A-Z]?$/

const zip = await JSZip.loadAsync(fs.readFileSync(file))
const sch = parseDsn(await Object.values(zip.files).find((x) => x.name.toUpperCase() === 'ROOT.DSN').async('uint8array'))
const allMine = sch.labels.filter((l) => /COMPONENT ID/.test(l.style) && REF.test(l.text))
const sheetIds = [...new Set(allMine.map((l) => l.sheet || 0))]

// PDF words per page: <word xMin= yMin= xMax= yMax=>text</word>, in points
const html = execFileSync('pdftotext', ['-bbox', pdf, '-'], { maxBuffer: 1 << 28 }).toString()
const pages = html.split(/<page /).slice(1).map((pg) => [...pg.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)]
  .map((m) => ({ x: (+m[1] + +m[3]) / 2, y: (+m[2] + +m[4]) / 2, text: m[5] })).filter((w) => REF.test(w.text)))

const count = (list) => list.reduce((m, w) => m.set(w.text, (m.get(w.text) || 0) + 1), new Map())
let best = null
for (const sheet of sheetIds) {
const mine = allMine.filter((l) => (l.sheet || 0) === sheet)
const myCount = count(mine)
pages.forEach((words, pi) => {
  const pc = count(words)
  const pairs = words.filter((w) => pc.get(w.text) === 1 && myCount.get(w.text) === 1).map((w) => [mine.find((l) => l.text === w.text), w])
  if (pairs.length < 3) return
  // fit x' = s·x + tx, y' = −s·y + ty (sheet Y is up, PDF Y is down), robustly via medians
  const ss = []
  for (let i = 0; i < pairs.length; i++) for (let j = i + 1; j < Math.min(pairs.length, i + 30); j++) {
    const [a, A] = pairs[i], [b, B] = pairs[j]
    const dm = Math.hypot(a.x - b.x, a.y - b.y), dp = Math.hypot(A.x - B.x, A.y - B.y)
    if (dm > U / 2) ss.push(dp / dm)
  }
  const med = (v) => v.sort((p, q) => p - q)[v.length >> 1]
  const s = med(ss)
  const tx = med(pairs.map(([a, A]) => A.x - s * a.x)), ty = med(pairs.map(([a, A]) => A.y + s * a.y))
  const tol = 0.15 * U * s
  const within = pairs.filter(([a, A]) => Math.hypot(s * a.x + tx - A.x, -s * a.y + ty - A.y) <= tol).length
  if (!best || within > best.within) best = { page: pi + 1, sheet: sheet + 1, mine, words, pairs: pairs.length, within, s, tx, ty, tol }
})
}

const report = { project: file.split('/').slice(-2)[0], pdf: pdf.split('/').pop(), sheets: sheetIds.length, parsedRefs: allMine.length }
if (!best) report.note = 'no page shares 3+ unique references'
else {
  const pdfRefs = new Set(best.words.map((w) => w.text))
  const mine = best.mine
  const myRefs = new Set(mine.map((l) => l.text))
  // placed: every PDF reference with a parsed label of the same name near the fitted spot
  let placed = 0, found = 0
  for (const w of best.words) {
    const cands = mine.filter((l) => l.text === w.text)
    if (!cands.length) continue
    found++
    if (cands.some((l) => Math.hypot(best.s * l.x + best.tx - w.x, -best.s * l.y + best.ty - w.y) <= best.tol)) placed++
  }
  Object.assign(report, {
    page: best.page, sheet: best.sheet, pdfRefs: best.words.length,
    found, foundPct: Math.round((100 * found) / best.words.length),
    placed, placedPct: Math.round((100 * placed) / Math.max(1, found)),
    extra: [...myRefs].filter((r) => !pdfRefs.has(r)).length,
  })
}
console.log(asJson ? JSON.stringify(report) : JSON.stringify(report, null, 1))
