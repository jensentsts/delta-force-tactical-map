// 裁剪残留检测：activityLines 中是否仍有与交战区（capturable 环）边"贴合"的子段
// —— 这些残留段在正常缩放（约1.5px/单位）下与白线仅差 1~3px，视觉上就是红/绿盖住白线。
const fs = require('fs')
const path = require('path')
const ts = require('typescript')

const ROOT = path.resolve(__dirname, '..')
function transpile(rel) {
  return ts.transpileModule(fs.readFileSync(path.join(ROOT, rel), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
}
const zoneBoundary = (() => {
  const mod = { exports: {} }
  new Function('module', 'exports', transpile('src/utils/zoneBoundary.ts'))(mod, mod.exports)
  return mod.exports
})()
const reactStub = { useMemo: (fn) => fn() }
const leafletStub = { useMap: () => ({}) }
const customRequire = (id) => {
  if (id === 'react') return reactStub
  if (id === 'react-leaflet') return leafletStub
  if (id === './zoneBoundary') return zoneBoundary
  return require(id)
}
const stageBoundaries = (() => {
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', transpile('src/utils/stageBoundaries.ts'))(mod, mod.exports, customRequire)
  return mod.exports
})()
const stageSets = (() => {
  const mod = { exports: {} }
  new Function('module', 'exports', transpile('src/config/pointsStages.ts'))(mod, mod.exports)
  return mod.exports
})()

/** 点到折线环的最短距离（单位） */
function distToRing(p, ring) {
  let best = Infinity
  for (let i = 0; i < ring.length; i++) {
    const [ay, ax] = ring[i]
    const [by, bx] = ring[(i + 1) % ring.length]
    const dx = bx - ax, dy = by - ay
    const ls = dx * dx + dy * dy
    const t = ls < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p[1] - ax) * dx + (p[0] - ay) * dy) / ls))
    best = Math.min(best, Math.hypot(p[1] - (ax + t * dx), p[0] - (ay + t * dy)))
  }
  return best
}

const SETS = ['FAULT_STAGES', 'EMBER_STAGES', 'BROKENTRACK_STAGES', 'TRENCH_STAGES', 'ASCENT_STAGES']
for (const setName of SETS) {
  ;(stageSets[setName] || []).forEach((stage, index) => {
    if (!stage.attackBaseZone || !stage.defenseBaseZone) return
    const b = stageBoundaries.useStageBoundaries(stage, 'attack', undefined, { activity: true, capture: true, frontline: false })
    const capRings = stage.points.filter((p) => p.capturable && p.capturable.length >= 3).map((p) => p.capturable)
    // 检查每条攻/守边界线中点是否贴在交战区环边 1.5 单位以内（≈2.25px）
    const leaks = []
    for (const line of b.activityLines) {
      for (let i = 1; i < line.points.length; i++) {
        const mid = [(line.points[i][0] + line.points[i - 1][0]) / 2, (line.points[i][1] + line.points[i - 1][1]) / 2]
        const d = Math.min(...capRings.map((r) => distToRing(mid, r)))
        if (d < 1.5) leaks.push(+d.toFixed(2))
      }
    }
    if (leaks.length) console.log(`${setName} S${index + 1}: ${leaks.length} 段残留（距离<1.5单位）, 最小 ${Math.min(...leaks)}`)
  })
}
console.log('done')
