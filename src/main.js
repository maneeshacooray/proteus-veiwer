import JSZip from 'jszip'
import * as pdfjs from 'pdfjs-dist'
import pdfWorkerSource from 'pdfjs-dist/build/pdf.worker.min.mjs?raw'
import { read, plot, renderLayers, renderBoard, stringifySvg } from '@tracespace/core'
import { classifyGerber, isGerberName, LAYER_COLORS } from './layers.js'
import { readPdsprj } from './pdsprj.js'
import { parseDsn } from './dsn.js'
import { schematicToSvg } from './schematic-svg.js'
import { parseLyt } from './lyt.js'
import { pcbToSvg } from './pcb-svg.js'

// Ship the worker inside the page so the viewer is one self-contained HTML file.
pdfjs.GlobalWorkerOptions.workerSrc = URL.createObjectURL(
  new Blob([pdfWorkerSource], { type: 'text/javascript' }),
)

const $ = (sel) => document.querySelector(sel)
const stage = $('#stage')
const viewport = $('#viewport')
const canvas = $('#canvas')
const statusEl = $('#status')
const layerPanel = $('#layer-panel')
const layerList = $('#layer-list')

// Long side of the PCB render, in CSS pixels at zoom 1.
const PCB_BASE_PX = 1600

const views = {} // name -> element
let currentView = 'schematic'

/* ---------------- file intake ---------------- */

$('#file-input').addEventListener('change', (e) => openFiles([...e.target.files]))
$('#try-demo')?.addEventListener('click', async () => {
  try {
    const res = await fetch('./demo.zip')
    if (!res.ok) throw new Error(res.statusText)
    openFiles([new File([await res.blob()], 'demo.zip', { type: 'application/zip' })])
  } catch (e) {
    setStatus(`Could not load the demo (${e.message})`, true)
  }
})

stage.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('dragover') })
stage.addEventListener('dragleave', (e) => {
  if (!stage.contains(e.relatedTarget)) stage.classList.remove('dragover')
})
stage.addEventListener('drop', (e) => {
  e.preventDefault()
  stage.classList.remove('dragover')
  openFiles([...e.dataTransfer.files])
})

async function openFiles(files) {
  if (!files.length) return
  setStatus('Reading files…')
  try {
    const flat = await expandZips(files)
    const schematic = flat.filter((f) => /\.(pdf|svg|png|jpe?g)$/i.test(f.name))
    const gerbers = flat.filter((f) => isGerberName(f.name))
    const projects = flat.filter((f) => /\.pdsprj$/i.test(f.name))

    if (!schematic.length && !gerbers.length && !projects.length) {
      throw new Error('No Proteus project (.pdsprj), schematic (PDF/SVG/PNG) or Gerber/drill files found.\nFiles seen: ' +
        flat.map((f) => f.name).join(', '))
    }

    const notes = []
    if (projects.length) {
      const proj = await readPdsprj(projects[0])
      // Draw the schematic straight from the project unless an exported one was dropped too.
      let drewSchematic = false
      if (proj.hasSchematic && !schematic.length) {
        try {
          const view = makeView('schematic')
          view.className = 'view view-schematic'
          view.innerHTML = schematicToSvg(parseDsn(proj.dsn))
          drewSchematic = true
        } catch (err) {
          console.error('Could not draw schematic from .pdsprj', err)
        }
      }
      // Same for the PCB, unless Gerbers were dropped too.
      let drewPcb = false
      let outline = null
      if (proj.hasLayout && !gerbers.length) {
        try {
          const pcb = parseLyt(proj.lyt)
          for (const side of ['top', 'bottom']) {
            const view = makeView(side)
            view.innerHTML = pcbToSvg(pcb, { side })
            outline = view.querySelector('svg')?.dataset.outline || outline
          }
          views.layers?.remove()
          delete views.layers
          drewPcb = true
        } catch (err) {
          console.error('Could not draw PCB from .pdsprj', err)
        }
      }
      loadProject(proj, {
        haveSchematic: drewSchematic || schematic.length > 0,
        havePcb: drewPcb || gerbers.length > 0,
        native: { schematic: drewSchematic, pcb: drewPcb, outline },
      })
      notes.push(projects[0].name)
    }
    if (schematic.length) {
      await loadSchematic(schematic)
      notes.push(`${schematic.length} schematic file(s)`)
    }
    if (gerbers.length) {
      const n = await loadPcb(gerbers)
      notes.push(`${n} PCB layer(s)`)
    }

    $('#empty').hidden = true
    updateTabs()
    showView(views[currentView] && !projects.length ? currentView
      : views.schematic ? 'schematic' : gerbers.length ? 'top' : 'project')
    setStatus('Loaded ' + notes.join(' and '), false, 3000)
  } catch (err) {
    console.error(err)
    setStatus(err.message || String(err), true)
  }
}

