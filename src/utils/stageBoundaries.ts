import { useMemo } from 'react'
import { useMap } from 'react-leaflet'
import type { TacticalObjectiveState, Side, StageConfig } from '../types'
import { dissolveSharedBorders, type ProjectFn, type Ring } from './zoneBoundary'

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

    // 活动区与交战区一起抵消：共边只保留给交战区（白色）
    const activityLines: StageBoundaryLine[] = []
    if (activityRings.length) {
      const allActivity = activityRings.map((item) => item.ring)
      const merged = [...allActivity, ...contestedRings]
      const chains = dissolveSharedBorders(merged, project)
      // 用每条折线的起点反查它属于哪个环，决定着色
      chains.forEach((points, index) => {
        const owner = ownerOfChain(points, activityRings, project)
        activityLines.push({ key: `act-${index}`, points, owner })
      })
    }

    // 交战区自身的完整边框：始终白色实线（不参与抵消，保证闭合）
    const contestedLines: StageBoundaryLine[] = contestedRings.map((ring, index) => ({
      key: `cap-${index}`,
      points: ring,
      owner: 'contested',
    }))

    const frontlineLines: StageBoundaryLine[] = frontlineRings.map((ring, index) => ({
      key: `front-${index}`,
      points: ring,
      owner: 'frontline',
    }))

    return { activityLines, contestedLines, frontlineLines }
  }, [enabled.activity, enabled.capture, enabled.frontline, map, objectiveStates, stage, view])
}

/** 折线归属：取折线中点，判断落在哪个活动区环内（不在任何环内则视为 neutral）。 */
function ownerOfChain(
  points: Ring,
  rings: Array<{ ring: Ring; owner: StageBoundaryOwner }>,
  project: ProjectFn,
): StageBoundaryOwner {
  if (points.length === 0) return 'neutral'
  const mid = points[Math.floor(points.length / 2)]
  const target = project(mid)
  for (const item of rings) {
    if (pointInRing(target, item.ring, project)) return item.owner
  }
  return 'neutral'
}

/** 射线法判断点是否在环内（像素坐标）。 */
function pointInRing(point: { x: number; y: number }, ring: Ring, project: ProjectFn): boolean {
  let inside = false
  const pts = ring.map(project)
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]
    const b = pts[j]
    const intersects = (a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    if (intersects) inside = !inside
  }
  return inside
}
