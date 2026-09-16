// 攻防模式区域数据重置脚本（烬区 / 堑壕战）。
//
// 背景：src/config/pcAttackDefenseOfficial.json 与 mobileAttackDefenseOfficial.json
// 里的**区域多边形**（攻方活动区 / 守方活动区 / 防线区域 / 据点可占领区域）是早期
// 从官网地图工具提取的，形状与官网原数据不符：
//   · 烬区：活动区/防线整体偏大 12~30 个地图单位，且烬区 S3 守方环是一条
//     A->B->A->B 来回重走的退化环（画出来是一根来回重复的线）；
//   · 堑壕战：活动区偏差 6~8 单位，堑壕战 S5 守方环是同一圈重复 3 遍。
// 据点/复活点坐标本身是对的，只有区域环有问题，所以这里只重置区域环。
//
// 数据源（官网地图工具脚本，与 pointsStages.ts 同源）：
//   https://game.gtimg.cn/images/dfm/cp/a20240729directory/js/lib/map_jq.js   （烬区）
//   https://game.gtimg.cn/images/dfm/cp/a20240729directory/js/lib/map_qhz.js  （堑壕战）
//
// 用法：
//   node scripts/generate-attack-defense-zones.cjs <官网数据目录>            # 干跑
//   node scripts/generate-attack-defense-zones.cjs <官网数据目录> --apply    # 写入
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ROOT = path.resolve(__dirname, '..')
const SPECS = {
  ember: { key: 'jq', stem: 'map_jq', name: '烬区' },
  trench: { key: 'qhz', stem: 'map_qhz', name: '堑壕战' },
}
const TARGETS = [
  { file: 'src/config/pcAttackDefenseOfficial.json', maps: ['ember', 'trench'] },
  { file: 'src/config/mobileAttackDefenseOfficial.json', maps: ['ember', 'trench'] },
]

const round = (value) => Math.round(value * 1000) / 1000
const parseXY = (value) => {
  const match = /X=([\d.-]+),Y=([\d.-]+)/.exec(value || '')
  return match ? [Number(match[1]), Number(match[2])] : null
}

/** 与官网数据提取同源的坐标换算（见 scripts/generate-mobile-official-data.cjs）。 */
function converter(info) {
  const bound = 128
  const xRatio = info.width / bound
  const yRatio = info.height / bound
  return (x, y) => {
    let projectedX
    let projectedY
    if (info.rotate === 90) {
      projectedX = bound - (info.centerY + y) / yRatio
      projectedY = -bound + (info.centerX - x) / xRatio
    } else if (info.rotate === -90) {
      projectedX = bound + (info.centerY + y) / yRatio
      projectedY = -bound - (info.centerX - x) / xRatio
    } else {
      projectedX = bound - (info.centerX - x) / xRatio
      projectedY = -bound - (info.centerY + y) / yRatio
    }
    return [round(projectedY), round(projectedX)]
  }
}

const borderOf = (item, convert) => (item.border || []).map(parseXY).filter(Boolean).map(([x, y]) => convert(x, y))

function loadOfficial(file) {
  const context = { window: {} }
  vm.createContext(context)
  vm.runInContext(fs.readFileSync(file, 'utf8'), context)
  return context.window
}

/** 点到折线的最短距离（用于估算改动幅度）。 */
function distanceToRing(point, ring) {
  let best = Infinity
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const lengthSq = dx * dx + dy * dy
    let distance
    if (lengthSq < 1e-12) {
      distance = Math.hypot(point[0] - a[0], point[1] - a[1])
    } else {
      const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSq))
      distance = Math.hypot(point[0] - (a[0] + t * dx), point[1] - (a[1] + t * dy))
    }
    if (distance < best) best = distance
  }
  return best
}

function ringDeviation(a, b) {
  if (!a || !b || !a.length || !b.length) return null
  const one = Math.max(...a.map((point) => distanceToRing(point, b)))
  const two = Math.max(...b.map((point) => distanceToRing(point, a)))
  return Math.max(one, two)
}

