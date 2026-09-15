import { useMemo } from 'react'
import { Polyline } from 'react-leaflet'
import { layerPane } from '../config/mapLayers'
import { useStageBoundaries, type StageBoundaryOwner } from '../utils/stageBoundaries'
import type { Side, StageConfig, TacticalObjectiveState } from '../types'

/** 区域颜色统一规则（问题3）：己方=绿、敌方=红、交战区域=白 */
const COLORS: Record<'own' | 'enemy', string> = {
  own: '#01ff84',
  enemy: '#e0453a',
}
/** 交战区域边框统一白色实线（第 6 项） */
const CONTESTED_COLOR = '#ffffff'

const OWNER_COLOR: Record<StageBoundaryOwner, string> = {
  own: COLORS.own,
  enemy: COLORS.enemy,
  contested: CONTESTED_COLOR,
  frontline: CONTESTED_COLOR,
  neutral: COLORS.own,
}

interface ActivityZonesProps {
  stages: StageConfig[]
  capturedStageIndex: number
  view: Side
  /** 是否显示活动区域图层 */
  visible: boolean
  /** 当前据点归属状态；用于与据点图层共享同一套边界计算 */
  objectiveStates?: Record<string, TacticalObjectiveState>
}

/**
 * 攻守双方活动区域 + 交战区域边框覆盖层。
 *
 * 第 6 项改动：边框不再各自独立绘制，而是与据点可占领区域一起做"共享边抵消"
 * （见 utils/stageBoundaries），因此攻守活动区与交战区域相接的那条边只会被
 * **白色实线**画一次，不再出现绿/红与白互相压盖、线条变粗与断点问题。
 * 区域仍然没有填充（fillOpacity 0），保持纯背景语义与 interactive: false。
 */
export default function ActivityZones({
  stages,
  capturedStageIndex,
  view,
  visible,
  objectiveStates,
}: ActivityZonesProps) {
  const stage = stages[capturedStageIndex]
  const boundaries = useStageBoundaries(stage, view, objectiveStates, {
    activity: true,
    capture: true,
    frontline: false,
  })

  const lines = useMemo(
    () => [...boundaries.activityLines, ...boundaries.contestedLines],
    [boundaries.activityLines, boundaries.contestedLines],
  )

  if (!visible || lines.length === 0) return null

  return (
    <>
      {lines.map((line) => (
        <Polyline
          pane={layerPane('activityZonePane')}
          key={line.key}
          positions={line.points}
          pathOptions={{
            color: OWNER_COLOR[line.owner],
            // 交战区域（白色）稍细，活动区边框稍粗；两者共享边只画白色那一条
            weight: line.owner === 'contested' ? 2 : 2.4,
            opacity: line.owner === 'contested' ? 0.95 : 0.9,
            dashArray: line.owner === 'contested' ? '0' : '6 4',
            fillColor: OWNER_COLOR[line.owner],
            fillOpacity: 0,
            lineJoin: 'round',
            lineCap: 'round',
            className: line.owner === 'contested' ? 'demo-map-capture' : 'demo-map-activity',
            // 活动区纯视觉背景，永久禁用交互（无选中/高亮/提示）
            interactive: false,
          }}
        />
      ))}
    </>
  )
}
