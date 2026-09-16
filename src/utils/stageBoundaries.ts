import { useMemo } from 'react'
import { useMap } from 'react-leaflet'
import type { TacticalObjectiveState, Side, StageConfig } from '../types'
import {
  chainEdges,
  clipEdgesByRings,
  SHARED_EDGE_TOLERANCE_PX,
  type LngLat,
  type ProjectFn,
  type Ring,
} from './zoneBoundary'

export type StageBoundaryOwner = 'own' | 'enemy' | 'contested' | 'frontline' | 'neutral'

export interface StageBoundaryLine {
  key: string
  /** 经纬度折线（已去掉共享边并首尾相接） */
  points: Ring
  owner: StageBoundaryOwner
}

export interface StageBoundaries {
  /** 活动区边框（攻守双方），已按 own/enemy 区分 */
  activityLines: StageBoundaryLine[]
  /** 交战区域边框（据点可占领区域），统一白色实线 */
  contestedLines: StageBoundaryLine[]
  /** 阶段防线区域边框 */
  frontlineLines: StageBoundaryLine[]
}

const EMPTY: StageBoundaries = { activityLines: [], contestedLines: [], frontlineLines: [] }

/**
 * 计算当前阶段的全部区域边界线，并消除它们之间的共享边。
 *
 * 为什么需要：攻守活动区、据点可占领区域（交战区）在数据上普遍共边，
 * 各自独立绘制会让同一条边被画两遍（绿/红一遍、白一遍），表现为线条变粗、
 * 颜色互压、端点生硬拼接。这里把所有边界放在一起做一次"共享边抵消"，
 * 再把剩下的边接成连续折线，因此：
 *   · 共享边只由交战区域（白色）负责绘制；
 *   · 外轮廓仍连续闭合，不会出现断点。
 */
