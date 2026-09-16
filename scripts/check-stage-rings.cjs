// 阶段区域数据自检（回归脚本，防止"地图线"再次出现重复环 / 重走环这类数据缺陷）。
//
// 背景：断层、烬区、断轨、堑壕战的区域环在早期从官网工具提取时，把**同一个闭合环
// 串联了 2~3 遍**（断层 S1 攻方 22 点 -> 67 点），断层的 S2 守方环还额外出现
// "走一圈再原路重走"的形状。这类数据在下游的共享边抵消 + 折线拼接里会生成大量
// 退化线段与折返，表现为地图上区域边界线绘制异常。已按官网原数据（
// game.gtimg.cn/images/dfm/cp/a20240729directory/js/lib/map_*.js）重置。
//
// 本脚本做两层校验：
//   (1) 数据卫生：任何区域环都只能是一圈——除首尾闭合点外不得出现重复顶点，
//       不得有零长边，不得有真实自相交（交点距离最近顶点 > 0.05 才算真实相交，
//       避开官网数据里两顶点相距 0.007~0.016 的"贴边"假阳性）；
//   (2) 渲染链路：用真实的 dissolveSharedBorders() 处理每个阶段的
//       活动区 + 交战区，产出的折线不得退化（无零长边、无自身重走）。
const fs = require('fs')
const path = require('path')
const ts = require('typescript')

const ROOT = path.resolve(__dirname, '..')
function loadTs(rel) {
  const source = fs.readFileSync(path.join(ROOT, rel), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  })
  const mod = { exports: {} }
  new Function('module', 'exports', outputText)(mod, mod.exports)
  return mod.exports
}

const stages = loadTs('src/config/pointsStages.ts')
const { dissolveSharedBorders } = loadTs('src/utils/zoneBoundary.ts')

const STAGE_SETS = [
  ['断层', 'FAULT_STAGES'],
  ['烬区', 'EMBER_STAGES'],
  ['断轨', 'BROKENTRACK_STAGES'],
  ['堑壕战', 'TRENCH_STAGES'],
  ['攀升', 'ASCENT_STAGES'],
  ['临界点', 'FLASHPOINT_STAGES'],
  ['克劳狄斗兽场', 'COLOSSEUM_STAGES'],
  ['风暴眼', 'STORMEYE_STAGES'],
  ['金字塔', 'PYRAMID_STAGES'],
  ['乌姆斯运河', 'UMUSCANAL_STAGES'],
  ['余震', 'AFTERSHOCK_STAGES'],
]

/**
 * 攻防模式数据（烬区 / 堑壕战）单独存放于 JSON，且**与内置数据是两套几何**：
 * 应用在"攻防模式"下渲染的是这一套。它的区域环同样必须是一圈、折线不得折返。
 */
const MODE_FILES = [
  ['攻防模式(PC)', 'src/config/pcAttackDefenseOfficial.json'],
  ['攻防模式(移动端)', 'src/config/mobileAttackDefenseOfficial.json'],
]
const MAP_LABELS = { ember: '烬区', trench: '堑壕战' }
const MODE_SETS = MODE_FILES.flatMap(([label, file]) => {
  const absolute = path.join(ROOT, file)
  if (!fs.existsSync(absolute)) return []
  const data = JSON.parse(fs.readFileSync(absolute, 'utf8'))
  return Object.entries(data.maps || {}).map(([mapId, map]) => [`${label}·${MAP_LABELS[mapId] || mapId}`, map.stages || []])
})

/** 统一的「地图名 → 阶段数组」列表。 */
const ALL_SETS = [
  ...STAGE_SETS.map(([mapName, exportName]) => [mapName, stages[exportName]]),
  ...MODE_SETS,
]

/** 渲染时的近似比例：1 个地图单位 ≈ 1.5 屏幕像素（默认缩放 3.2 下实测约 1.47）。 */
const SCALE = 1.5
const project = ([lat, lng]) => ({ x: lng * SCALE, y: lat * SCALE })

const near = (a, b, tol) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol
const CLOSE_TOL = 1e-6
const PINCH_TOL = 0.05

function segmentIntersection(a, b, c, d) {
  const den = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0])
  if (Math.abs(den) < 1e-12) return null
  const t = ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / den
  const u = ((c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0])) / den
  if (t <= 1e-9 || t >= 1 - 1e-9 || u <= 1e-9 || u >= 1 - 1e-9) return null
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]
}

let pass = 0
let fail = 0
const report = (ok, label, detail) => {
  if (ok) { pass += 1; return }
  fail += 1
  console.log(`FAIL  ${label}${detail ? `  ${detail}` : ''}`)
}

