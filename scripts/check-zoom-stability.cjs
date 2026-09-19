// 验证 hypothesis: useStageBoundaries 的几何判定依赖“当前缩放”(latLngToContainerPoint)，
// 初次加载与点击重绘时缩放不同 → 裁剪/拼接结果不同 → 初次加载出现旧的压盖问题。
// 做法：用 stub 的 react/react-leaflet 直接调用 useStageBoundaries，
// 分别以多个缩放比例提供 project，比较产出的边界线集合。
const fs = require('fs')
const path = require('path')
const ts = require('typescript')

const ROOT = path.resolve(__dirname, '..')
function transpile(rel) {
  const source = fs.readFileSync(path.join(ROOT, rel), 'utf8')
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
}

const zoneBoundary = (() => {
  const mod = { exports: {} }
  new Function('module', 'exports', transpile('src/utils/zoneBoundary.ts'))(mod, mod.exports)
  return mod.exports
})()

function loadStageBoundaries(scale) {
  const reactStub = { useMemo: (fn) => fn() }
  const leafletStub = {
    useMap: () => ({
      // CRS.Simple 下 containerPoint 与经纬度线性对应；缩放只改变比例
      latLngToContainerPoint: ([lat, lng]) => ({ x: lng * scale, y: lat * scale }),
    }),
  }
  const customRequire = (id) => {
    if (id === 'react') return reactStub
    if (id === 'react-leaflet') return leafletStub
    if (id === './zoneBoundary') return zoneBoundary
    return require(id)
  }
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', transpile('src/utils/stageBoundaries.ts'))(mod, mod.exports, customRequire)
  return mod.exports
}

const stageSets = (() => {
  const mod = { exports: {} }
  new Function('module', 'exports', transpile('src/config/pointsStages.ts'))(mod, mod.exports)
  return mod.exports
})()

const SETS = ['FAULT_STAGES', 'EMBER_STAGES', 'BROKENTRACK_STAGES', 'TRENCH_STAGES']
// 渲染时的近似比例：默认缩放 ≈1.5 px/单位；初次 fitBounds 更小；点击据点后 flyTo 更大
const SCALES = [0.4, 1.5, 6]

/** 边界线集合指纹：条数 + 总点数 + 总长（单位） */
function fingerprint(lines) {
  let pts = 0
  let len = 0
  for (const line of lines) {
    pts += line.points.length
    for (let i = 1; i < line.points.length; i++) {
      len += Math.hypot(line.points[i][0] - line.points[i - 1][0], line.points[i][1] - line.points[i - 1][1])
    }
  }
  return `${lines.length} 条 / ${pts} 点 / 总长 ${len.toFixed(2)}`
}

let diff = 0
for (const setName of SETS) {
  const stages = stageSets[setName] || []
  stages.forEach((stage, index) => {
    if (!stage.attackBaseZone || !stage.defenseBaseZone) return
    const results = SCALES.map((scale) => {
      const { useStageBoundaries } = loadStageBoundaries(scale)
      const b = useStageBoundaries(stage, 'attack', undefined, { activity: true, capture: true, frontline: false })
      return { scale, activity: fingerprint(b.activityLines), contested: fingerprint(b.contestedLines), lines: b }
    })
    const a = results.map((r) => r.activity)
    const c = results.map((r) => r.contested)
    const sameActivity = a.every((x) => x === a[0])
    const sameContested = c.every((x) => x === c[0])
    if (!sameActivity || !sameContested) {
      diff++
      console.log(`差异  ${setName} S${index + 1}`)
      results.forEach((r) => console.log(`   scale=${r.scale}  activity: ${r.activity}   contested: ${r.contested}`))
    }
  })
}
console.log(diff ? `\n共 ${diff} 个阶段的边界线随缩放变化 —— 证实初次加载/重绘结果不同` : '\n全部阶段跨缩放一致')