async function expandZips(files) {
  const out = []
  for (const f of files) {
    // A .pdsprj is also a ZIP, but it is handled whole by readPdsprj().
    if (!/\.zip$/i.test(f.name)) { out.push(f); continue }
    const zip = await JSZip.loadAsync(f)
    for (const entry of Object.values(zip.files)) {
      if (entry.dir || /(^|\/)(__MACOSX|\.)/.test(entry.name)) continue
      const blob = await entry.async('blob')
      out.push(new File([blob], entry.name.split('/').pop()))
    }
  }
  return out
}

/* ---------------- schematic ---------------- */

async function loadSchematic(files) {
  const view = makeView('schematic')
  view.className = 'view view-schematic'
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))

  for (const file of files) {
    if (/\.pdf$/i.test(file.name)) {
      const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise
      for (let i = 1; i <= pdf.numPages; i++) {
        setStatus(`Rendering ${file.name}, page ${i}/${pdf.numPages}…`)
        const page = await pdf.getPage(i)
        // Render at high resolution so zooming stays crisp; display at 1.5× PDF points.
        const display = page.getViewport({ scale: 1.5 })
        const render = page.getViewport({ scale: 4 })
        const c = document.createElement('canvas')
        c.width = render.width
        c.height = render.height
        c.style.width = display.width + 'px'
        c.style.height = display.height + 'px'
        await page.render({ canvas: c, viewport: render }).promise
        view.append(c)
      }
    } else if (/\.svg$/i.test(file.name)) {
      const doc = new DOMParser().parseFromString(await file.text(), 'image/svg+xml')
      const svg = doc.documentElement
      if (svg.nodeName !== 'svg') throw new Error(`${file.name} is not a valid SVG`)
      svg.querySelectorAll('script').forEach((s) => s.remove())
      view.append(document.importNode(svg, true))
    } else {
      const img = new Image()
      img.src = URL.createObjectURL(file)
      await img.decode()
      view.append(img)
    }
  }
}

/* ---------------- PCB ---------------- */

async function loadPcb(files) {
  setStatus(`Parsing ${files.length} Gerber/drill file(s)…`)
  const readResult = await read(files)

  // Tracespace does not know Proteus file names; classify them ourselves where it gave up.
  for (const layer of readResult.layers) {
    const ours = classifyGerber(layer.filename)
    if (ours && (!layer.type || ours.confident)) Object.assign(layer, ours)
  }
  readResult.layers = readResult.layers.filter((l) => l.type)
  if (!readResult.layers.length) throw new Error('Could not identify any Gerber layers.')

  const plotResult = plot(readResult)
  const layersResult = renderLayers(plotResult)
  const boards = renderBoard(layersResult)
  const [, , vbW, vbH] = layersResult.boardShapeRender.viewBox
  const k = PCB_BASE_PX / Math.max(vbW, vbH)
  const size = { width: vbW * k, height: vbH * k }

  for (const side of ['top', 'bottom']) {
    const view = makeView(side)
    view.innerHTML = sizedSvg(stringifySvg(boards[side]), size)
  }

  // Individual layers, stacked and toggleable.
  const view = makeView('layers')
  view.className = 'view view-layers pcb-stack'
  view.style.width = size.width + 'px'
  view.style.height = size.height + 'px'
  layerList.innerHTML = ''

  const order = ['outline', 'copper', 'soldermask', 'solderpaste', 'silkscreen', 'drill', 'drawing']
  const sorted = [...layersResult.layers].sort((a, b) =>
    sideRank(a.side) - sideRank(b.side) || order.indexOf(a.type) - order.indexOf(b.type))

  sorted.forEach((layer, i) => {
    const color = LAYER_COLORS[`${layer.side}-${layer.type}`] || LAYER_COLORS[layer.type] || '#ccc'
    const holder = document.createElement('div')
    holder.innerHTML = sizedSvg(stringifySvg(layersResult.rendersById[layer.id]), size)
    const svg = holder.firstElementChild
    svg.style.color = color
    svg.style.opacity = '0.85'
    // The first svg sets the box size; the rest are overlaid.
    if (i > 0) svg.style.position = 'absolute'
    // Mask and paste are solid fills that would hide the copper, so start them hidden.
    const onByDefault = !['soldermask', 'solderpaste'].includes(layer.type) &&
      (layer.side !== 'bottom' || layer.type === 'outline' || layer.type === 'drill')
    svg.style.display = onByDefault ? '' : 'none'
    view.append(svg)

    const li = document.createElement('li')
    li.innerHTML = `
      <input type="color" value="${color}" title="Layer colour" />
      <label><input type="checkbox" ${onByDefault ? 'checked' : ''} />
        <span class="name" title="${escapeHtml(layer.filename)}">${escapeHtml(prettyName(layer))}</span></label>`
    li.querySelector('[type=checkbox]').addEventListener('change', (e) => {
      svg.style.display = e.target.checked ? '' : 'none'
    })
    li.querySelector('[type=color]').addEventListener('input', (e) => { svg.style.color = e.target.value })
    layerList.append(li)
  })

  return sorted.length
}

