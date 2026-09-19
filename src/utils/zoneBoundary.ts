/**
 * 区域边界线的"共享边消除"工具（第 6 项需求）。
 *
 * 问题：当前阶段的边界由三组多边形分别绘制——
 *   · 攻方活动区 attackBaseZone
 *   · 守方活动区 defenseBaseZone
 *   · 各据点的可占领区域 point.capturable（"交战区域"）
 * 这些多边形在数据上相邻、共边，于是**同一条边被画两遍**（一遍绿/红、一遍白），
 * 密集处表现为颜色互相压盖、线条变粗、端点出现生硬拼接与断点。
 *
 * 做法：把所有边界多边形放在一起，**抵消互相重叠/共线的边**，再把剩下的边首尾
 * 相接成连续折线。这样共享边只由最后一层（白色交战区域）负责绘制，而非共享的
 * 外轮廓仍然连续闭合，不会出现断点。
 *
 * 关键设计：不能只按"量化后的端点对"判重。真实数据里相邻多边形的**顶点密度不同**
 * ——一条长边可能被对面拆成 3 段，此时端点对根本对不上，判重会漏掉。因此改用
 * **几何包含判定**：若边 e1 的两个端点都落在线段 e2 上（垂距与投影参数都在容差内），
 * 就认为两者重叠并一起抵消。
 */

/** [lat, lng] */
export type LngLat = [number, number]
/** 一个环（顶点数组，隐式闭合） */
export type Ring = LngLat[]
interface PixelPoint { x: number; y: number }

/** 经纬度 → 像素投影，由调用方提供。 */
export type ProjectFn = (point: LngLat) => PixelPoint

/**
 * 共边判定容差（像素）。
 *
 * 注意：它只作为文档与调用方参考，**不能**写成函数参数默认值
 * （`tolerance = POINT_ON_EDGE_TOLERANCE_PX`）。TypeScript 会把 const 编译成
 * var 并提升，参数默认值在调用时求值会拿到 undefined，导致所有共边判定静默失效。
 * 因此下面各函数的默认值是内联的字面量 1.6。
 */
export const SHARED_EDGE_TOLERANCE_PX = 1.6
/** 退化边（长度小于该值）直接忽略 */
const MIN_EDGE_LENGTH_PX = 0.8

export interface Edge {
  a: LngLat
  b: LngLat
  ap: PixelPoint
  bp: PixelPoint
  minX: number
  minY: number
  maxX: number
  maxY: number
  /** 该边属于哪一个环（rings 数组下标）。 */
  ringIndex: number
}

function toEdge(a: LngLat, b: LngLat, project: ProjectFn, ringIndex: number): Edge | null {
  const ap = project(a)
  const bp = project(b)
  if (Math.hypot(bp.x - ap.x, bp.y - ap.y) < MIN_EDGE_LENGTH_PX) return null
  return {
    a, b, ap, bp, ringIndex,
    minX: Math.min(ap.x, bp.x), minY: Math.min(ap.y, bp.y),
    maxX: Math.max(ap.x, bp.x), maxY: Math.max(ap.y, bp.y),
  }
}

/** 环数组 → 边数组（隐式闭合；退化零长边丢弃；供各抵消/裁剪算法共用）。 */
function edgesOfRings(rings: Ring[], project: ProjectFn): Edge[] {
  const edges: Edge[] = []
  rings.forEach((ring, ringIndex) => {
    for (let i = 0; i < ring.length; i++) {
      const edge = toEdge(ring[i], ring[(i + 1) % ring.length], project, ringIndex)
      if (edge) edges.push(edge)
    }
  })
  return edges
}

/** 点 p 是否落在（或极接近）线段 e 上。 */
function pointOnEdge(p: PixelPoint, e: Edge, tolerance: number): boolean {
  const dx = e.bp.x - e.ap.x
  const dy = e.bp.y - e.ap.y
  const lengthSq = dx * dx + dy * dy
  if (lengthSq < 1e-9) return false
  // 投影参数 t：0=起点 1=终点
  const t = ((p.x - e.ap.x) * dx + (p.y - e.ap.y) * dy) / lengthSq
  if (t < 0 || t > 1) {
    // 允许略微超出端点（共享边端点常因取整而错开）
    const slack = tolerance / Math.sqrt(lengthSq)
    if (t < -slack || t > 1 + slack) return false
  }
  // 垂距
  const cross = Math.abs((p.x - e.ap.x) * dy - (p.y - e.ap.y) * dx) / Math.sqrt(lengthSq)
  return cross <= tolerance
}

