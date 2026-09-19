import { Polyline } from 'react-leaflet'
import type { StageBoundaryLine, StageBoundaryOwner } from '../utils/stageBoundaries'

/**
 * 区域边界线的统一样式表（唯一事实来源）。
 *
 * 颜色规则（第 6 项需求）：
 *   · 己方活动区 = 绿、敌方活动区 = 红（虚线）；
 *   · 交战区域（据点可占领区域 + 攻/守重叠对峙线）= 白色实线，稍细；
 *   · 阶段防线 = 白色实线，稍粗。
 * 此前 ActivityZones 与 PointMarkers 各自维护一份 Polyline 渲染块与常量，
 * 样式微调时两处容易漂移；合并到这里后样式只在一张表里改。
 */
const BOUNDARY_STYLE: Record<
  StageBoundaryOwner,
  { color: string; weight: number; opacity: number; dashArray: string; className: string }
> = {
  own: { color: '#01ff84', weight: 2.4, opacity: 0.9, dashArray: '6 4', className: 'demo-map-activity' },
  enemy: { color: '#e0453a', weight: 2.4, opacity: 0.9, dashArray: '6 4', className: 'demo-map-activity' },
  neutral: { color: '#01ff84', weight: 2.4, opacity: 0.9, dashArray: '6 4', className: 'demo-map-activity' },
  contested: { color: '#ffffff', weight: 2, opacity: 0.95, dashArray: '0', className: 'demo-map-capture' },
  frontline: { color: '#ffffff', weight: 2.5, opacity: 0.92, dashArray: '0', className: 'demo-map-frontline' },
}

interface BoundaryLinesProps {
  lines: StageBoundaryLine[]
  /** 目标 pane（图层顺序由 config/mapLayers 的 MAP_LAYER_ORDER 统一决定） */
  pane: string
  /** 绘制工具激活时传 false，避免边界线拦截鼠标事件 */
  interactive: boolean
  /** key 前缀（调用方按图层/阶段区分，保证同组件内唯一） */
  keyPrefix?: string
}

/** 一组阶段边界线的 Polyline 渲染（样式见 BOUNDARY_STYLE）。 */
export default function BoundaryLines({ lines, pane, interactive, keyPrefix = '' }: BoundaryLinesProps) {
  return (
    <>
      {lines.map((line) => {
        const style = BOUNDARY_STYLE[line.owner]
        return (
          <Polyline
            key={`${keyPrefix}${line.key}`}
            pane={pane}
            positions={line.points}
            pathOptions={{
              color: style.color,
              weight: style.weight,
              opacity: style.opacity,
              dashArray: style.dashArray,
              fillOpacity: 0,
              lineJoin: 'round',
              lineCap: 'round',
              className: style.className,
              interactive,
            }}
          />
        )
      })}
    </>
  )
}
