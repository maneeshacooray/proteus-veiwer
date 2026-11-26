// Layer identification for Proteus CADCAM output, e.g.
//   "MyBoard - CADCAM Top Copper.GBR", "MyBoard - CADCAM Bottom Silk Screen.GBR",
//   "MyBoard - CADCAM Top Solder Resist.GBR", "MyBoard - CADCAM Drill.DRL"
// plus common extensions from other tools as a fallback.

const GERBER_EXT = /\.(gbr|ger|pho|art|drl|drd|xln|exc|ncd|cnc|txt|cmp|sol|stc|sts|plc|pls|crc|crs|gtl|gbl|gto|gbo|gts|gbs|gtp|gbp|gko|gm\d*|gml|g[1-9]|gp[1-9]|gd\d*|outline|oln)$/i

export function isGerberName(name) {
  if (/read-?me|report|\.pdf$/i.test(name)) return false
  return GERBER_EXT.test(name)
}

const RULES = [
  // Proteus keywords: matched against the file name without its extension.
  [/drill|\bnc\b|excellon|plated|holes?/i, 'drill', 'all'],
  [/board[\s_-]*(edge|outline)|outline|edge[\s_-]*cuts|\bkeep[\s_-]*out/i, 'outline', 'all'],
  [/mech(anical)?/i, 'drawing', 'all'],
  [/silk/i, 'silkscreen'],
  [/paste|smt/i, 'solderpaste'],
  [/(solder[\s_-]*)?resist|solder[\s_-]*mask|\bmask\b/i, 'soldermask'],
  [/inner|\bint(ernal)?[\s_-]*\d|\bmid/i, 'copper', 'inner'],
  [/copper|\bcu\b|signal|layer/i, 'copper'],
]

const EXT_RULES = {
  gtl: ['copper', 'top'], gbl: ['copper', 'bottom'], cmp: ['copper', 'top'], sol: ['copper', 'bottom'],
  gto: ['silkscreen', 'top'], gbo: ['silkscreen', 'bottom'], plc: ['silkscreen', 'top'], pls: ['silkscreen', 'bottom'],
  gts: ['soldermask', 'top'], gbs: ['soldermask', 'bottom'], stc: ['soldermask', 'top'], sts: ['soldermask', 'bottom'],
  gtp: ['solderpaste', 'top'], gbp: ['solderpaste', 'bottom'], crc: ['solderpaste', 'top'], crs: ['solderpaste', 'bottom'],
  gko: ['outline', 'all'], gml: ['outline', 'all'], gm1: ['outline', 'all'],
  drl: ['drill', 'all'], xln: ['drill', 'all'], exc: ['drill', 'all'], drd: ['drill', 'all'],
}

/** Returns {type, side, confident} or null when the name gives nothing away. */
export function classifyGerber(filename) {
  const base = filename.replace(/\.[^.]+$/, '')
  const ext = (filename.match(/\.([^.]+)$/)?.[1] || '').toLowerCase()
  // Proteus prefixes everything with "<project> - CADCAM "; look only at what follows.
  const tail = base.split(/cadcam/i).pop()

  for (const [re, type, fixedSide] of RULES) {
    if (!re.test(tail)) continue
    const side = fixedSide || sideOf(tail)
    if (side) return { type, side, confident: /cadcam/i.test(base) }
  }
  if (EXT_RULES[ext]) {
    const [type, side] = EXT_RULES[ext]
    return { type, side, confident: false }
  }
  return null
}

function sideOf(s) {
  if (/\b(top|component|front|f[\s._-])/i.test(s) || /^t[\s_-]/i.test(s)) return 'top'
  if (/\b(bot(tom)?|solder[\s_-]*side|back|b[\s._-])/i.test(s) || /^b[\s_-]/i.test(s)) return 'bottom'
  return null
}

export const LAYER_COLORS = {
  'top-copper': '#e8833a',
  'bottom-copper': '#3a8be8',
  'inner-copper': '#c0a040',
  'top-silkscreen': '#f2f2f2',
  'bottom-silkscreen': '#c7a6ff',
  'top-soldermask': '#2fbf71',
  'bottom-soldermask': '#1f8f8f',
  'top-solderpaste': '#a0a0a0',
  'bottom-solderpaste': '#707070',
  outline: '#ffd84d',
  drill: '#ff4d6d',
  drawing: '#9aa0a6',
}