/** 两条边的包围盒在扩展容差后是否相交（用于跳过明显无关的边）。 */
function boxesNear(a: Edge, b: Edge, tolerance: number): boolean {
  return !(a.maxX + tolerance < b.minX || b.maxX + tolerance < a.minX
    || a.maxY + tolerance < b.minY || b.maxY + tolerance < a.minY)
}

/** 一条边被另一条"覆盖"：两端点都落在对方上。 */
function edgeCoveredBy(e: Edge, other: Edge, tolerance: number): boolean {
  if (!boxesNear(e, other, tolerance)) return false
  return pointOnEdge(e.ap, other, tolerance) && pointOnEdge(e.bp, other, tolerance)
}

/**
 * 收集所有环的边，并标记出"被其它边覆盖"的边。
 * 采用**对称判定**：e1 覆盖 e2 或 e2 覆盖 e1，都视为重叠，两条一起抵消。
 * 这样即使一侧被拆成多段、另一侧是一条长边，也能正确抵消。
 *
 * **只在"不同环之间"抵消**（关键）：
 * 真实数据里有些活动区多边形是"自相接触"的——同一个顶点在环里出现 3~4 次，
 * 边界在某处折返并与自己重叠（断层 S1 攻方活动区 67 点里有 22 个重复顶点、
 * 烬区 S1 有 17 个，而正常的地图如斗兽场只有 1 个）。若允许同环内部互相抵消，
 * 这些本来各自需要画出来的边会被成对抹掉，实测**整个环的边 100% 被抵消**，
 * 边界完全消失——这正是"断层、烬区（以及断轨）非交战区边界绘制异常、且不同
 * 阶段表现不同"的原因：重复顶点的数量逐阶段变化，被抹掉的比例也就不同。
 * 因此比较时要求 `ringIndex` 不同，环内部的自身重叠一律保留。
 *
 * 返回值同时给出边数组与共享集合，二者引用同一批对象——调用方**必须**用这里
 * 返回的数组做过滤，否则重新构造的 Edge 对象无法被 Set 命中（引用不相等）。
 */
export function collectSharedEdges(rings: Ring[], project: ProjectFn, tolerance: number): { edges: Edge[]; shared: Set<Edge> } {
  const edges = edgesOfRings(rings, project)
  const shared = new Set<Edge>()
  // 边界数量在千级以内，简单双重循环 + 包围盒早退足够；
  // boxesNear 会把绝大多数无关边对直接跳过。
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const e1 = edges[i]
      const e2 = edges[j]
      // 同一个环内部的重叠（自相接触多边形）不参与抵消，见上方说明
      if (e1.ringIndex === e2.ringIndex) continue
      if (shared.has(e1) && shared.has(e2)) continue
      if (!boxesNear(e1, e2, tolerance)) continue
      if (edgeCoveredBy(e1, e2, tolerance) || edgeCoveredBy(e2, e1, tolerance)) {
        shared.add(e1)
        shared.add(e2)
      }
    }
  }
  return { edges, shared }
}

/** 取所有环中"未被共享"的边。 */
export function exclusiveBoundaryEdges(
  rings: Ring[],
  project: ProjectFn,
  tolerance: number = 1.6,
): Array<[LngLat, LngLat]> {
  const { edges, shared } = collectSharedEdges(rings, project, tolerance)
  return edges.filter((edge) => !shared.has(edge)).map((edge) => [edge.a, edge.b])
}

/**
 * 从散边中挖掉"与任一环的边重合"的部分（用于已经按归属拆分好、不能再当成
 * 闭合环参与抵消的线段集合——例如攻/防活动区按重叠关系切开后的外侧部分）。
 *
 * 为什么不能只做"整条边被覆盖才丢弃"：真实数据里活动区常用**一条长边**对齐
 * 交战区的**多条短边**（顶点密度不同）。整条判定时长边两端点落不到任何一条
 * 短边上，裁剪漏掉，于是粗虚线与白色实线并排画出，白线被顶成"断线"。
 * 这里改为把环边的端点**投影**到待裁剪边上作为切点，先切开再逐子段判定，
 * 长边只挖掉真正重合的那几段，其余部分保留。
 */