export function useStageBoundaries(
  stage: StageConfig | undefined,
  view: Side,
  objectiveStates: Record<string, TacticalObjectiveState> | undefined,
  enabled: { activity: boolean; capture: boolean; frontline: boolean },
): StageBoundaries {
  const map = useMap()

  return useMemo(() => {
    if (!stage) return EMPTY
    // 投影到像素做几何比较（CRS.Simple 下 containerPoint 与经纬度线性对应）
    const project: ProjectFn = ([lat, lng]) => {
      const point = map.latLngToContainerPoint([lat, lng])
      return { x: point.x, y: point.y }
    }

    // ---- 1) 活动区：参与共享边抵消，按 own/enemy 着色 ----
    const activityRings: Array<{ ring: Ring; owner: StageBoundaryOwner }> = []
    if (enabled.activity && stage.attackBaseZone && stage.attackBaseZone.length >= 3) {
      activityRings.push({ ring: stage.attackBaseZone, owner: view === 'attack' ? 'own' : 'enemy' })
    }
    if (enabled.activity && stage.defenseBaseZone && stage.defenseBaseZone.length >= 3) {
      activityRings.push({ ring: stage.defenseBaseZone, owner: view === 'defense' ? 'own' : 'enemy' })
    }

    // ---- 2) 交战区域：据点可占领区域，统一白色实线 ----
    const contestedRings: Ring[] = []
    if (enabled.capture) {
      for (const point of stage.points) {
        if (point.capturable && point.capturable.length >= 3) contestedRings.push(point.capturable)
      }
    }

    // ---- 3) 防线区域：独立处理（不参与抵消，它通常是最外层包络）----
    const frontlineRings: Ring[] = []
    if (enabled.frontline && stage.zone && stage.zone.latlngs.length >= 3) {
      frontlineRings.push(stage.zone.latlngs)
    }

    // 活动区边界的分类规则：
    //   · 攻/防活动区发生**面积重叠**时，重叠区域的边界（攻区边落在守区内的部分
    //     ＋守区边落在攻区内的部分，含两环几乎重合的"贴边"段）按交战区域样式
    //     （白色实线）绘制——这是双方实际对峙的前线；
    //   · 活动区 ∩ 交战区（据点可占领区域）：共边只由交战区白色绘制；
    //   · 其余外轮廓按各环自己的归属（own/enemy）着色。
    // 归属必须按环确定：把攻守两环的剩余边混在一起拼接会让一条折线横跨两个
    // 区域，"取中点猜归属"会把整条线染成同一方颜色（曾出现全部边线都变成
    // 守方样式）。因此逐环拆分、逐环拼接，归属直接来自环本身。
    const activityLines: StageBoundaryLine[] = []
    const overlapChains: Ring[] = []
    if (activityRings.length) {
      const [first, second] = activityRings
      let perRingOutside: Array<Array<[LngLat, LngLat]>>
      if (second) {
        const a = splitRingByOverlap(first.ring, second.ring)
        const b = splitRingByOverlap(second.ring, first.ring)
        perRingOutside = [a.outside, b.outside]
        chainEdges([...a.inside, ...b.inside], project, SHARED_EDGE_TOLERANCE_PX)
          .forEach((points) => overlapChains.push(points))
      } else {
        perRingOutside = [ringEdges(first.ring)]
      }

      // 每个活动区环：去掉落在对方区域内的部分（白色对峙线负责）与
      // 被交战区覆盖的部分（交战区白线负责）后，按本环归属拼接。
      activityRings.forEach((item, ringIndex) => {
        let segments = perRingOutside[ringIndex]
        if (segments.length && contestedRings.length) {
          segments = clipEdgesByRings(segments, contestedRings, project, SHARED_EDGE_TOLERANCE_PX)
        }
        chainEdges(segments, project, SHARED_EDGE_TOLERANCE_PX).forEach((points, index) => {
          activityLines.push({ key: `act-${ringIndex}-${index}`, points, owner: item.owner })
        })
      })
    }

    // 交战区自身的完整边框：始终白色实线（不参与抵消，保证闭合）；
    // 攻/防活动区的重叠区边界（"对峙线"）同样按交战区样式绘制。
    // 注意：Polyline 不会像 Polygon 那样自动闭合，原始数据里部分环
    // （如烬区攻防 据点A / 据点C2）首尾顶点并不重合，直接画会留出
    // 1.7~6.7 个单位的缺口，因此这里统一显式补上闭合点。
    const contestedLines: StageBoundaryLine[] = [
      ...contestedRings.map((ring, index) => ({
        key: `cap-${index}`,
        points: closeRing(ring),
        owner: 'contested' as const,
      })),
      ...overlapChains.map((points, index) => ({
        key: `overlap-${index}`,
        points,
        owner: 'contested' as const,
      })),
    ]

    const frontlineLines: StageBoundaryLine[] = frontlineRings.map((ring, index) => ({
      key: `front-${index}`,
      points: closeRing(ring),
      owner: 'frontline',
    }))

    return { activityLines, contestedLines, frontlineLines }
  }, [enabled.activity, enabled.capture, enabled.frontline, map, objectiveStates, stage, view])
}

/** 判定为"贴边/重合"的距离容差（经纬度单位）。真实数据里两环重合边顶点偏差
 *  约 0.03~0.04，而互不相关的边相距 ≥9，容差取 1 有充足间隔。 */
const OVERLAP_SNAP_TOLERANCE = 1.0
/** 拆分后的子段短于该长度（经纬度单位）则丢弃，避免退化折线。 */
const MIN_SUBSEGMENT_LENGTH = 0.01

/** 环 → 边列表（隐式闭合）。 */
function ringEdges(ring: Ring): Array<[LngLat, LngLat]> {
  const edges: Array<[LngLat, LngLat]> = []
  for (let i = 0; i < ring.length; i++) edges.push([ring[i], ring[(i + 1) % ring.length]])
  return edges
}