/** 去掉尾部闭合点后的环体。 */
function ringBody(ring) {
  const out = []
  for (const point of ring) {
    if (!out.length || !near(out[out.length - 1], point, CLOSE_TOL)) out.push(point)
  }
  if (out.length > 1 && near(out[0], out[out.length - 1], CLOSE_TOL)) out.pop()
  return out
}

function ringProblems(body) {
  const problems = []
  for (let i = 0; i < body.length; i += 1) {
    const next = body[(i + 1) % body.length]
    if (near(body[i], next, CLOSE_TOL)) problems.push(`零长边@${i}`)
  }
  for (let i = 0; i < body.length; i += 1) {
    for (let j = i + 1; j < body.length; j += 1) {
      if (near(body[i], body[j], CLOSE_TOL)) problems.push(`重复顶点 ${i}=${j}`)
    }
  }
  for (let i = 0; i < body.length; i += 1) {
    for (let j = i + 1; j < body.length; j += 1) {
      if ((j + 1) % body.length === i || (i + 1) % body.length === j) continue
      const hit = segmentIntersection(body[i], body[(i + 1) % body.length], body[j], body[(j + 1) % body.length])
      if (!hit) continue
      const nearest = Math.min(...body.map((point) => Math.hypot(point[0] - hit[0], point[1] - hit[1])))
      if (nearest > PINCH_TOL) problems.push(`自相交 ${i}-${j}（距顶点 ${nearest.toFixed(3)}）`)
    }
  }
  return problems
}

console.log('--- (1) 区域环数据卫生 ---')
for (const [mapName, list] of ALL_SETS) {
  if (!Array.isArray(list)) { fail += 1; console.log(`FAIL  ${mapName}: 阶段数据缺失`); continue }
  list.forEach((stage) => {
    const rings = [
      ['攻方活动区', stage.attackBaseZone],
      ['守方活动区', stage.defenseBaseZone],
      ['防线区域', stage.zone && stage.zone.latlngs],
      ...(stage.points || []).map((point) => [`据点区域 ${point.name}`, point.capturable]),
    ]
    for (const [label, ring] of rings) {
      if (!Array.isArray(ring) || ring.length < 3) continue
      const body = ringBody(ring)
      report(body.length >= 3, `${mapName} ${stage.id} ${label}: 环点数不足（${body.length}）`)
      const problems = ringProblems(body)
      report(problems.length === 0, `${mapName} ${stage.id} ${label}`, problems.slice(0, 3).join('; '))
    }
  })
}

console.log('--- (2) 边界折线链路（真实阶段数据） ---')
for (const [mapName, list] of ALL_SETS) {
  if (!Array.isArray(list)) continue
  list.forEach((stage) => {
    const rings = []
    if (stage.attackBaseZone && stage.attackBaseZone.length >= 3) rings.push(stage.attackBaseZone)
    if (stage.defenseBaseZone && stage.defenseBaseZone.length >= 3) rings.push(stage.defenseBaseZone)
    for (const point of stage.points || []) {
      if (point.capturable && point.capturable.length >= 3) rings.push(point.capturable)
    }
    if (!rings.length) return
    const chains = dissolveSharedBorders(rings, project)
    report(chains.length > 0, `${mapName} ${stage.id}: 未产出边界折线`)
    chains.forEach((chain, index) => {
      const problems = []
      for (let i = 1; i < chain.length; i += 1) {
        if (near(chain[i - 1], chain[i], CLOSE_TOL)) problems.push(`零长边@${i}`)
      }
      // 折返的判据是"同一条边被走两遍"（正向或反向）：
      //   · 早期断层/烬区的环把一圈重复了 2~3 遍 -> 每条边出现 2~3 次；
      //   · "走一圈再原路走回" -> 每条边出现 2 次；
      // 而合法数据里区域轮廓自相接触（两个瓣共用一个顶点）只会重复**顶点**、不会重复边。
      for (let i = 0; i < chain.length - 1; i += 1) {
        for (let j = i + 1; j < chain.length - 1; j += 1) {
          const same = (near(chain[i], chain[j], CLOSE_TOL) && near(chain[i + 1], chain[j + 1], CLOSE_TOL))
            || (near(chain[i], chain[j + 1], CLOSE_TOL) && near(chain[i + 1], chain[j], CLOSE_TOL))
          if (same) problems.push(`边折返 ${i}~${j}`)
        }
      }
      report(problems.length === 0, `${mapName} ${stage.id} 折线#${index}（${chain.length} 点）`, problems.slice(0, 3).join('; '))
    })
  })
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
