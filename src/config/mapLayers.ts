import type * as L from 'leaflet'

/**
 * 地图图层顺序的唯一事实来源。
 *
 * 背景：此前每个图层各自在 `<Marker>` 上写 `zIndexOffset`（520 / 600 / 640 /
 * 650 / 720 / 760 / 800 / 820 / 1100 / 1200 / 1250 / 1300 / 2000 共十几种取值），
 * 而它们全都落在 Leaflet 默认的同一个 `markerPane`（z-index 600）里。同 pane 内的
 * 顺序实际由 **DOM 插入顺序** 决定，`zIndexOffset` 只是叠加在同一基准上——因此
 * "步兵/载具在据点上、弹药箱在据点下" 这类要求既不可见也不可维护：新增图层时
 * 只能靠猜。
 *
 * 现在改为 **一个图层一个 pane**，由本文件的 `MAP_LAYER_ORDER` 统一声明顺序，
 * 每个 pane 有显式且留出大量空档的 z-index。任何新图层（含后续可能引入的
 * 窗口化/悬浮窗）只需在表中插入一行并在渲染时传 `pane={layerPane('xxx')}`，
 * 不必再推算魔法数字。
 *
 * 契约（重要）：图层一旦显式指定 pane，就**不要再设 zIndexOffset**。pane 的
 * z-index 是唯一顺序依据；混用两者会让顺序重新变得不可预测。
 */

export interface MapLayerSpec {
  /** Pane 名称（会变成 `leaflet-<name>-pane` 类名）。 */
  pane: string
  /** Pane 的 CSS z-index。数字之间刻意留大空档，便于日后插层。 */
  z: number
  /** 该层的用途说明，便于日后维护者判断插入位置。 */
  label: string
  /**
   * 挂到哪个父 pane 下。默认挂在 rotatePane（随地图旋转的那一层）。
   * 需要"位置由 leaflet-rotate 独立换算、不参与 pane 旋转"的层（如文字标记、
   * 路线命中层）挂到 norotatePane。
   */
  parent?: 'rotate' | 'norotate'
}

/**
 * 图层顺序表：数组顺序即叠放顺序（靠后者盖住靠前者）。
 *
 * 关键约定：
 * - `props`（弹药箱/防空炮/滑索等地图道具）必须在 `capturePoints`（据点）之下；
 * - `units`（步兵/载具/建筑/队标等兵棋）必须在 `capturePoints` 之上；
 * - 绘制图形在一切矢量之上，编辑手柄/文本标记再上一层。
 */
export const MAP_LAYER_ORDER: readonly MapLayerSpec[] = [
  // ---- 由 Leaflet 内置 pane 承载的层，这里只登记顺序语义 ----
  // tilePane(200) / overlayPane(400) / markerPane(600) / tooltipPane(650) 不在此表重排。

  // ---- 自定义层：区域与地图静态信息 ----
  { pane: 'activityZonePane', z: 410, label: '活动区域（攻守活动区/大事件区）' },
  { pane: 'mapPropPane', z: 500, label: '地图道具（弹药箱/固定机枪/岸防炮/滑索/电梯）' },

  // ---- 自定义层：据点与复活点 ----
  { pane: 'capturePointPane', z: 620, label: '据点（图标/进度/占领状态）' },
  { pane: 'spawnPane', z: 630, label: '复活点与载具部署关联' },

  // ---- 自定义层：兵棋单位（必须在据点之上） ----
  { pane: 'vehicleRefreshPane', z: 700, label: '胜者为王载具刷新点' },
  { pane: 'unitPane', z: 800, label: '兵棋单位（步兵/载具/建筑/队标）' },

  // ---- 自定义层：路线与关系 ----
  { pane: 'connectionPane', z: 850, label: '干员协同关系线' },
  { pane: 'routePane', z: 900, label: '行动路线与队标' },
  { pane: 'fieldSupportPane', z: 910, label: '阵地支援范围' },
  { pane: 'skillActionPane', z: 915, label: '干员技能行动范围' },
  { pane: 'fireLinePane', z: 920, label: '枪线' },

  // ---- 绘制系统 ----
  { pane: 'drawPane', z: 1000, label: '画笔图形（线/箭头/矩形/圆/防线）' },
  { pane: 'drawMarkerPane', z: 1010, label: '文字标记（不参与旋转，避免双重偏移）', parent: 'norotate' },
  { pane: 'drawGizmoPane', z: 1020, label: '图形编辑手柄与选中框' },

  // ---- 路线命中层：需要贴近 overlayPane 的命中优先级 ----
  { pane: 'routeSelectedHitPane', z: 460, label: '路线命中区（透明，仅接收事件）' },
] as const

/** pane 名 → z-index / 父 pane，供创建与查询。 */
export const MAP_LAYER_BY_PANE: Record<string, MapLayerSpec> = Object.fromEntries(
  MAP_LAYER_ORDER.map((spec) => [spec.pane, spec]),
)

/** 取图层 pane 名，供组件直接传给 `pane=`。 */
export function layerPane(pane: string): string {
  return pane
}

/** 取图层 pane 的 z-index（未登记时抛错，避免静默使用错误层级）。 */
export function layerZ(pane: string): number {
  const spec = MAP_LAYER_BY_PANE[pane]
  if (!spec) throw new Error(`未在 MAP_LAYER_ORDER 中登记的图层 pane：${pane}`)
  return spec.z
}

/** 取指定图层的父 pane 元素（未建时返回 undefined，由 Leaflet 挂到 mapPane）。 */
function parentPaneOf(map: L.Map, spec: MapLayerSpec): HTMLElement | undefined {
  const parentName = spec.parent === 'norotate' ? 'norotatePane' : 'rotatePane'
  return map.getPane(parentName) ?? map.getPane('mapPane') ?? undefined
}

/**
 * 按顺序表创建全部自定义 pane。幂等：已存在的 pane 只校正 z-index。
 * 必须在图层渲染前调用（放在 MapContainer 的子组件里即可）。
 */
export function ensureMapLayerPanes(map: L.Map): void {
  for (const spec of MAP_LAYER_ORDER) {
    const existing = map.getPane(spec.pane)
    if (existing) {
      existing.style.zIndex = String(spec.z)
      continue
    }
    const pane = map.createPane(spec.pane, parentPaneOf(map, spec))
    if (pane) {
      pane.style.zIndex = String(spec.z)
      // 注意：这里**不能**设 pointer-events:none。Leaflet 的 marker pane 规则是
      // `.leaflet-pane > svg path, .leaflet-tile-container { pointer-events: none }`
      // 加上 `.leaflet-marker-icon, .leaflet-interactive { pointer-events: auto }`，
      // divIcon 标记带 leaflet-interactive 类因此可交互；若给 pane 加
      // pointer-events:none，会让**所有**子标记一起失效。
    }
  }
}