/** 显式闭合环：首尾顶点不重合时补上起点（Polyline 不会自动闭合）。 */
function closeRing(ring: Ring): Ring {
  const first = ring[0]
  const last = ring[ring.length - 1]
  if (Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-6) return ring
  return [...ring, first]
}

/** 射线法判断点是否在环内（经纬度平面，CRS.Simple 下与像素仅差线性变换）。 */
function pointInRing(point: LngLat, ring: Ring): boolean {
  const [py, px] = point // LngLat = [lat, lng]，几何上 x=lng, y=lat
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ay, ax] = ring[i]
    const [by, bx] = ring[j]
    const intersects = (ay > py) !== (by > py)
      && px < ((bx - ax) * (py - ay)) / (by - ay) + ax
    if (intersects) inside = !inside
  }
  return inside
}

/** 点到环边界的最短距离（经纬度单位）。 */
function distanceToRing(point: LngLat, ring: Ring): number {
  const [py, px] = point
  let best = Infinity
  for (let i = 0; i < ring.length; i++) {
    const [ay, ax] = ring[i]
    const [by, bx] = ring[(i + 1) % ring.length]
    const dx = bx - ax
    const dy = by - ay
    const lengthSq = dx * dx + dy * dy
    const t = lengthSq < 1e-12 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq))
    best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)))
  }
  return best
}

/** 线段 pq 与 rs 的交点在 pq 上的参数 t；不相交（或共线）返回 null。 */
function segmentIntersectionT(p: LngLat, q: LngLat, r: LngLat, s: LngLat): number | null {
  const d1x = q[1] - p[1]
  const d1y = q[0] - p[0]
  const d2x = s[1] - r[1]
  const d2y = s[0] - r[0]
  const denom = d1x * d2y - d1y * d2x
  if (Math.abs(denom) < 1e-12) return null
  const t = ((r[1] - p[1]) * d2y - (r[0] - p[0]) * d2x) / denom
  const u = ((r[1] - p[1]) * d1y - (r[0] - p[0]) * d1x) / denom
  if (t <= 1e-9 || t >= 1 - 1e-9 || u <= 1e-9 || u >= 1 - 1e-9) return null
  return t
}

/**
 * 把 ring 的边按"是否落入（或贴上）另一个活动区 other"拆成两组子段：
 *   · inside：中点在 other 内部、或距 other 边界不足容差（两环重合边）——
 *     这些构成双方重叠区域/对峙前线的边界，按交战区白色样式绘制；
 *   · outside：其余部分，保持本环归属颜色。
 * 长边可能在交点处进出对方区域，因此先在与 other 的所有交点处切开再分类。
 */
function splitRingByOverlap(ring: Ring, other: Ring): {
  inside: Array<[LngLat, LngLat]>
  outside: Array<[LngLat, LngLat]>
} {
  const inside: Array<[LngLat, LngLat]> = []
  const outside: Array<[LngLat, LngLat]> = []
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]
    const q = ring[(i + 1) % ring.length]
    const cuts = [0, 1]
    for (let j = 0; j < other.length; j++) {
      const t = segmentIntersectionT(p, q, other[j], other[(j + 1) % other.length])
      if (t !== null) cuts.push(t)
    }
    cuts.sort((a, b) => a - b)
    for (let k = 0; k + 1 < cuts.length; k++) {
      const t0 = cuts[k]
      const t1 = cuts[k + 1]
      if (t1 - t0 < 1e-9) continue
      const lerp = (t: number): LngLat => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]
      const a = lerp(t0)
      const b = lerp(t1)
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < MIN_SUBSEGMENT_LENGTH) continue
      const mid = lerp((t0 + t1) / 2)
      if (pointInRing(mid, other) || distanceToRing(mid, other) < OVERLAP_SNAP_TOLERANCE) {
        inside.push([a, b])
      } else {
        outside.push([a, b])
      }
    }
  }
  return { inside, outside }
}
