import { layerPane } from '../config/mapLayers'
import BoundaryLines from './BoundaryLines'
import { useStageBoundaries } from '../utils/stageBoundaries'
import type { Side, StageConfig, TacticalObjectiveState } from '../types'

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
 * 区域仍然没有填充，保持纯背景语义与 interactive: false。
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

  const activityLines = boundaries.activityLines
  const contestedLines = boundaries.contestedLines

  if (!visible || (activityLines.length === 0 && contestedLines.length === 0)) return null

  return (
    <>
      {/* 攻/守活动区边界在下（410），交战区白色边界在上（420）；
          活动区纯视觉背景，永久禁用交互（无选中/高亮/提示） */}
      <BoundaryLines lines={activityLines} pane={layerPane('activityZonePane')} interactive={false} />
      <BoundaryLines lines={contestedLines} pane={layerPane('contestedZonePane')} interactive={false} />
    </>
  )
}