export function clipEdgesByRings(
  segments: Array<[LngLat, LngLat]>,
  rings: Ring[],
  project: ProjectFn,
  tolerance: number = 1.6,
): Array<[LngLat, LngLat]> {
  if (!segments.length || !rings.length) return segments
  const covering = edgesOfRings(rings, project)

  /** 点 p 在线段 e 上的投影参数 t；不在容差内返回 null。 */
  const projectionT = (p: PixelPoint, ap: PixelPoint, bp: PixelPoint): number | null => {
    const dx = bp.x - ap.x
    const dy = bp.y - ap.y
    const lengthSq = dx * dx + dy * dy
    if (lengthSq < 1e-9) return null
    const t = ((p.x - ap.x) * dx + (p.y - ap.y) * dy) / lengthSq
    if (t <= 0 || t >= 1) return null
    const cross = Math.abs((p.x - ap.x) * dy - (p.y - ap.y) * dx) / Math.sqrt(lengthSq)
    return cross <= tolerance ? t : null
  }

  const result: Array<[LngLat, LngLat]> = []
  for (const [a, b] of segments) {
    const edge = toEdge(a, b, project, -1)
    if (!edge) continue // 退化边不保留
    // 1) 收集切点：所有"贴上"该边的环边端点投影
    const cuts = [0, 1]
    for (const other of covering) {
      if (!boxesNear(edge, other, tolerance)) continue
      const t1 = projectionT(other.ap, edge.ap, edge.bp)
      if (t1 !== null) cuts.push(t1)
      const t2 = projectionT(other.bp, edge.ap, edge.bp)
      if (t2 !== null) cuts.push(t2)
    }
    cuts.sort((x, y) => x - y)
    // 2) 逐子段判定：中点贴上任一环边 → 该子段重合，丢弃
    for (let k = 0; k + 1 < cuts.length; k++) {
      const t0 = cuts[k]
      const t1 = cuts[k + 1]
      if (t1 - t0 < 1e-9) continue
      const lerpP = (t: number): PixelPoint => ({
        x: edge.ap.x + (edge.bp.x - edge.ap.x) * t,
        y: edge.ap.y + (edge.bp.y - edge.ap.y) * t,
      })
      const lerpLL = (t: number): LngLat => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
      const mid = lerpP((t0 + t1) / 2)
      const overlapped = covering.some((other) => boxesNear(edge, other, tolerance) && pointOnEdge(mid, other, tolerance))
      if (overlapped) continue
      const sa = lerpLL(t0)
      const sb = lerpLL(t1)
      const sp = lerpP(t0)
      const sq = lerpP(t1)
      if (Math.hypot(sq.x - sp.x, sq.y - sp.y) < MIN_EDGE_LENGTH_PX) continue
      result.push([sa, sb])
    }
  }
  return result
}

/** 端点 key：把像素点量化到容差网格，用于拼接时判断"同一点"。 */
function pointKey(point: PixelPoint, tolerance: number): string {
  return `${Math.round(point.x / tolerance)}:${Math.round(point.y / tolerance)}`
}

/**
 * 把散落的边首尾相接成连续折线。
 *
 * 这是"避免断点、不连续、生硬拼接"的关键：逐条画线段会产生大量 lineCap/lineJoin
 * 拼接痕迹；接成折线后由 Leaflet 统一绘制，转折处才是真正的 round/miter join。
 */
export function chainEdges(
  edges: Array<[LngLat, LngLat]>,
  project: ProjectFn,
  tolerance: number = 1.6,
): Ring[] {
  const remaining = [...edges]
  const chains: Ring[] = []

  while (remaining.length) {
    const [first] = remaining.splice(0, 1)
    const chain: Ring = [first[0], first[1]]
    let grew = true
    while (grew) {
      grew = false
      const headKey = pointKey(project(chain[0]), tolerance)
      const tailKey = pointKey(project(chain[chain.length - 1]), tolerance)
      for (let i = 0; i < remaining.length; i++) {
        const [a, b] = remaining[i]
        const aKey = pointKey(project(a), tolerance)
        const bKey = pointKey(project(b), tolerance)
        if (tailKey === aKey) { chain.push(b); remaining.splice(i, 1); grew = true; break }
        if (tailKey === bKey) { chain.push(a); remaining.splice(i, 1); grew = true; break }
        if (headKey === bKey) { chain.unshift(a); remaining.splice(i, 1); grew = true; break }
        if (headKey === aKey) { chain.unshift(b); remaining.splice(i, 1); grew = true; break }
      }
    }
    chains.push(chain)
  }
  return chains
}

/** 一步到位：多组环 → 去掉共享边后的连续折线组。 */
export function dissolveSharedBorders(
  rings: Ring[],
  project: ProjectFn,
  tolerance: number = 1.6,
): Ring[] {
  return chainEdges(exclusiveBoundaryEdges(rings, project, tolerance), project, tolerance)
}
