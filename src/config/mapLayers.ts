import * as L from 'leaflet'

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
 *
 * ---------------------------------------------------------------------------
 * 参考系契约（第二个必须遵守的规则）
 * ---------------------------------------------------------------------------
 *
 * leaflet-rotate 启用旋转后会建立两个并行的坐标系：
 *
 *   · **rotatePane（旋转参考系）**：瓦片 `tilePane` 与 Leaflet 默认矢量层
 *     `overlayPane` 都在其中。Leaflet 的矢量渲染器（`L.SVG` / `L.Canvas`）写出的
 *     坐标就是这一套——`_getNewPixelOrigin()` / `_getPaddedPixelBounds()` 都按
 *     bearing 做过旋转补偿。
 *   · **norotatePane（未旋转参考系）**，等价于 mapPane 坐标系：`markerPane` /
 *     `tooltipPane` / `popupPane` 在里面；`Marker._setPos` 会先调用
 *     `map.rotatedPointToMapPanePoint()` 把坐标换算过来。
 *
 * 本项目的自定义 pane **全部挂在 norotatePane 下**（这是 Marker 的硬性要求：见下），
 * 但**矢量图层放在 norotatePane 里会整体错位**：渲染器仍旧写旋转参考系的坐标，
 * 而 pane 没有跟着旋转，于是所有 Polyline / Polygon / Circle 会绕地图中心偏转一个
 * bearing。实测 bearing=30° 时断层阶段的活动区边界最大偏移 450px，并且缩放后按
 * 比例继续放大（这正是"旋转之后缩放时边界线位置错误"）。
 *
 * 为什么不能简单地把矢量层挪进 rotatePane：rotatePane 带 transform，是一个层叠
 * 上下文，它整体位于 norotatePane 子树之下——一旦挪进去，所有矢量层都会沉到
 * **全部 Marker 之下**，`capturePointPane` 与 `unitPane`、绘制层与兵棋图标之间的
 * 顺序契约立刻失效。
 *
 * 因此这里采用"每个 pane 内部再放一个矢量参考系容器"的方案：
 *   · 每个自定义 pane 里创建一个 `data-vector-frame` 容器，它镜像 rotatePane 的
 *     transform（leaflet-rotate 只在 `setBearing()` 里改写该 transform，并派发
 *     `rotate` 事件，因此同步点唯一且明确）；
 *   · 该 pane 的矢量渲染器被**预先注册**进 `map._paneRenderers`，于是
 *     `map.getRenderer()` 会按 pane 名命中它，所有矢量图层都落进参考系容器；
 *   · Marker 不受影响：它们直接挂在 pane 上（norotatePane 坐标系）。
 * 结果：矢量与 Marker 仍处在同一个 pane、同一个 z-index 区间，图层顺序一字不变，
 * 而两者的参考系各自正确。调用方不需要区分矢量与 Marker，照旧只写
 * `pane={layerPane('xxx')}`。
 */

export interface MapLayerSpec {
  /** Pane 名称（会变成 `leaflet-<name>-pane` 类名）。 */
  pane: string
  /** Pane 的 CSS z-index。数字之间刻意留大空档，便于日后插层。 */
  z: number
  /** 该层的用途说明，便于日后维护者判断插入位置。 */
  label: string
}

/**
 * 图层顺序表：数组顺序即叠放顺序（靠后者盖住靠前者）。
 *
 * 关键约定：
 * - `props`（弹药箱/防空炮/滑索等地图道具）必须在 `capturePoints`（据点）之下；
 * - `units`（步兵/载具/建筑/队标等兵棋）必须在 `capturePoints`（据点）之上；
 * - 绘制图形在一切矢量之上，编辑手柄/文本标记再上一层。
 *
 * 表中所有 pane 都是 norotatePane 的子节点；矢量图层由 pane 内部的参考系容器
 * 承载（见文件头说明），无需在表里区分矢量与 Marker。
 */
