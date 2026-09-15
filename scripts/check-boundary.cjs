// Boundary de-duplication tests, covering BOTH properties:
//   (a) edges shared between DIFFERENT rings are cancelled once;
//   (b) overlapping edges INSIDE one self-touching ring are preserved.
const fs = require('fs')
const ts = require('typescript')

const source = fs.readFileSync('src/utils/zoneBoundary.ts', 'utf8')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
})
const mod = { exports: {} }
new Function('module', 'exports', outputText)(mod, mod.exports)
const { exclusiveBoundaryEdges, dissolveSharedBorders, SHARED_EDGE_TOLERANCE_PX } = mod.exports

const P = ([lat, lng]) => ({ x: lng, y: lat })
let pass = 0, fail = 0
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) console.log(`      got  ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`)
}

const ringA = [[0, 0], [10, 0], [10, 10], [0, 10]]          // lat 0..10, lng 0..10
const ringB = [[0, 10], [10, 10], [10, 20], [0, 20]]        // shares lng=10

console.log('--- (a) 跨环共享边应被抵消一次 ---')
const cross = exclusiveBoundaryEdges([ringA, ringB], P)
check('共享边不再重复', cross.filter(([a, b]) => a[1] === 10 && b[1] === 10).length, 0)
check('剩余 6 条边', cross.length, 6)
const merged = dissolveSharedBorders([ringA, ringB], P)
check('拼成一条外轮廓', merged.length, 1)
check('外轮廓 7 点', merged[0].length, 7)

console.log('\n--- (a2) 顶点密度不同的跨环共边 ---')
const ringBDense = [[0, 10], [3.5, 10], [7.2, 10], [10, 10], [10, 20], [0, 20]]
const dense = exclusiveBoundaryEdges([ringA, ringBDense], P)
check('长边与拆分的 3 段全部抵消', dense.filter(([a, b]) => a[1] === 10 && b[1] === 10).length, 0)

console.log('\n--- (b) 自相接触的单个环：内部重叠边必须保留 ---')
// 一个"折返"的环：从 (0,0) 走到 (10,0) 再沿同一条线折回 (0,0)，然后闭合成矩形
// 顶点 (10,0) 与 (0,0) 各出现两次 —— 模拟 断层/烬区 的自接触多边形
const pinched = [[0, 0], [10, 0], [10, 5], [10, 0], [0, 0], [0, 10]]
const solo = exclusiveBoundaryEdges([pinched], P)
// 6 个顶点两两相邻共 6 条边，其中"闭合边"(0,10)->(0,0) 有长度、
// 首尾那条 (0,10)->(0,0) 才是最后一条；被丢掉的只有零长边 (0,0)->(0,0)。
// 关键断言是：环内折返产生的重叠边**没有**被互相抵消。
check('单环不再整体消失', solo.length > 0, true)
check('保留 6 条边（6 个顶点，仅零长边被丢弃）', solo.length, 6)
check('折返边 (10,0)-(10,5) 仍在', solo.some(([a, b]) =>
  (a[0] === 10 && a[1] === 0 && b[0] === 10 && b[1] === 5) ||
  (a[0] === 10 && a[1] === 5 && b[0] === 10 && b[1] === 0)), true)

console.log('\n--- (b2) 真实数据的形态：顶点出现 3~4 次 ---')
const manyDup = [
  [0, 0], [5, 0], [10, 0], [10, 5],
  [10, 0],            // 回到 (10,0) —— 第二次
  [5, 0],             // 再沿底边折回
  [0, 0],             // 第三次出现 (0,0)
  [0, 10], [5, 10],
]
const many = exclusiveBoundaryEdges([manyDup], P)
check('重复顶点环仍保留大部分边', many.length >= 7, true)

console.log('\n--- (c) 不相邻多边形：一条都不丢 ---')
const far1 = [[0, 0], [10, 0], [10, 10], [0, 10]]
const far2 = [[100, 100], [110, 100], [110, 110], [100, 110]]
check('保留全部 8 条边', exclusiveBoundaryEdges([far1, far2], P).length, 8)
check('两条独立轮廓', dissolveSharedBorders([far1, far2], P).length, 2)

console.log('\n--- (d) 真实数据回归：断层/烬区 攻方活动区不再被抹掉 ---')
const src = fs.readFileSync('src/config/pointsStages.ts', 'utf8')
const ps = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
const pmod = { exports: {} }
new Function('module', 'exports', 'require', ps)(pmod, pmod.exports, require)
const totalLen = (pts) => { let s = 0; for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i-1][0], pts[i][1] - pts[i-1][1]); return s }
for (const [key, name, expectMin] of [
  ['FAULT_STAGES', '断层', 0.97],
  ['EMBER_STAGES', '烬区', 0.97],
  ['BROKENTRACK_STAGES', '断轨', 0.97],
  ['ASCENT_STAGES', '攀升', 0.97],
  ['COLOSSEUM_STAGES', '斗兽场', 0.97],
]) {
  let worst = 1
  for (const st of pmod.exports[key]) {
    const ring = st.attackBaseZone
    if (!Array.isArray(ring) || ring.length < 3) continue
    const ringLen = totalLen([...ring, ring[0]])
    const kept = exclusiveBoundaryEdges([ring], P).reduce((s, [a, b]) => s + Math.hypot(b[0] - a[0], b[1] - a[1]), 0)
    worst = Math.min(worst, kept / ringLen)
  }
  check(`${name} 各阶段保留比例 ≥ ${(expectMin * 100).toFixed(0)}%（实测最低 ${(worst * 100).toFixed(1)}%）`, worst >= expectMin, true)
}

console.log(`\n容差 ${SHARED_EDGE_TOLERANCE_PX}px\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