function main() {
  const directory = process.argv[2]
  const apply = process.argv.includes('--apply')
  if (!directory) {
    console.error('用法: node scripts/generate-attack-defense-zones.cjs <官网数据目录> [--apply]')
    process.exit(1)
  }

  const officialByMap = {}
  for (const [mapId, spec] of Object.entries(SPECS)) {
    const file = path.join(directory, spec.stem + '.js')
    if (!fs.existsSync(file)) {
      console.error('缺少官网数据文件: ' + file)
      process.exit(1)
    }
    const window = loadOfficial(file)
    officialByMap[mapId] = { spec, convert: converter(window[spec.key].info), official: window[spec.key + '_pc'] }
  }

  let changed = 0
  for (const target of TARGETS) {
    const filePath = path.join(ROOT, target.file)
    if (!fs.existsSync(filePath)) continue
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    for (const mapId of target.maps) {
      const entry = officialByMap[mapId]
      const modeMap = data.maps && data.maps[mapId]
      if (!entry || !modeMap) continue
      modeMap.stages.forEach((stage, stageIndex) => {
        // 用据点坐标把模式阶段对应到官网阶段（烬区模式有 4 个阶段、官网只有 3 个，
        // 第 4 个阶段与官网 S3 同源）。
        let best = null
        entry.official.mapArticle.forEach((items, officialIndex) => {
          const initItems = (entry.official.init && entry.official.init[officialIndex] && entry.official.init[officialIndex].typeList) || items
          const officialPoints = items.filter((item) => /^q_jd_/.test(item.icon || ''))
          let hits = 0
          for (const point of stage.points || []) {
            const hit = officialPoints.find((item) => {
              const converted = entry.convert(Number(item.x), Number(item.y))
              return Math.hypot(point.lat - converted[0], point.lng - converted[1]) < 1
            })
            if (hit) hits += 1
          }
          if (!best || hits > best.hits) best = { officialIndex, hits, items, initItems }
        })
        if (!best || best.hits === 0) {
          console.log(`  ${entry.spec.name} S${stageIndex + 1}: 无法匹配官网阶段，跳过`)
          return
        }
        const pickBase = (names, icons) => {
          const item = best.initItems.filter((x) => names.includes(x.name) || icons.includes(x.icon)).find((x) => x.border && x.border.length)
          return item ? borderOf(item, entry.convert) : null
        }
        const attack = pickBase(['进攻方基地'], ['g_jdbsd_r'])
        const defense = pickBase(['防守方基地'], ['f_jdbsd_g'])
        const zoneItem = best.items.find((x) => x.name === '区域' || x.icon === 'g_qy')
        const zone = zoneItem ? borderOf(zoneItem, entry.convert) : null
        const notes = []
        const before = [stage.attackBaseZone, stage.defenseBaseZone, stage.zone && stage.zone.latlngs]
        if (attack) stage.attackBaseZone = attack
        if (defense) stage.defenseBaseZone = defense
        if (zone) stage.zone = Object.assign({}, stage.zone || {}, { latlngs: zone })
        const after = [stage.attackBaseZone, stage.defenseBaseZone, stage.zone && stage.zone.latlngs]
        before.forEach((ring, index) => {
          if (!ring) return
          const deviation = ringDeviation(ring, after[index])
          notes.push(['攻方', '守方', '防线'][index] + ' ' + ring.length + '->' + after[index].length + ' Δ' + (deviation === null ? '-' : deviation.toFixed(2)))
        })
        const officialPoints = best.items.filter((item) => /^q_jd_/.test(item.icon || ''))
        for (const point of stage.points || []) {
          const match = officialPoints.find((item) => {
            const converted = entry.convert(Number(item.x), Number(item.y))
            return Math.hypot(point.lat - converted[0], point.lng - converted[1]) < 1
          })
          if (!match) continue
          const ring = borderOf(match, entry.convert)
          const deviation = ringDeviation(point.capturable, ring)
          notes.push(point.name + ' ' + (point.capturable || []).length + '->' + ring.length + ' Δ' + (deviation === null ? '-' : deviation.toFixed(2)))
          point.capturable = ring
        }
        console.log('  ' + entry.spec.name + ' S' + (stageIndex + 1) + ' -> 官网 S' + (best.officialIndex + 1) + ': ' + notes.join('  '))
        changed += 1
      })
    }
    if (apply) {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n')
      console.log('写入 ' + target.file)
    }
  }
  console.log((apply ? '已重置 ' : '将重置 ') + changed + ' 个阶段' + (apply ? '' : '（干跑，未写文件）'))
}

main()