export const MAP_LAYER_ORDER: readonly MapLayerSpec[] = [
  // ---- 由 Leaflet 内置 pane 承载的层，这里只登记顺序语义 ----
  // tilePane(200) / overlayPane(400) / markerPane(600) / tooltipPane(650) 不在此表重排。

  // ---- 自定义层：边界线（必须在所有图标之下，见用户需求：瓦片<边界线<图标<弹出面板） ----
  { pane: 'activityZonePane', z: 410, label: '攻/守活动区与阶段防线边界线' },
  { pane: 'contestedZonePane', z: 420, label: '交战区边界线（白色，须在攻/守活动区边界线之上）' },

  // ---- 自定义层：图标（地图静态信息） ----
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
  { pane: 'drawMarkerPane', z: 1010, label: '文字标记' },
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

/** 矢量参考系容器的标记属性（同时方便在浏览器里直接排查）。 */
const VECTOR_FRAME_ATTR = 'data-vector-frame'

/** leaflet-rotate 写 transform 用的 CSS 属性名（现代引擎下就是 `transform`）。 */
const TRANSFORM_PROP = (L.DomUtil as unknown as { TRANSFORM?: string }).TRANSFORM || 'transform'

/**
 * map → 该地图上已创建的矢量参考系容器。
 *
 * 用 WeakMap 而不是模块级数组：同一页面可能存在多个 map 实例（切换地图时
 * MapContainer 会带 key 重建），容器的归属必须跟着 map 走。
 */
const vectorFrames = new WeakMap<L.Map, HTMLElement[]>()

/** 取自定义 pane 的父 pane：marker 必须留在 norotatePane 参考系里。 */
function layerPaneParent(map: L.Map): HTMLElement | undefined {
  return map.getPane('norotatePane') ?? map.getPane('mapPane') ?? undefined
}

/**
 * 把 rotatePane 的 transform 同步到全部矢量参考系容器。
 *
 * 只做这一件事就够：参考系容器与 rotatePane 是同一个父节点（mapPane）下的兄弟，
 * transform 相同即代表"两者坐标系的映射完全一致"，与平移/缩放/尺寸变化无关。
 * leaflet-rotate 只在 `setBearing()` 中改写 rotatePane 的 transform，并派发
 * `rotate` 事件，所以这里只需挂在 `rotate` 上。
 */
function syncVectorFrames(map: L.Map, frames: HTMLElement[]): void {
  // 未启用旋转时没有 rotatePane，参考系就是恒等变换（清掉 transform）
  const rotatePane = map.getPane('rotatePane')
  const transform = rotatePane ? rotatePane.style.getPropertyValue(TRANSFORM_PROP) : ''
  for (const frame of frames) {
    if (frame.style.getPropertyValue(TRANSFORM_PROP) === transform) continue
    if (transform) frame.style.setProperty(TRANSFORM_PROP, transform)
    else frame.style.removeProperty(TRANSFORM_PROP)
  }
}

/**
 * 按顺序表创建全部自定义 pane，并为每个 pane 准备矢量参考系容器与渲染器。
 *
 * 幂等：已存在的 pane / 容器 / 渲染器只校正，不重建；重复调用（本函数会从
 * MapView、LayerManager、RouteLayer 三处被调用）不会叠加事件监听。
 *
 * 必须在图层渲染前调用（放在 MapContainer 的子组件里即可）。
 */
export function ensureMapLayerPanes(map: L.Map): void {
  const frames = vectorFrames.get(map) ?? []
  // Leaflet 内部按 pane 名缓存渲染器；预先注册即可让矢量图层落进参考系容器
  const renderers = (map as unknown as { _paneRenderers?: Record<string, L.Renderer> })._paneRenderers

  for (const spec of MAP_LAYER_ORDER) {
    const pane = map.getPane(spec.pane) ?? map.createPane(spec.pane, layerPaneParent(map))
    if (!pane) continue
    pane.style.zIndex = String(spec.z)

    let frame = pane.querySelector<HTMLElement>(`[${VECTOR_FRAME_ATTR}]`)
    if (!frame) {
      frame = L.DomUtil.create('div', 'leaflet-pane leaflet-vector-frame', pane)
      frame.setAttribute(VECTOR_FRAME_ATTR, spec.pane)
    }
    if (!frames.includes(frame)) frames.push(frame)

    // 注意：这里**不能**给 pane 设 pointer-events:none。Leaflet 的规则是
    // `.leaflet-pane > svg path, .leaflet-tile-container { pointer-events: none }`
    // 加 `.leaflet-marker-icon, .leaflet-interactive { pointer-events: auto }`：
    // divIcon 标记靠 `.leaflet-interactive` 拿到事件，给 pane 加 pointer-events:none
    // 会让**所有**子标记一起失效。参考系容器尺寸为 0，本身不会拦截指针事件。
    if (renderers && !renderers[spec.pane] && L.Browser.svg) {
      // pane 允许传元素（map.getPane 对非字符串原样返回），这里借它把渲染器
      // 挂进参考系容器；类型上仍是 string，故做一次收窄。
      renderers[spec.pane] = new L.SVG({ pane: frame as unknown as string })
    }
  }

  if (!vectorFrames.has(map)) {
    const sync = () => syncVectorFrames(map, frames)
    map.on('rotate', sync)
    map.once('unload', () => map.off('rotate', sync))
    vectorFrames.set(map, frames)
  }
  syncVectorFrames(map, frames)

  // 弹出式面板置顶契约：Leaflet 内置 tooltipPane(650)/popupPane(700) 默认
  // 会被自定义高层（unitPane 800 ~ drawGizmoPane 1020）盖住，统一抬升到
  // 所有内容层之上。React 侧的模态/面板（--z-overlay 1000+）渲染在地图容器
  // 之外，天然更高，无需处理。
  const tooltipPane = map.getPane('tooltipPane')
  if (tooltipPane) tooltipPane.style.zIndex = '1040'
  const popupPane = map.getPane('popupPane')
  if (popupPane) popupPane.style.zIndex = '1060'
}