function sizedSvg(markup, { width, height }) {
  return markup.replace(/^<svg\b([^>]*)>/, (m, attrs) => {
    const cleaned = attrs.replace(/\s(width|height)="[^"]*"/g, '')
    return `<svg${cleaned} width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet">`
  })
}

const sideRank = (s) => ({ top: 0, all: 1, inner: 2, bottom: 3 }[s] ?? 4)
const prettyName = (l) => [l.side && l.side !== 'all' ? cap(l.side) : '', TYPE_LABEL[l.type] || l.type]
  .filter(Boolean).join(' ')
const TYPE_LABEL = {
  copper: 'Copper', soldermask: 'Solder Mask', silkscreen: 'Silkscreen',
  solderpaste: 'Paste', drill: 'Drill', outline: 'Board Outline', drawing: 'Mechanical',
}
const cap = (s) => s[0].toUpperCase() + s.slice(1)
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

/* ---------------- native Proteus project ---------------- */

const projectView = $('#project-view')

function loadProject(proj, { haveSchematic, havePcb, native = {} }) {
  const fmt = (d) => (d ? d.toLocaleString() : '-')
  const rows = proj.parts.map((p) => `<tr>
      <td>${escapeHtml(p.name)}</td><td>${escapeHtml(p.device)}</td><td>${escapeHtml(p.package)}</td>
      <td class="props">${escapeHtml(Object.entries(p.props).filter(([k]) => k !== 'PACKAGE')
        .map(([k, v]) => `${k}=${v}`).join(', '))}</td></tr>`).join('')

  projectView.innerHTML = `
    <section class="project">
      <h1>${escapeHtml(proj.name)}</h1>
      <dl class="meta">
        <div><dt>Proteus release</dt><dd>${escapeHtml(formatRelease(proj.meta.release))}</dd></div>
        <div><dt>Created</dt><dd>${fmt(proj.meta.created)}</dd></div>
        <div><dt>Modified</dt><dd>${fmt(proj.meta.modified)}</dd></div>
        <div><dt>Contains</dt><dd>${[proj.hasSchematic && 'Schematic', proj.hasLayout && 'PCB layout'].filter(Boolean).join(' + ') || '-'}</dd></div>
        <div><dt>Board layers</dt><dd>${escapeHtml(proj.layers.join(', ') || '-')}</dd></div>
      </dl>

      ${native.schematic || native.pcb ? `
      <div class="notice info">
        ${[native.schematic && '<b>Schematic</b>', native.pcb && '<b>PCB Top / Bottom</b>'].filter(Boolean).join(' and ')}
        ${native.schematic && native.pcb ? 'are' : 'is'} drawn directly from this .pdsprj by a reverse-engineered reader.
        Proteus doesn't document the format, so some details may differ from Proteus.
        For a manufacturing-accurate view, drop the Gerber exports in as well.
      </div>` : ''}
      ${native.pcb && native.outline && native.outline !== 'edge' ? `
      <div class="notice">
        <b>${native.outline === 'none' ? 'This design has no board edge.' : "This design's board edge doesn't contain the parts."}</b>
        ${native.outline === 'none' ? 'Nothing is drawn on the Board Edge layer in Proteus, so' : 'So'} the dashed outline in the PCB views is
        estimated from the parts and isn't the real board shape. Draw the outline on the Board Edge layer in Proteus to fix this.
      </div>` : ''}
      ${haveSchematic && havePcb ? '' : `
      <div class="notice">
        <b>${haveSchematic ? 'The PCB layout' : 'The schematic and PCB drawings'} can't be shown from a .pdsprj yet.</b>
        To see ${haveSchematic ? 'it' : 'them'} here, export from Proteus and drop the files in alongside this project:
        <ul>
          ${haveSchematic ? '' : '<li><b>Schematic:</b> Schematic Capture → File → Print (to a PDF printer), or File → Export Graphics → PDF/SVG</li>'}
          <li><b>PCB:</b> PCB Layout → Output → Generate Gerber/Excellon Files, then drop the folder or its .zip</li>
        </ul>
      </div>`}

      <h2>Parts <span class="count">${proj.parts.length}</span></h2>
      ${proj.parts.length ? `<table class="parts">
        <thead><tr><th>Value / label</th><th>Device</th><th>Package</th><th>Properties</th></tr></thead>
        <tbody>${rows}</tbody></table>` : '<p class="muted">No parts found.</p>'}
    </section>`
  views.project = projectView
}

