import type * as L from 'leaflet'

/**
 * 画布对象的键盘可访问路径。
 *
 * 背景：全项目所有 Leaflet marker 都显式写了 `keyboard: false`
 * （LayerManager.tsx 有 8 处），加上编辑器只在图形上有手柄而没有任何键盘等价
 * 操作，整个画布此前只能用鼠标/触控操作。这个模块补上最小可用的键盘路径：
 *
 *   Tab / Shift+Tab  在地图对象之间移动焦点（标记本身 tabindex=0）
 *   ←→↑↓            在屏幕上把对象移动 2px（Shift 加大到 10px）
 *   Delete/Backspace 删除当前聚焦对象
 *   Escape           取消焦点（退回地图）
 *
 * 用**屏幕像素**而不是经纬度做位移：本项目用 L.CRS.Simple 且地图可旋转，
 * 经纬度轴与屏幕方向并不一致（Y 轴向下为负），直接加减 lat/lng 会导致方向
 * 反直觉。containerPoint 是屏幕坐标，与用户看到的方向天然一致。
 *
 * 事件通过 document 层委派完成，不修改各图层的 marker 配置——那些
 * `keyboard: false` 是刻意设置的历史行为（避免 Leaflet 自带键盘处理与自研
 * 交互打架），这里只针对显式带 `data-kb-unit` 的元素响应。
 */

export type KeyboardUnitKind = 'operator' | 'vehicle' | 'building' | 'team'

export interface KeyboardUnitHandlers {
  /** 当前可聚焦对象的坐标表，由各图层在渲染时维护。 */
  positionOf: (kind: KeyboardUnitKind, uid: string) => [number, number] | undefined
  move: (kind: KeyboardUnitKind, uid: string, lat: number, lng: number) => void
  remove: (kind: KeyboardUnitKind, uid: string) => void
}

const STEP_PX = 2
const STEP_PX_LARGE = 10
const HANDLED_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Delete', 'Backspace', 'Escape'])

/** 从事件目标向上找到带 data-kb-unit 的宿主元素。 */
function resolveUnit(target: EventTarget | null): { el: HTMLElement; kind: KeyboardUnitKind; uid: string } | null {
  if (!(target instanceof HTMLElement)) return null
  const el = target.closest<HTMLElement>('[data-kb-unit]')
  if (!el) return null
  const uid = el.dataset.kbUid
  const kind = el.dataset.kbUnit as KeyboardUnitKind | undefined
  if (!uid || !kind) return null
  return { el, kind, uid }
}

/** 输入类控件内部的按键不应被画布键盘处理吞掉。 */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"], .text-marker-editing'))
}

export function mapKeyboardDelta(key: string, large: boolean): { dx: number; dy: number } | null {
  const step = large ? STEP_PX_LARGE : STEP_PX
  switch (key) {
    case 'ArrowUp': return { dx: 0, dy: -step }
    case 'ArrowDown': return { dx: 0, dy: step }
    case 'ArrowLeft': return { dx: -step, dy: 0 }
    case 'ArrowRight': return { dx: step, dy: 0 }
    default: return null
  }
}

/**
 * 安装画布键盘处理。返回卸载函数，供 useEffect 清理。
 * 需要传入 Leaflet map 实例以做屏幕坐标换算。
 */
export function installCanvasKeyboard(map: L.Map, handlers: KeyboardUnitHandlers): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (!HANDLED_KEYS.has(event.key)) return
    if (event.ctrlKey || event.metaKey || event.altKey) return
    const unit = resolveUnit(event.target)
    if (!unit) return
    if (isTextEntry(event.target)) return

    if (event.key === 'Escape') {
      event.preventDefault()
      unit.el.blur()
      return
    }

    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      event.stopPropagation()
      // 避免同时触发 App 的"删除选中图形"快捷键（Backspace）。
      handlers.remove(unit.kind, unit.uid)
      return
    }

    const delta = mapKeyboardDelta(event.key, event.shiftKey)
    if (!delta) return
    const current = handlers.positionOf(unit.kind, unit.uid)
    if (!current) return
    event.preventDefault()
    event.stopPropagation()

    const [lat, lng] = current
    const point = map.latLngToContainerPoint([lat, lng] as L.LatLngExpression)
    const moved = map.containerPointToLatLng(point.add([delta.dx, delta.dy] as L.PointExpression))
    handlers.move(unit.kind, unit.uid, moved.lat, moved.lng)
  }

  // 捕获阶段监听：先于 App 的 document keydown（冒泡阶段）处理 Backspace，
  // 这样 focus 在画布对象上时不会误删选中的图形。
  document.addEventListener('keydown', onKeyDown, true)
  return () => document.removeEventListener('keydown', onKeyDown, true)
}

/**
 * 标记宿主元素应带的可访问性属性。
 * 返回可直接拼进 divIcon html 的字符串片段。
 */
export function keyboardUnitAttrs(kind: KeyboardUnitKind, uid: string, label: string): string {
  return `data-kb-unit="${kind}" data-kb-uid="${uid}" tabindex="0" role="button" aria-label="${label}"`
}