// PROJECT.XML stores the release as e.g. "816" for 8.16.
const formatRelease = (r) => (/^\d{3}$/.test(r || '') ? `${r[0]}.${r.slice(1)}` : r || '-')

/* ---------------- views & tabs ---------------- */

function makeView(name) {
  views[name]?.remove()
  const el = document.createElement('div')
  el.className = `view view-${name}`
  canvas.append(el)
  views[name] = el
  return el
}

function updateTabs() {
  document.querySelectorAll('#tabs button').forEach((b) => { b.disabled = !views[b.dataset.view] })
}

document.querySelectorAll('#tabs button').forEach((b) =>
  b.addEventListener('click', () => !b.disabled && showView(b.dataset.view)))

function showView(name) {
  currentView = name
  for (const [n, el] of Object.entries(views)) el.classList.toggle('active', n === name)
  projectView.hidden = name !== 'project'
  viewport.hidden = name === 'project'
  $('#zoom-controls').hidden = name === 'project'
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === name))
  layerPanel.hidden = name !== 'layers'
  fit()
}

/* ---------------- pan & zoom ---------------- */

const cam = { x: 0, y: 0, z: 1 }
const applyCam = () => { canvas.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})` }

function zoomAt(factor, px, py) {
  const z = Math.min(40, Math.max(0.05, cam.z * factor))
  const f = z / cam.z
  cam.x = px - (px - cam.x) * f
  cam.y = py - (py - cam.y) * f
  cam.z = z
  applyCam()
}

function fit() {
  const el = views[currentView]
  if (!el || currentView === 'project') return
  const w = el.offsetWidth, h = el.offsetHeight
  const vw = viewport.clientWidth, vh = viewport.clientHeight
  const pad = 32
  cam.z = Math.min((vw - pad * 2) / w, (vh - pad * 2) / h)
  cam.x = (vw - w * cam.z) / 2
  cam.y = currentView === 'schematic' && h * cam.z > vh ? pad : (vh - h * cam.z) / 2
  applyCam()
}

viewport.addEventListener('wheel', (e) => {
  e.preventDefault()
  const r = viewport.getBoundingClientRect()
  zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top)
}, { passive: false })

let drag = null
viewport.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y }
  viewport.setPointerCapture(e.pointerId)
  viewport.classList.add('panning')
})
viewport.addEventListener('pointermove', (e) => {
  if (!drag) return
  cam.x = drag.cx + e.clientX - drag.x
  cam.y = drag.cy + e.clientY - drag.y
  applyCam()
})
const endDrag = () => { drag = null; viewport.classList.remove('panning') }
viewport.addEventListener('pointerup', endDrag)
viewport.addEventListener('pointercancel', endDrag)
viewport.addEventListener('dblclick', fit)

document.querySelectorAll('#zoom-controls button').forEach((b) => b.addEventListener('click', () => {
  const cx = viewport.clientWidth / 2, cy = viewport.clientHeight / 2
  if (b.dataset.zoom === 'in') zoomAt(1.4, cx, cy)
  else if (b.dataset.zoom === 'out') zoomAt(1 / 1.4, cx, cy)
  else fit()
}))

window.addEventListener('keydown', (e) => {
  if (e.target.closest('input')) return
  const keys = { 1: 'project', 2: 'schematic', 3: 'top', 4: 'bottom', 5: 'layers' }
  if (keys[e.key] && views[keys[e.key]]) showView(keys[e.key])
  if (e.key === 'f' || e.key === '0') fit()
  if (e.key === '+' || e.key === '=') zoomAt(1.4, viewport.clientWidth / 2, viewport.clientHeight / 2)
  if (e.key === '-') zoomAt(1 / 1.4, viewport.clientWidth / 2, viewport.clientHeight / 2)
})
window.addEventListener('resize', fit)

/* ---------------- status ---------------- */

let statusTimer
function setStatus(msg, isError = false, hideAfter = 0) {
  clearTimeout(statusTimer)
  statusEl.hidden = false
  statusEl.textContent = msg
  statusEl.classList.toggle('error', isError)
  if (hideAfter) statusTimer = setTimeout(() => { statusEl.hidden = true }, hideAfter)
}

updateTabs()
