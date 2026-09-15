import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties, MutableRefObject } from 'react'
import { MapContainer, Marker, TileLayer, useMap, useMapEvents } from 'react-leaflet'
import * as L from 'leaflet'
import 'leaflet-rotate'
import type {
  ActiveTextEdit,
  BuildingUnit,
  CapturePoint,
  DrawSettings,
  MapConfig,
  MapProp,
  MapState,
  ModeVehicleRefreshPoint,
  ModeVehicleRefreshRule,
  OperatorConnection,
  OperatorUnit,
  PointStatus,
  Side,
  StageConfig,
  TacticalRoute,
  TeamMarker,
  TacticalBattleContext,
  TacticalObjectiveState,
  ToolMode,
  VehicleItem,
  WargameState,
} from '../types'
import { genUid, mapBounds } from '../utils/geo'
import LayerManager from './LayerManager'
import VehicleLayer from './VehicleLayer'
import BuildingLayer from './BuildingLayer'
import OperatorLayer from './OperatorLayer'
import TeamLayer from './TeamLayer'
import RouteLayer from './RouteLayer'
import UnitFireLineLayer from './UnitFireLineLayer'
import type { RouteDraftSource, RouteSnapTarget } from './RouteLayer'
import RouteEditorPanel from './RouteEditorPanel'
import ConnectionLayer from './ConnectionLayer'
import FieldSupportLayer from './FieldSupportLayer'
import OperatorSkillLayer from './OperatorSkillLayer'
import OpBubble from './OpBubble'
import OpRenameBar from './OpRenameBar'
import PointMarkers, { defaultObjectiveState, objectiveProgressColor, objectiveStateColor } from './PointMarkers'
import SpawnMarkers from './SpawnMarkers'
import ActivityZones from './ActivityZones'
import MapPropsLayer from './MapPropsLayer'
import type { LayerVisibility, PropVisibility } from '../types'
import { platform } from '../platform'
import { installCanvasKeyboard, type KeyboardUnitKind } from '../utils/canvasKeyboard'
import { ensureMapLayerPanes, layerPane } from '../config/mapLayers'
import VehicleRefreshLayer, { type RuntimeVehicleRefreshPoint, type RuntimeVehicleRefreshRule } from './VehicleRefreshLayer'
import type { StageDeploy } from '../config/deployVehicles'
import { rangeProgressStyle } from '../utils/rangeStyle'

/**
 * 指南针中心死区半径（px）。
 * 中心读数按钮直径 34px（半径 17px），四个方向槽位位于半径 27px 处，
 * 因此死区取 18px —— 既能排除中心按钮，又不会把方向槽位一起排除掉。
 */
const CENTER_DEAD_ZONE_PX = 18

interface OfficialModeMapData {
  stages: StageConfig[]
  props: MapProp[]
  vehicleRefreshPoints: Omit<ModeVehicleRefreshPoint, 'verification'>[]
  vehicleRefreshRules: Omit<ModeVehicleRefreshRule, 'verification'>[]
  deploy: Record<string, StageDeploy>
}

function SkillActionPlacement({ active, onPlace, onCancel }: { active: boolean; onPlace: (lat: number, lng: number) => void; onCancel: () => void }) {
  const map = useMapEvents({ click: (event) => { if (active) onPlace(event.latlng.lat, event.latlng.lng) }, contextmenu: () => { if (active) onCancel() } })
  useEffect(() => {
    if (!active) return
    const container = map.getContainer()
    container.classList.add('placing-operator-skill')
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') onCancel() }
    window.addEventListener('keydown', keydown)
    return () => { container.classList.remove('placing-operator-skill'); window.removeEventListener('keydown', keydown) }
  }, [active, map, onCancel])
  return null
}

/**
 * Leaflet starts map panning from a container-level mousedown listener. Waiting
 * until a marker/path dragstart is too late: after map rotation, events can pass
 * through different panes and both drag handlers may already be active.
 *
 * Lock panning in the capture phase while still allowing the target layer to
 * receive the event. Restore exactly the state that existed before the press,
 * including when the pointer is released outside the map.
 */
function InteractiveLayerPanGuard() {
  const map = useMap()
  useEffect(() => {
    const container = map.getContainer()
    let active = false
    let restoreDragging = false

    const isLayerInteraction = (event: Event) => {
      const target = event.target
      if (!(target instanceof Element)) return false
      return Boolean(target.closest([
        '.leaflet-marker-draggable',
        '.route-hit-area',
        '.draw-hit-area',
        '.draw-text-hit-wrap',
        '.edit-selection-box',
      ].join(', ')))
    }
    const lock = (event: Event) => {
      if (active || !isLayerInteraction(event)) return
      active = true
      restoreDragging = map.dragging.enabled()
      if (restoreDragging) map.dragging.disable()
    }
    const release = () => {
      if (!active) return
      active = false
      if (restoreDragging && !map.dragging.enabled()) map.dragging.enable()
      restoreDragging = false
    }

    // Capture runs before Leaflet's map dragging listener. Do not stop the
    // event: markers, route handles and drawing gizmos still need the press.
    container.addEventListener('pointerdown', lock, true)
    container.addEventListener('mousedown', lock, true)
    container.addEventListener('touchstart', lock, { capture: true, passive: true })
    document.addEventListener('pointerup', release, true)
    document.addEventListener('pointercancel', release, true)
    document.addEventListener('mouseup', release, true)
    document.addEventListener('touchend', release, true)
    document.addEventListener('touchcancel', release, true)
    window.addEventListener('blur', release)
    return () => {
      release()
      container.removeEventListener('pointerdown', lock, true)
      container.removeEventListener('mousedown', lock, true)
      container.removeEventListener('touchstart', lock, true)
      document.removeEventListener('pointerup', release, true)
      document.removeEventListener('pointercancel', release, true)
      document.removeEventListener('mouseup', release, true)
      document.removeEventListener('touchend', release, true)
      document.removeEventListener('touchcancel', release, true)
      window.removeEventListener('blur', release)
    }
  }, [map])
  return null
}

/** 文字标注编辑期间冻结地图手势，并在结束后恢复进入编辑前的状态。 */
function TextEditMapLock({ active }: { active: boolean }) {
  const map = useMap()
  useEffect(() => {
    if (!active) return
    const controls = [map.dragging, map.scrollWheelZoom, map.touchZoom, map.doubleClickZoom, map.boxZoom]
    const enabled = controls.map((control) => control.enabled())
    controls.forEach((control) => control.disable())
    return () => {
      controls.forEach((control, index) => {
        if (enabled[index]) control.enable()
      })
    }
  }, [active, map])
  return null
}

/**
 * 地图右下角控件组（第 9 项）。
 *
 * 顺序从左到右固定为：全屏 / 退出全屏、Zoom in、Zoom out。
 *
 * 为什么三者放在**同一个 Leaflet 控件**里：Leaflet 的 bottomright 角是竖向堆叠
 * 容器，分别注册三个控件会变成上下排列而非横向成组；放同一控件内既能保证顺序，
 * 也能共用一套边框与分隔线。
 *
 * 配色修正：Leaflet 自带 zoom 控件此前沿用浏览器默认的浅色按钮（与暗色军事风格
 * 冲突），这里统一为与顶栏一致的 --bg-btn 底 + --tx-1 字，hover 强调绿，
 * 并按缩放级别维护禁用态。
 */
function MapCornerControls() {
  const map = useMap()
  useEffect(() => {
    /**
     * 用**独立控件**承载每个按钮，而不是把三个按钮塞进一个控件。
     *
     * 这样每个控件都是独立的 `.leaflet-control` 盒子，CSS 可以用绝对定位把它们
     * 钉在同一行（需求：从左到右 全屏、zoom in、zoom out），而不受 Leaflet
     * 角落容器"竖向堆叠"规则的限制。
     *
     * 每个控件带 `data-corner-order`（1=全屏 2=放大 3=缩小），CSS 依此定位——
     * 比用 :nth-child 稳，Leaflet 在 addTo 时会把控件从角落容器里取出再插回，
     * DOM 顺序并不总是注册顺序。
     */
    const controls: L.Control[] = []
    let disposed = false

    const addControl = (order: number, build: () => { el: HTMLElement; cleanup?: () => void }) => {
      const control = new L.Control({ position: 'bottomright' })
      control.onAdd = () => {
        const container = L.DomUtil.create('div', 'leaflet-control')
        container.setAttribute('data-corner-order', String(order))
        L.DomEvent.disableClickPropagation(container)
        L.DomEvent.disableScrollPropagation(container)
        const { el, cleanup } = build()
        container.appendChild(el)
        ;(container as HTMLElement & { _cleanup?: () => void })._cleanup = cleanup
        return container
      }
      control.onRemove = () => {
        const container = control.getContainer() as (HTMLElement & { _cleanup?: () => void }) | undefined
        container?._cleanup?.()
        const index = controls.indexOf(control)
        if (index >= 0) controls.splice(index, 1)
      }
      control.addTo(map)
      if (!disposed) controls.push(control)
      return control
    }

    const ENTER_ICON = '<path d="M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4"/>'
    const EXIT_ICON = '<path d="M2 6h4V2M14 6h-4V2M2 10h4v4M14 10h-4v4"/>'

    // 1) 全屏 / 退出全屏（Android 由原生层沉浸式全屏，CSS 会隐藏此按钮）
    addControl(1, () => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'map-corner-btn map-corner-fullscreen'
      const render = () => {
        const active = platform.isFullscreen()
        button.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${active ? EXIT_ICON : ENTER_ICON}</svg>`
        button.title = active ? '退出全屏' : '全屏'
        button.setAttribute('aria-label', active ? '退出全屏' : '全屏')
        button.setAttribute('aria-pressed', String(active))
      }
      render()
      L.DomEvent.on(button, 'click', (event) => {
        L.DomEvent.stop(event)
        void platform.toggleFullscreen()
        window.setTimeout(render, 120)
      })
      return { el: button }
    })

    // 2) Zoom in / 3) Zoom out（与滚轮缩放走同一条 Leaflet 路径）
    const addZoom = (order: number, title: string, zoomIn: boolean) => {
      addControl(order, () => {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'map-corner-btn'
        const glyph = zoomIn ? '<path d="M8 3.5v9M3.5 8h9"/>' : '<path d="M3.5 8h9"/>'
        button.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">${glyph}</svg>`
        button.title = title
        button.setAttribute('aria-label', title)
        L.DomEvent.on(button, 'click', (event) => {
          L.DomEvent.stop(event)
          if (zoomIn) map.zoomIn()
          else map.zoomOut()
        })
        const sync = () => {
          button.disabled = zoomIn ? map.getZoom() >= map.getMaxZoom() : map.getZoom() <= map.getMinZoom()
        }
        map.on('zoomend', sync)
        sync()
        return { el: button, cleanup: () => map.off('zoomend', sync) }
      })
    }
    addZoom(2, '放大', true)
    addZoom(3, '缩小', false)

    return () => {
      disposed = true
      for (const control of controls) control.remove()
      controls.length = 0
    }
  }, [map])
  return null
}

/**
 * 地图旋转 / 指南针控件（重构版）。
 *
 * 设计要求：
 * - 位于地图区域的真正左上角（随左侧面板开合贴在面板右侧，即"地图的左上角"）；
 * - 不再有悬浮层、不再有收起/展开按钮、不再有 ↶/↷ 步进按钮与独立数字输入框；
 * - hover 到表盘上的 N/E/S/W 时浮现对应方向的按钮，点击即旋转到该方向；
 * - 点击表盘正中心时，中心显示当前角度并切换为可编辑数字，回车确定、失焦确定、
 *   Esc 取消；编辑期间表盘仍可拖动，两者双向同步；
 * - 指针仍可按住拖动无级旋转。
 */
function MapRotationControl() {
  const map = useMap()
  const dialRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [bearing, setBearing] = useState(() => map.getBearing?.() ?? 0)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  /** 当前 hover 的表盘方向；决定哪个方向按钮浮现。 */
  const [hoverDir, setHoverDir] = useState('')

  /**
   * 指南针必须是一个**真正的 Leaflet 控件**：内容由 React 通过 portal 渲染进
   * Leaflet 创建的控制容器。
   *
   * 早期版本直接 `return <div className="map-rotation-control">…`，这个 div 会被
   * React 放进 map 容器内部，于是：
   *   · 不进入 `.leaflet-top.leaflet-left`，拿不到「随左侧面板让位」的
   *     `left: var(--left-panel-w)`，指南针被压在战术面板下面；
   *   · 成为地图容器里一个普通绝对定位子元素，层叠与其它控件不可控；
   *   · 放大（rotate 后）行为也随之异常。
   * 注册为控件后，位置、层叠与 Leaflet 其它控件一致，且 rotate 不会影响它
   * （控制容器不在 mapPane 内，不参与地图旋转）。
   */
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    const control = new L.Control({ position: 'topleft' })
    control.onAdd = () => {
      const container = L.DomUtil.create('div', 'leaflet-control map-rotation-control') as HTMLDivElement
      // 阻止 Leaflet 把控件内的指针事件当作地图拖动/缩放
      L.DomEvent.disableClickPropagation(container)
      L.DomEvent.disableScrollPropagation(container)
      setHost(container)
      return container
    }
    control.onRemove = () => setHost(null)
    control.addTo(map)
    return () => { control.remove() }
  }, [map])

  /**
   * 由指针相对表盘中心的角度判断当前悬停的方向（90° 扇区）。
   * 用 `atan2(x, -y)` 与拖动旋转同一套换算，保证"靠近哪个字母就浮现哪个"。
   */
  /**
   * 判断指针当前悬停在哪个方向，用于浮现对应按钮。
   *
   * 判定分两级，优先用真实命中，避免"看着在 N 上、却浮现 E"：
   *   1) 指针是否直接落在某个槽位/按钮上（这正是用户看到的字母）；
   *   2) 否则按相对表盘中心的角度取最近的 45° 扇区。
   *
   * 中心死区按实际几何设定：中心读数按钮直径 34px（半径 17px），
   * 四个方向槽位在半径 27px 处，因此死区取 18px —— 既能排除中心按钮，
   * 又不会把槽位一起排除掉（早期用 width*0.18≈13.7px 偏小，
   * 后来误改成更大会直接把 27px 的槽位也吃掉）。
   */
  const directionFromPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    const compass = event.currentTarget
    const rect = compass.getBoundingClientRect()
    const x = event.clientX - (rect.left + rect.width / 2)
    const y = event.clientY - (rect.top + rect.height / 2)

    // 1) 直接命中某个方向槽位（屏幕上看到的字母）
    const direct = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-bearing-dir]')
    if (direct) return direct.getAttribute('data-bearing-dir') ?? ''

    // 2) 角度扇区
    const radius = Math.hypot(x, y)
    if (radius < CENTER_DEAD_ZONE_PX) return ''
    const angle = ((Math.atan2(x, -y) * 180 / Math.PI) + 360) % 360
    if (angle >= 315 || angle < 45) return 'north'
    if (angle < 135) return 'east'
    if (angle < 225) return 'south'
    return 'west'
  }

  /** 归一化到 [0, 360) */
  const normalize = (value: number) => ((value % 360) + 360) % 360

  // 平滑旋转：方向按钮点击时按最短路径做 rAF 缓动。
  const animRef = useRef({ id: 0, raf: 0 })
  const cancelAnimation = useCallback(() => {
    animRef.current.id += 1
    window.cancelAnimationFrame(animRef.current.raf)
    animRef.current.raf = 0
    map.getContainer().classList.remove('map-bearing-animating')
  }, [map])
  const animateTo = useCallback((target: number) => {
    cancelAnimation()
    const animId = animRef.current.id
    const from = map.getBearing?.() ?? 0
    // 最短路径插值：避免从 350° 转到 0° 时反着绕一整圈
    const delta = ((target - from) % 360 + 540) % 360 - 180
    if (Math.abs(delta) < 0.01) return
    map.getContainer().classList.add('map-bearing-animating')
    const start = performance.now()
    const duration = 320
    const tick = (now: number) => {
      if (animId !== animRef.current.id) return
      const progress = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - progress, 3)
      map.setBearing(from + delta * eased)
      if (progress < 1) animRef.current.raf = window.requestAnimationFrame(tick)
      else {
        animRef.current.raf = 0
        map.getContainer().classList.remove('map-bearing-animating')
      }
    }
    animRef.current.raf = window.requestAnimationFrame(tick)
  }, [cancelAnimation, map])

  // 地图旋转 → 同步表盘（编辑中不覆盖用户正在输入的内容）
  useEffect(() => {
    const update = () => setBearing(normalize(map.getBearing?.() ?? 0))
    map.on('rotate', update)
    update()
    return () => { map.off('rotate', update) }
  }, [map])

  // 按住表盘拖动：无级旋转
  useEffect(() => {
    const dial = dialRef.current
    if (!dial) return
    let dragging = false
    const setFromPointer = (event: PointerEvent) => {
      const rect = dial.getBoundingClientRect()
      const x = event.clientX - (rect.left + rect.width / 2)
      const y = event.clientY - (rect.top + rect.height / 2)
      map.setBearing(Math.atan2(x, -y) * 180 / Math.PI)
    }
    const onMove = (event: PointerEvent) => {
      if (!dragging) return
      event.preventDefault()
      setFromPointer(event)
    }
    const finish = () => {
      dragging = false
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', finish)
      document.removeEventListener('pointercancel', finish)
    }
    const onDown = (event: PointerEvent) => {
      // 中心读数按钮与四个方向按钮自行处理点击，不进入拖动
      if ((event.target as HTMLElement).closest('.map-bearing-pivot, .bearing-direction')) return
      event.preventDefault()
      event.stopPropagation()
      cancelAnimation()
      dragging = true
      setFromPointer(event)
      document.addEventListener('pointermove', onMove, { passive: false })
      document.addEventListener('pointerup', finish)
      document.addEventListener('pointercancel', finish)
    }
    dial.addEventListener('pointerdown', onDown)
    return () => {
      dial.removeEventListener('pointerdown', onDown)
      finish()
      cancelAnimation()
    }
  }, [cancelAnimation, map])

  const commitDraft = useCallback(() => {
    const value = Number(draft)
    if (Number.isFinite(value) && draft.trim() !== '') map.setBearing(normalize(value))
    setEditing(false)
  }, [draft, map])

  const startEditing = useCallback(() => {
    cancelAnimation()
    setDraft((map.getBearing?.() ?? 0).toFixed(1).replace(/\.0$/, ''))
    setEditing(true)
  }, [cancelAnimation, map])

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  const DIRECTIONS = [
    { key: 'north', label: 'N', target: 0, title: '正北朝上' },
    { key: 'east', label: 'E', target: 90, title: '正东朝上' },
    { key: 'south', label: 'S', target: 180, title: '正南朝上' },
    { key: 'west', label: 'W', target: 270, title: '正西朝上' },
  ] as const

  // 渲染进 Leaflet 控件容器（host 由上方的 L.Control 创建）。
  // 注意这里不再额外包一层 .map-rotation-control：类名已经挂在 Leaflet 容器上。
  return host ? createPortal(
    <div
      className={`map-bearing-compass${hoverDir ? ` hover-${hoverDir}` : ''}`}
        ref={dialRef}
        role="group"
        aria-label={`地图旋转控件，当前 ${bearing.toFixed(1)} 度`}
        onPointerMove={(event) => {
          const next = directionFromPointer(event)
          setHoverDir((current) => (current === next ? current : next))
        }}
        onPointerLeave={() => setHoverDir('')}
        onPointerDownCapture={(event) => {
          // 阻止 Leaflet 把指针事件当作地图拖动
          event.stopPropagation()
        }}
        onWheelCapture={(event) => event.stopPropagation()}
        onDoubleClickCapture={(event) => event.stopPropagation()}
      >
        {/* 表盘（刻度 + 四向标签 + 指针）整体随地图角度旋转，
            这样 N 始终指向地图正北；指针自然指向"当前朝上的地图方向"。
            这里刻意保持单一承载旋转的元素：早期版本把指针放在表盘外面，
            旋转时指针不跟随，视觉上指针与刻度脱节。 */}
        <i className="map-bearing-dial" style={{ transform: `rotate(${bearing}deg)` }}>
          {DIRECTIONS.map((direction) => (
            <span key={direction.key} className={`bearing-slot ${direction.key}`}>
              <button
                type="button"
                className="bearing-direction"
                data-bearing-dir={direction.key}
                title={`旋转到${direction.title}`}
                aria-label={direction.title}
                /* 位置随表盘旋转（N 槽始终停在"地图正北"所在的屏幕方位），
                   但字母反向旋转保持正立：方向按钮同时是"把地图转到该方向朝上"
                   的快捷入口，若字母跟着转到 180°，屏幕上会出现倒着的 S。 */
                style={{ transform: `rotate(${-bearing}deg)` }}
                onClick={(event) => {
                  event.stopPropagation()
                  animateTo(direction.target)
                }}
              >
                <b>{direction.label}</b>
              </button>
            </span>
          ))}
          {/* 指针放在表盘内部：跟随表盘一起旋转，避免与刻度脱节 */}
          <span className="map-bearing-needle"><b /><em /></span>
        </i>
        <button
          type="button"
          className={`map-bearing-pivot${editing ? ' editing' : ''}`}
          title="点击输入旋转角度"
          aria-label={`地图当前旋转 ${bearing.toFixed(1)} 度，点击输入角度`}
          onClick={(event) => {
            event.stopPropagation()
            if (!editing) startEditing()
          }}
        >
          {editing ? (
            <input
              ref={inputRef}
              type="number"
              min={0}
              max={359.9}
              step={0.1}
              value={draft}
              aria-label="地图旋转角度（度）"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') { event.preventDefault(); commitDraft() }
                if (event.key === 'Escape') { event.preventDefault(); setEditing(false) }
              }}
              onBlur={commitDraft}
              onClick={(event) => event.stopPropagation()}
            />
          ) : (
            // 359.6° 会四舍五入成 360，归一化回 0 避免显示"360°"
            <b>{Math.round(bearing) % 360}°</b>
          )}
        </button>
    </div>,
    host,
  ) : null
}

interface MapViewProps {
  config: MapConfig
  mobileLayout: boolean
  modeData: OfficialModeMapData | null
  propsOverride?: MapProp[]
  modeStageId: string | null
  view: Side
  tool: ToolMode
  state: MapState
  stages: StageConfig[]
  capturedStageIndex: number
  selectedPoint: { stageId: string; point: CapturePoint } | null
  /** 图层显示开关（问题1） */
  layers: LayerVisibility
  /** 道具按类型显示开关（问题2） */
  propVis: PropVisibility
  /** 画笔设置（问题4：颜色/线宽/线型） */
  draw: DrawSettings
  /** 左侧工具栏是否展开（浮层"共进退"：图例/缩放控件让位） */
  leftOpen: boolean
  /** 右侧工具栏是否展开（浮层"共进退"：据点说明让位） */
  rightOpen: boolean
  /** 左下角区域图例是否展开。 */
  legendOpen: boolean
  onToggleLegend: () => void
  /** 绘制操作提交（LayerManager 上报 before/after GeoJSON，App 统一入历史栈） */
  onCommitDraw: (before: string, after: string) => void
  /** 删除选中信号（第十二轮） */
  deleteSelectedTick: number
  clearDrawTick: number
  /** 是否有选中图形上报（第十二轮） */
  onDeleteSelCount: (n: number) => void
  onMapReady: (map: L.Map) => void
  onMoveVehicle: (uid: string, lat: number, lng: number) => void
  onRotateVehicle: (uid: string, rotation: number) => void
  onToggleVehicleFireLine: (uid: string) => void
  onDeleteVehicle: (uid: string) => void
  onLocateVehicleRefreshSource: (vehicle: VehicleItem) => void
  /** 快捷切换载具阵营（攻↔守） */
  onToggleVehicleSide: (uid: string) => void
  onChangeVehicleTeam: (uid: string, team?: import('../types').OperatorTeam) => void
  buildings: BuildingUnit[]
  onMoveBuilding: (uid: string, lat: number, lng: number) => void
  onRotateBuilding: (uid: string, rotation: number) => void
  onToggleBuildingFireLine: (uid: string) => void
  onToggleBuildingSide: (uid: string) => void
  onChangeBuildingTeam: (uid: string, team?: import('../types').OperatorTeam) => void
  onDeleteBuilding: (uid: string) => void
  onDrawSaved: (side: Side, geoJson: string) => void
  onSelectPoint: (point: CapturePoint, stageId: string) => void
  onObjectiveStateChange: (pointName: string, state: TacticalObjectiveState) => void
  onCloseDetail: () => void
  /** 点击出生点（弹出底部载具部署栏） */
  onSpawnSelect: (spawn: { uid: string; stageId: string; side: Side; pos: [number, number]; baseName: string | null }) => void
  /** 工具切换回调（右键自动切回查看工具） */
  onTool: (t: ToolMode) => void
  /** 标注编辑状态，用于锁定外部工具栏 */
  onTextEditingChange?: (editing: boolean) => void
  // ---- 套索支持载具（第十四轮） ----
  /** 批量移动载具（套索整体移动） */
  onMoveVehicles: (updates: Record<string, [number, number]>) => void
  /** 批量删除载具（套索删除） */
  onDeleteVehicles: (uids: string[]) => void
  // ---- 套索支持兵棋干员（第十七轮） ----
  /** 批量移动干员（套索整体移动） */
  onMoveOperators: (updates: Record<string, [number, number]>) => void
  /** 批量删除干员（套索删除） */
  onDeleteOperators: (uids: string[]) => void
  // ---- 兵棋推演（干员 + 联线；视角桶内含双方 40 人，绿=我方/红=敌方） ----
  operators: OperatorUnit[]
  connections: OperatorConnection[]
  wargame: WargameState
  /** 协同关系第一名待选干员 uid（高亮） */
  pendingConnect: string | null
  /** 干员实时坐标注册表（联线端点跟随） */
  operatorPosRef: MutableRefObject<Record<string, [number, number]>>
  onMoveOperator: (uid: string, lat: number, lng: number) => void
  onRotateOperator: (uid: string, rotation: number) => void
  onToggleOperatorFireLine: (uid: string) => void
  onClearOperatorDeploy: (uid: string) => void
  onConnectClick: (uid: string) => void
  onRemoveConnection: (id: string) => void
  /** 关系编辑模式右键取消：清空待选对象 */
  onCancelConnect: () => void
  /** 气泡选择具体干员（三级菜单第三级：职业→干员，职业自动跟随） */
  onOperatorChange: (uid: string, operatorId: string) => void
  /** 气泡切换状态（存活/重伤/阵亡） */
  onOperatorStatusChange: (uid: string, status: OperatorUnit['status']) => void
  onOperatorSkillUse: (uid: string, slot?: 1 | 2 | 3 | 4) => void
  onOperatorTacticalItemUse: (uid: string, item: import('../config/operatorTacticalItems').OperatorTacticalItemDefinition, mode: import('../config/operatorTacticalItems').TacticalItemUseMode) => void
  skillActionDraft:
    | { operator: OperatorUnit; skill: import('../config/operatorSkills').OperatorSkillDefinition; tacticalItem?: never; tacticalMode?: never }
    | { operator: OperatorUnit; tacticalItem: import('../config/operatorTacticalItems').OperatorTacticalItemDefinition; tacticalMode: import('../config/operatorTacticalItems').TacticalItemUseMode; skill?: never }
    | null
  onPlaceSkillAction: (lat: number, lng: number) => void
  onCancelSkillAction: () => void
  onSelectSkillTarget: (uid: string) => void
  onDeleteSkillAction: (uid: string) => void
  onUpdateSkillActionGeometry: (uid: string, geometry: import('../types').OperatorSkillActionGeometry) => void
  /** 双击代号快捷编辑昵称 */
  onOperatorRename: (uid: string, name: string) => void
  // ---- 兵棋队标（第二十三轮：简化部署单位） ----
  teams: TeamMarker[]
  /** 队标实时坐标注册表（套索框选/整体移动） */
  teamPosRef: MutableRefObject<Record<string, [number, number]>>
  onMoveTeamMarker: (uid: string, lat: number, lng: number) => void
  onRotateTeamMarker: (uid: string, rotation: number) => void
  onToggleTeamFireLine: (uid: string) => void
  onDeleteTeamMarker: (uid: string) => void
  /** 批量移动队标（套索整体移动） */
  onMoveTeamMarkers: (updates: Record<string, [number, number]>) => void
  /** 批量删除队标（套索删除） */
  onDeleteTeamMarkers: (uids: string[]) => void
  routes: TacticalRoute[]
  fieldSupports: import('../types').FieldSupportInstance[]
  onMoveFieldSupport: (uid: string, lat: number, lng: number) => void
  onDeleteFieldSupport: (uid: string) => void
  battleContext: TacticalBattleContext
  usedVehicleRefreshRuleIds: string[]
  onDeployVehicleRefresh: (rule: RuntimeVehicleRefreshRule, point: RuntimeVehicleRefreshPoint, force: boolean) => void
  onRestoreVehicleRefresh: (ruleUid: string) => void
  onLocateVehicleRefresh: (ruleUid: string) => void
  onCreateRoute: (route: TacticalRoute) => void
  onUpdateRoute: (uid: string, patch: Partial<TacticalRoute>) => void
  onDeleteRoute: (uid: string) => void
  cinematicInitialView?: { center: [number, number]; zoom: number } | null
  cinematicBattleCompare?: string | null
}

function CinematicBattleHighlights({ stage }: { stage: string }) {
  const map = useMap()
  const points = stage === 'S4'
    ? [
        { kind: 'attack', pos: [-153.407, 208.457] as [number, number], label: '洞穴出口' },
        { kind: 'objective', pos: [-173.957, 190.895] as [number, number], label: '据点 D' },
        { kind: 'defense', pos: [-182.931, 189.536] as [number, number], label: '守方复活点 1' },
      ]
    : [
        { kind: 'attack', pos: [-161.74964700298045, 205.31205528170955] as [number, number], label: '进攻复活点' },
        { kind: 'objective', pos: [-173.957, 190.895] as [number, number], label: '据点 D2' },
        { kind: 'defense canceled', pos: [-182.931, 189.536] as [number, number], label: '守方复活点取消' },
      ]
  useEffect(() => {
    const report = () => {
      const size = map.getSize()
      const positions = points.map(({ kind, pos }) => {
        const pixel = map.latLngToContainerPoint(pos)
        return { kind: kind.split(' ')[0], x: pixel.x / size.x, y: pixel.y / size.y }
      })
      window.parent.postMessage({ type: 'cinematic-battle-positions', stage, positions }, '*')
    }
    report()
    map.on('move zoom resize', report)
    return () => { map.off('move zoom resize', report) }
  }, [map, points, stage])
  return <>{points.map(({ kind, pos, label }) => <Marker key={kind} position={pos} pane={layerPane('fireLinePane')} interactive={false} icon={L.divIcon({ className: 'cinematic-battle-marker-wrap', html: `<div class="cinematic-battle-marker ${kind}"><i></i><span>${label}</span></div>`, iconSize: [1, 1], iconAnchor: [0, 0] })} />)}</>
}

/**
 * 按 config/mapLayers 的顺序表创建全部自定义图层 pane。
 * 必须是 MapContainer 的子组件才能拿到 map 实例；在图层渲染前完成创建，
 * 因此放在 MapContainer 的第一个子元素位置。
 */
function MapLayerPanes() {
  const map = useMap()
  useEffect(() => {
    ensureMapLayerPanes(map)
  }, [map])
  return null
}

/** 地图实例就绪 / 视角切换后的同步（视口、边界） */
function MapSync({
  config,
  onReady,
  initialView,
  minZoom,
  defaultZoom,
}: {
  config: MapConfig
  onReady: (map: L.Map) => void
  initialView?: { center: [number, number]; zoom: number } | null
  minZoom: number
  defaultZoom: number
}) {
  const map = useMap()
  const appliedViewRef = useRef('')
  useEffect(() => {
    const center = initialView?.center ?? config.initCenter
    const zoom = initialView?.zoom ?? defaultZoom
    const signature = `${config.id}:${center[0]}:${center[1]}:${zoom}`
    let firstFrame = 0
    let secondFrame = 0
    if (appliedViewRef.current !== signature) {
      appliedViewRef.current = signature
      map.setView(center, zoom, { animate: false })
      // Android 横屏侧栏与安全区会在首帧后完成尺寸计算。待布局稳定后只校正一次，
      // 避免初始中心按旧容器尺寸计算；后续兵棋状态更新不会再次进入此分支。
      firstFrame = window.requestAnimationFrame(() => {
        secondFrame = window.requestAnimationFrame(() => {
          map.invalidateSize({ animate: false })
          map.setView(center, zoom, { animate: false })
        })
      })
    }
    map.setMaxBounds(mapBounds(config))
    map.options.minZoom = minZoom
    onReady(map)
    return () => {
      if (firstFrame) window.cancelAnimationFrame(firstFrame)
      if (secondFrame) window.cancelAnimationFrame(secondFrame)
    }
  }, [map, config, onReady, initialView, minZoom, defaultZoom])
  return null
}

/**
 * 尺寸同步：监听地图容器尺寸变化并调用 invalidateSize。
 * 布局为地图全屏 + 侧栏浮动，面板开合不会触发 window resize，
 * 若无此监听，Leaflet 会停留在初始测量尺寸，右侧出现未加载的空白区域。
 */
function MapResizeSync() {
  const map = useMap()
  useEffect(() => {
    const el = map.getContainer()
    const ro = new ResizeObserver(() => {
      map.invalidateSize()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [map])
  return null
}

/**
 * 画布对象的键盘可访问路径（第 10 项）。
 *
 * 各图层通过 `data-kb-unit` 把标记声明为可聚焦对象，这里统一处理：
 *   ←→↑↓    在屏幕上移动 2px（Shift 为 10px）
 *   Delete  删除当前聚焦对象
 *   Escape  取消焦点
 *
 * 位移用屏幕像素换算而不是直接加减经纬度：本项目用 CRS.Simple 且地图可旋转，
 * 经纬度轴与屏幕方向不一致，直接加减会导致方向反直觉。绘制工具激活时不接管，
 * 避免与绘制自身的键盘语义冲突。
 *
 * 必须是 MapContainer 的子组件才能通过 useMap() 拿到 map 实例。
 */
function CanvasKeyboard({ enabled, positionRefs, onMove, onRemove }: {
  enabled: boolean
  positionRefs: Record<string, Record<string, [number, number]>>
  onMove: (kind: KeyboardUnitKind, uid: string, lat: number, lng: number) => void
  onRemove: (kind: KeyboardUnitKind, uid: string) => void
}) {
  const map = useMap()
  useEffect(() => {
    if (!enabled) return
    return installCanvasKeyboard(map, {
      positionOf: (kind, uid) => positionRefs[kind]?.[uid],
      move: onMove,
      remove: onRemove,
    })
  }, [enabled, map, onMove, onRemove, positionRefs])
  return null
}

function RouteEditorTrigger({ route, onOpen, onDelete }: { route: TacticalRoute; onOpen: () => void; onDelete: () => void }) {
  const map = useMap()
  const markerRef = useRef<L.Marker | null>(null)
  const onOpenRef = useRef(onOpen)
  const onDeleteRef = useRef(onDelete)
  onOpenRef.current = onOpen
  onDeleteRef.current = onDelete
  const routeNorthEast = useMemo(() => {
    const bounds = L.latLngBounds(route.waypoints.map(([lat, lng]) => L.latLng(lat, lng)))
    return bounds.getNorthEast()
  }, [route.waypoints])
  const [position, setPosition] = useState(routeNorthEast)
  const buttonSize = platform.kind === 'android' ? 36 : 30
  const controlWidth = buttonSize * 2 + 6
  const controlHeight = buttonSize + 24
  const icon = useMemo(() => L.divIcon({
    className: 'route-editor-trigger-wrap',
    html: '<div class="route-selection-controls"><span class="route-selection-hint"></span><div class="route-selection-actions"><button type="button" class="route-editor-trigger" title="编辑行动指令" aria-label="编辑行动指令"><i class="fa-solid fa-route" aria-hidden="true"></i></button><button type="button" class="route-delete-trigger" title="删除路线" aria-label="删除路线"><i class="fa-regular fa-trash-can" aria-hidden="true"></i></button></div></div>',
    iconSize: [controlWidth, controlHeight],
    iconAnchor: [0, controlHeight],
  }), [buttonSize, controlWidth, controlHeight])

  useEffect(() => {
    const updatePosition = () => {
      const size = map.getSize()
      const desired = map.latLngToContainerPoint(routeNorthEast).add([8, -8])
      const clamped = L.point(
        Math.max(4, Math.min(size.x - controlWidth - 4, desired.x)),
        Math.max(controlHeight + 4, Math.min(size.y - 4, desired.y)),
      )
      setPosition(map.containerPointToLatLng(clamped))
    }
    updatePosition()
    map.on('move zoom resize', updatePosition)
    return () => { map.off('move zoom resize', updatePosition) }
  }, [map, routeNorthEast, controlWidth, controlHeight])

  useEffect(() => {
    const element = markerRef.current?.getElement()
    const openButton = element?.querySelector<HTMLElement>('.route-editor-trigger')
    const deleteButton = element?.querySelector<HTMLElement>('.route-delete-trigger')
    const hint = element?.querySelector<HTMLElement>('.route-selection-hint')
    if (!element || !openButton || !deleteButton || !hint) return
    hint.textContent = route.name || '已选路线'
    const stopPointer = (event: Event) => L.DomEvent.stop(event)
    const openOnPointerUp = (event: Event) => {
      L.DomEvent.stop(event)
      // 等本次触摸产生的合成 click 完整结束后再卸载 Marker、打开面板，
      // 避免 click 落到下方路线并再次执行“选中路线 = 收起面板”。
      window.setTimeout(() => onOpenRef.current(), 0)
    }
    const deleteOnPointerUp = (event: Event) => {
      L.DomEvent.stop(event)
      window.setTimeout(() => onDeleteRef.current(), 0)
    }
    L.DomEvent.on(element, 'pointerdown', stopPointer)
    L.DomEvent.on(openButton, 'pointerup', openOnPointerUp)
    L.DomEvent.on(deleteButton, 'pointerup', deleteOnPointerUp)
    return () => {
      L.DomEvent.off(element, 'pointerdown', stopPointer)
      L.DomEvent.off(openButton, 'pointerup', openOnPointerUp)
      L.DomEvent.off(deleteButton, 'pointerup', deleteOnPointerUp)
    }
  }, [icon, route.name])

  return (
    <Marker
      ref={markerRef}
      position={position}
      icon={icon}
      pane={layerPane('routePane')}
      keyboard={false}
      eventHandlers={{
        mousedown: (event) => {
          L.DomEvent.stop(event.originalEvent)
          L.DomEvent.stopPropagation(event)
        },
        click: (event) => {
          L.DomEvent.stop(event.originalEvent)
          L.DomEvent.stopPropagation(event)
          // pointerup 已统一负责打开；此处仅隔离 Leaflet/地图的合成 click。
        },
      }}
    />
  )
}

export default function MapView({
  config,
  mobileLayout,
  modeData,
  propsOverride,
  modeStageId,
  view,
  tool,
  state,
  stages,
  capturedStageIndex,
  selectedPoint,
  layers,
  propVis,
  draw,
  onCommitDraw,
  deleteSelectedTick,
  clearDrawTick,
  onDeleteSelCount,
  onMapReady,
  onMoveVehicle,
  onRotateVehicle,
  onToggleVehicleFireLine,
  onDeleteVehicle,
  onLocateVehicleRefreshSource,
  onToggleVehicleSide,
  onChangeVehicleTeam,
  buildings,
  onMoveBuilding,
  onRotateBuilding,
  onToggleBuildingFireLine,
  onToggleBuildingSide,
  onChangeBuildingTeam,
  onDeleteBuilding,
  onDrawSaved,
  onSelectPoint,
  onObjectiveStateChange,
  onCloseDetail,
  onSpawnSelect,
  onTool,
  onTextEditingChange,
  leftOpen,
  rightOpen,
  legendOpen,
  onToggleLegend,
  onMoveVehicles,
  onDeleteVehicles,
  onMoveOperators,
  onDeleteOperators,
  operators,
  connections,
  wargame,
  pendingConnect,
  operatorPosRef,
  onMoveOperator,
  onRotateOperator,
  onToggleOperatorFireLine,
  onClearOperatorDeploy,
  onConnectClick,
  onRemoveConnection,
  onCancelConnect,
  onOperatorChange,
  onOperatorStatusChange,
  onOperatorSkillUse,
  onOperatorTacticalItemUse,
  skillActionDraft,
  onPlaceSkillAction,
  onCancelSkillAction,
  onSelectSkillTarget,
  onDeleteSkillAction,
  onUpdateSkillActionGeometry,
  onOperatorRename,
  teams,
  teamPosRef,
  onMoveTeamMarker,
  onRotateTeamMarker,
  onToggleTeamFireLine,
  onDeleteTeamMarker,
  onMoveTeamMarkers,
  onDeleteTeamMarkers,
  routes,
  fieldSupports,
  onMoveFieldSupport,
  onDeleteFieldSupport,
  battleContext,
  usedVehicleRefreshRuleIds,
  onDeployVehicleRefresh,
  onRestoreVehicleRefresh,
  onLocateVehicleRefresh,
  onCreateRoute,
  onUpdateRoute,
  onDeleteRoute,
  cinematicInitialView,
  cinematicBattleCompare,
}: MapViewProps) {
  const bounds = useMemo(() => mapBounds(config), [config])
  // 桌面端允许继续缩小到 0.5，便于在窄窗口或总览场景中查看完整地图。
  // Android 仍保留各地图现有的移动端缩放规则，避免改变触控端的既有视野与手势体验。
  const minZoom = mobileLayout ? Math.max(1, config.minZoom - 1) : 0.5
  const defaultZoom = mobileLayout ? Math.max(minZoom, config.initZoom - 1) : config.initZoom
  const runtimeStages = modeData?.stages ?? stages
  const selectedModeStageIndex = modeData
    ? runtimeStages.findIndex((stage) => stage.id === modeStageId)
    : -1
  const runtimeStageIndex = modeData ? Math.max(0, selectedModeStageIndex) : capturedStageIndex
  const [editing, setEditing] = useState<ActiveTextEdit | null>(null)
  const editingRef = useRef<ActiveTextEdit | null>(null)
  const suppressOutsideClickRef = useRef(false)
  const suppressOutsideClickTimerRef = useRef<number | null>(null)
  const mapWrapRef = useRef<HTMLDivElement | null>(null)
  const [routeDraftSource, setRouteDraftSource] = useState<RouteDraftSource>(null)
  const [selectedRouteUid, setSelectedRouteUid] = useState<string | null>(null)
  const [routeEditorOpen, setRouteEditorOpen] = useState(false)
  const [branchPickRouteUid, setBranchPickRouteUid] = useState<string | null>(null)

  useEffect(() => {
    setRouteDraftSource(null)
    setSelectedRouteUid(null)
    setRouteEditorOpen(false)
    setBranchPickRouteUid(null)
  }, [view])
  useEffect(() => {
    if (tool !== 'pan') {
      setRouteDraftSource(null)
      setBranchPickRouteUid(null)
    }
  }, [tool])
  // 载具位置注册表（第十四轮：套索框选/整体移动的实时位置来源，由 VehicleLayer 维护）
  const vehiclePosRef = useRef<Record<string, [number, number]>>({})
  // 建筑此前没有位置注册表（只有载具/干员/队标有），键盘方向键移动需要当前位置。
  const buildingPosRef = useRef<Record<string, [number, number]>>({})

  // 浮层"共进退"：侧栏展开宽度作为 CSS 变量传给地图浮层（图例/缩放/据点说明）。
  // 窄屏（<=640px）下侧栏压缩为 200px，偏移量同步跟随。
  const [vw, setVw] = useState(() => window.innerWidth)
  useEffect(() => {
    const onResize = () => setVw(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const rightPanelWidth = platform.kind === 'android' ? '200px' : vw <= 640 ? '200px' : '250px'
  const leftPanelWidth = platform.kind === 'android' ? 'min(58vw, 260px)' : 'var(--left-panel-width, 300px)'

  const panelInsetVars = useMemo(
    () =>
      ({
        '--left-panel-w': leftOpen ? leftPanelWidth : '0px',
        '--right-panel-w': rightOpen ? rightPanelWidth : '0px',
      }) as CSSProperties,
    [leftOpen, leftPanelWidth, rightOpen, rightPanelWidth],
  )

  const finishTextEdit = useCallback((mode: 'commit' | 'cancel' = 'commit', expectedSessionId?: number) => {
    const active = editingRef.current
    if (!active) return
    if (expectedSessionId != null && active.sessionId !== expectedSessionId) return
    // 先释放 React 侧所有权，再调用会话动作。这样保存导致同步重渲染、
    // 或旧事件重复到达时，都无法再次结束同一会话。
    editingRef.current = null
    setEditing((current) => current?.sessionId === active.sessionId ? null : current)
    try {
      if (mode === 'cancel') active.cancel()
      else active.commit(active.getText?.() ?? active.initialText)
    } finally {
      active.dispose()
    }
  }, [])

  const handleStartEdit = useCallback((edit: ActiveTextEdit) => {
    const active = editingRef.current
    if (active?.sessionId === edit.sessionId) {
      active.focus?.()
      return
    }
    if (active) finishTextEdit('commit', active.sessionId)
    editingRef.current = edit
    setEditing(edit)
  }, [finishTextEdit])

  useEffect(() => {
    onTextEditingChange?.(editing != null)
    return () => onTextEditingChange?.(false)
  }, [editing, onTextEditingChange])

  // ---- 干员悬浮级联菜单（点击干员 → 悬浮入口 → 选择最终操作） ----
  const [opBubble, setOpBubble] = useState<{ uid: string; x: number; y: number } | null>(null)
  const bubbleOp = opBubble ? operators.find((o) => o.uid === opBubble.uid) ?? null : null

  const handleOpBubbleEdit = useCallback((uid: string, cp: { x: number; y: number }) => {
    // 点击棋子打开级联菜单：同时关闭可能残留的改名浮层（互斥）
    setRenameOp(null)
    setOpBubble({ uid, x: cp.x, y: cp.y })
  }, [])
  const handleCloseOpBubble = useCallback(() => setOpBubble(null), [])

  // ---- 干员昵称快捷编辑（单击棋子顶部代号） ----
  const [renameOp, setRenameOp] = useState<{ uid: string; x: number; y: number } | null>(null)
  const renameTarget = renameOp ? operators.find((o) => o.uid === renameOp.uid) ?? null : null

  const handleOpRenameClick = useCallback((uid: string, cp: { x: number; y: number }) => {
    // 代号单击已独立于棋子（不触发三级菜单）；防御性关闭可能残留的气泡
    setOpBubble(null)
    setRenameOp({ uid, x: cp.x, y: cp.y })
  }, [])
  const handleCloseRename = useCallback(() => setRenameOp(null), [])

  // 常驻文档级事件守卫：外部 pointerdown 会取消编辑，同时吞掉浏览器
  // 随后生成的 click。监听器不能随 editing 状态卸载，否则取消后 click
  // 仍会继续触发阶段栏、工具栏等外部控件。
  useEffect(() => {
    const isEditorTarget = (target: EventTarget | null) =>
      target instanceof Element && Boolean(target.closest('.text-marker-editing, .text-marker-edit-confirm'))
    const cancelOutside = (event: PointerEvent) => {
      if (!editingRef.current || isEditorTarget(event.target)) return
      event.preventDefault()
      event.stopPropagation()
      suppressOutsideClickRef.current = true
      if (suppressOutsideClickTimerRef.current != null) window.clearTimeout(suppressOutsideClickTimerRef.current)
      suppressOutsideClickTimerRef.current = window.setTimeout(() => {
        suppressOutsideClickRef.current = false
        suppressOutsideClickTimerRef.current = null
      }, 500)
      finishTextEdit('commit')
    }
    const swallowClick = (event: MouseEvent) => {
      if (!suppressOutsideClickRef.current) return
      suppressOutsideClickRef.current = false
      if (suppressOutsideClickTimerRef.current != null) {
        window.clearTimeout(suppressOutsideClickTimerRef.current)
        suppressOutsideClickTimerRef.current = null
      }
      event.preventDefault()
      event.stopPropagation()
    }
    const blockWheel = (event: WheelEvent) => {
      if (!editingRef.current || isEditorTarget(event.target)) return
      event.preventDefault()
      event.stopPropagation()
    }
    const blockKeyboard = (event: KeyboardEvent) => {
      if (!editingRef.current) return
      if (isEditorTarget(event.target)) {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault()
          event.stopPropagation()
          finishTextEdit('commit')
        } else if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          finishTextEdit('cancel')
        }
        return
      }
      event.preventDefault()
      event.stopPropagation()
    }
    document.addEventListener('pointerdown', cancelOutside, true)
    document.addEventListener('click', swallowClick, true)
    document.addEventListener('wheel', blockWheel, { capture: true, passive: false })
    document.addEventListener('keydown', blockKeyboard, true)
    return () => {
      if (suppressOutsideClickTimerRef.current != null) window.clearTimeout(suppressOutsideClickTimerRef.current)
      document.removeEventListener('pointerdown', cancelOutside, true)
      document.removeEventListener('click', swallowClick, true)
      document.removeEventListener('wheel', blockWheel, true)
      document.removeEventListener('keydown', blockKeyboard, true)
    }
  }, [finishTextEdit])

  // 切换阶段/回合、视角时，当前标注编辑必须先结束，不能把旧会话带到新桶。
  useEffect(() => {
    finishTextEdit('commit')
    // 仅监听上下文切换；编辑器自身的输入不会触发该清理。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modeStageId, capturedStageIndex, view, finishTextEdit])

  // 只显示当前视角的载具（与画笔绘制对称：攻/守方分桶存储，切换视角互不影响）
  const vehicles = useMemo(() => {
    const bucket = state.vehicles as Record<string, unknown> | undefined
    const list = bucket && typeof bucket === 'object' && !Array.isArray(bucket) ? (bucket[view] as never[]) : []
    return Array.isArray(list) ? (list as VehicleItem[]) : []
  }, [state.vehicles, view])

  const routeSnapTargets = useMemo<RouteSnapTarget[]>(() => {
    const targets: RouteSnapTarget[] = []
    for (const team of teams) {
      if (team.lat != null && team.lng != null) targets.push({
        kind: 'team',
        uid: team.uid,
        label: team.name || `${team.team}队`,
        lat: team.lat,
        lng: team.lng,
        binding: {
          side: team.side,
          team: team.team,
          operatorIds: operators.filter((operator) => operator.side === team.side && operator.team === team.team).map((operator) => operator.uid),
          vehicleIds: vehicles.filter((vehicle) => vehicle.side === team.side && vehicle.team === team.team).map((vehicle) => vehicle.uid),
        },
      })
    }
    for (const op of operators) {
      if (op.lat != null && op.lng != null) targets.push({
        kind: 'operator',
        uid: op.uid,
        label: op.name,
        lat: op.lat,
        lng: op.lng,
        binding: { side: op.side, team: op.team, operatorIds: [op.uid], vehicleIds: [] },
      })
    }
    for (const vehicle of vehicles) targets.push({
      kind: 'vehicle',
      uid: vehicle.uid,
      label: vehicle.name,
      lat: vehicle.lat,
      lng: vehicle.lng,
      binding: { side: vehicle.side, team: vehicle.team ?? 'A', operatorIds: [], vehicleIds: [vehicle.uid] },
    })
    for (const building of buildings) targets.push({
      kind: 'building',
      uid: building.uid,
      label: building.name,
      lat: building.lat,
      lng: building.lng,
      binding: { side: building.side, team: building.team ?? 'A', operatorIds: [], vehicleIds: [] },
    })
    for (const stage of runtimeStages) {
      for (const point of stage.points) targets.push({ kind: 'point', uid: `${stage.id}:${point.name}`, label: point.name, lat: point.lat, lng: point.lng })
    }
    for (const route of routes) {
      route.waypoints.forEach((point, waypointIndex) => targets.push({
        kind: 'point',
        uid: `route-node:${route.uid}:${waypointIndex}`,
        label: `${route.name} · ${waypointIndex === 0 ? '起点' : waypointIndex === route.waypoints.length - 1 ? '终点' : `途经点 ${waypointIndex}`}`,
        lat: point[0],
        lng: point[1],
        routeAnchor: { routeUid: route.uid, waypointIndex },
        binding: {
          side: route.side,
          team: route.team,
          operatorIds: [...route.operatorIds],
          vehicleIds: [...route.vehicleIds],
        },
      }))
    }
    return targets
  }, [teams, operators, vehicles, buildings, runtimeStages, routes])

  const selectedRoute = useMemo(
    () => routes.find((route) => route.uid === selectedRouteUid) ?? null,
    [routes, selectedRouteUid],
  )
  const handleSelectRoute = useCallback((uid: string | null) => {
    setSelectedRouteUid(uid)
    // 路线与普通图形一致：选中只显示紧凑入口，完整属性面板由用户主动打开。
    setRouteEditorOpen(false)
    setBranchPickRouteUid((current) => current === uid ? current : null)
    if (uid) onCloseDetail()
  }, [onCloseDetail])

  const geoJson = state.drawings[view] ?? '{"type":"FeatureCollection","features":[]}'
  // 路线落点期间也进入绘制穿透态：鼠标经过/点击已有图形不会抢走事件或取消路线。
  const routeDrawing = routeDraftSource != null
  const drawing = tool !== 'pan' || routeDrawing
  // 仅"查看"工具时允许点击属性（据点详情/复活点聚焦/载具展开/道具悬停提示等），
  // 绘制工具激活时全部禁用，避免像普通鼠标一样触发图层交互
  const interactive = tool === 'pan' && !routeDrawing
  // 第十一轮：套索作为绘制工具时，与其他绘制工具一样保持激活（不做其他特殊处理）

  // ---- 画布键盘路径（第 10 项）----
  // 位置注册表按类型聚合，供键盘方向键读取"当前位置"。
  const keyboardPositionRefs = useMemo<Record<string, Record<string, [number, number]>>>(
    () => ({
      operator: operatorPosRef.current,
      vehicle: vehiclePosRef.current,
      building: buildingPosRef.current,
      team: teamPosRef.current,
    }),
    [operatorPosRef, teamPosRef],
  )
  const handleKeyboardMove = useCallback((kind: KeyboardUnitKind, uid: string, lat: number, lng: number) => {
    // 干员/载具/队标走批量接口：它们会 pushEntry 入历史栈，因此键盘移动是可撤销的
    // （单点拖动路径反而不入栈，这是既有行为，不在本次改动范围内）。
    if (kind === 'operator') onMoveOperators({ [uid]: [lat, lng] })
    else if (kind === 'vehicle') onMoveVehicles({ [uid]: [lat, lng] })
    else if (kind === 'building') onMoveBuilding(uid, lat, lng)
    else onMoveTeamMarkers({ [uid]: [lat, lng] })
  }, [onMoveBuilding, onMoveTeamMarkers, onMoveVehicles, onMoveOperators])
  const handleKeyboardRemove = useCallback((kind: KeyboardUnitKind, uid: string) => {
    // 载具走单条删除：刷新来源载具需要用户选择"视为损失/复原规则"，
    // 直接走批量删除会跳过该确认。
    if (kind === 'operator') onDeleteOperators([uid])
    else if (kind === 'vehicle') onDeleteVehicle(uid)
    else if (kind === 'building') onDeleteBuilding(uid)
    else onDeleteTeamMarkers([uid])
  }, [onDeleteBuilding, onDeleteOperators, onDeleteTeamMarkers, onDeleteVehicle])

  // 选中点位的状态与阶段信息
  const selectedStage = useMemo(() => {
    if (!selectedPoint) return null
    return runtimeStages.find((s) => s.id === selectedPoint.stageId) ?? null
  }, [runtimeStages, selectedPoint])

  const selectedStatus: PointStatus | null = useMemo(() => {
    if (!selectedStage) return null
    const idx = runtimeStages.findIndex((s) => s.id === selectedStage.id)
    if (idx < 0) return null
    if (idx < runtimeStageIndex) return 'captured'
    if (idx === runtimeStageIndex) return 'active'
    return 'locked'
  }, [runtimeStageIndex, runtimeStages, selectedStage])
  const selectedObjectiveState = selectedPoint && selectedStatus
    ? battleContext.objectiveStates[selectedPoint.point.name] ?? defaultObjectiveState(selectedStatus)
    : null
  const selectedObjectiveColor = selectedObjectiveState ? objectiveStateColor(selectedObjectiveState, view) : '#f4cf67'
  const selectedObjectiveProgressColor = selectedObjectiveState ? objectiveProgressColor(selectedObjectiveState, view) : '#f4cf67'

  // 右键切回查看工具：延后一轮执行，让 LayerManager 先把待确认的曲线草稿提交落盘。
  const handleMapContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (tool !== 'pan') {
        window.setTimeout(() => onTool('pan'), 0)
      }
      e.preventDefault()
    },
    [tool, onTool],
  )

  // 右键按下先阻止 Leaflet 启动新的绘制；真正的工具切换交给 contextmenu，
  // 这样已进入 adjusting 的曲线仍有机会在右键时确认保存。
  // Leaflet 的 map 'mousedown' 事件不区分左右键，右键按下会触发绘制起点。
  // 在 React 捕获阶段拦截右键 mousedown（先于 Leaflet 容器监听），stopPropagation
  // 阻断事件到达 Leaflet → 绘制永不开始；同时 onTool('pan') 立即切回。
  // 同时：点击地图空白区域（非气泡/非干员标记）关闭更换干员气泡（问题3）。
  // 连线模式：右键取消待选端点（保持连线模式开启）。
  const handleMapMouseDownCapture = useCallback(
    (e: React.MouseEvent) => {
      const t = e.target as HTMLElement
      // 点击气泡内部或干员标记：不关闭气泡（气泡内容点击走自己的处理）
      if (t.closest('.op-bubble') || t.closest('.op-marker-wrap') || t.closest('.op-rename')) {
        return
      }
      setOpBubble(null)
      setRenameOp(null)
      if (e.button !== 2) return
      e.preventDefault()
      e.stopPropagation()
      // 连线模式：右键取消待选并退出连线模式（左侧开关同步关闭）
      if (wargame.enabled && wargame.connectMode) {
        onCancelConnect()
      }
    },
    [wargame.enabled, wargame.connectMode, onCancelConnect],
  )

  return (
    <div
      ref={mapWrapRef}
      className="map-wrap"
      style={panelInsetVars}
      onContextMenuCapture={handleMapContextMenu}
      onMouseDownCapture={handleMapMouseDownCapture}
    >
      <MapContainer
        key={config.id}
        crs={L.CRS.Simple}
        bounds={bounds}
        minZoom={minZoom}
        maxZoom={config.maxZoom}
        zoomDelta={mobileLayout ? 0.5 : 1}
        zoomSnap={mobileLayout ? 0.5 : 1}
        // 第 9 项：关闭 Leaflet 内置 zoom 控件（默认 true），
        // 改由 MapCornerControls 在右下角与全屏按钮一起提供。
        zoomControl={false}
        touchZoom={true}
        rotate={true}
        bearing={0}
        rotateControl={false}
        touchRotate={false}
        attributionControl={false}
        // 绘制工具激活时进入绘制模式：CSS 物理屏蔽非绘制图层鼠标事件
        className={`tactical-map${drawing ? ' drawing-mode' : ''}${skillActionDraft ? ' skill-action-mode' : ''}`}
        style={{ width: '100%', height: '100%' }}
      >
        <MapLayerPanes />
        <MapCornerControls />
        <InteractiveLayerPanGuard />
        <TextEditMapLock active={editing != null} />
        <MapRotationControl />
        <SkillActionPlacement active={skillActionDraft != null && (skillActionDraft.skill?.placementMode ?? skillActionDraft.tacticalMode?.placementMode) !== 'target-unit' && (skillActionDraft.skill?.placementMode ?? skillActionDraft.tacticalMode?.placementMode) !== 'ally-unit'} onPlace={onPlaceSkillAction} onCancel={onCancelSkillAction} />
        <TileLayer
          url={config.tileUrl}
          bounds={bounds}
          minZoom={minZoom}
          // CDN 没有 0.5 等低层级瓦片；缩到原生下限以下时继续复用并缩放
          // 现有最低层瓦片，避免 Leaflet 请求不存在的 z0/z1 资源而显示空白。
          minNativeZoom={Math.ceil(config.minZoom)}
          maxZoom={config.maxZoom}
          maxNativeZoom={config.maxNativeZoom}
          tileSize={256}
        />
        <MapSync
          config={config}
          onReady={onMapReady}
          initialView={cinematicInitialView}
          minZoom={minZoom}
          defaultZoom={defaultZoom}
        />
        <MapResizeSync />
        {cinematicBattleCompare ? <CinematicBattleHighlights stage={cinematicBattleCompare} /> : null}
        <MapPropsLayer
          mapId={config.id}
          visible={layers.props}
          propVis={propVis}
          interactive={interactive}
          propsOverride={modeData?.props ?? propsOverride}
        />
        <PointMarkers
          stages={runtimeStages}
          capturedStageIndex={runtimeStageIndex}
          view={view}
          selectedName={selectedPoint?.point.name ?? null}
          selectedStageId={selectedPoint?.stageId ?? null}
          visible={layers.points}
          labelsVisible={layers.pointsLabels}
          annotationsVisible={layers.pointAnnotations}
          captureVisible={layers.pointsCapture}
          frontlineVisible={layers.pointsFrontline}
          interactive={interactive}
          onSelect={onSelectPoint}
          objectiveStates={battleContext.objectiveStates}
        />
        <SpawnMarkers
          stages={runtimeStages}
          capturedStageIndex={runtimeStageIndex}
          view={view}
          visible={layers.spawns}
          annotationsVisible={layers.spawnAnnotations}
          interactive={interactive}
          deployByStage={modeData?.deploy}
          onSelect={onSpawnSelect}
        />
        <ActivityZones
          stages={runtimeStages}
          capturedStageIndex={runtimeStageIndex}
          view={view}
          visible={layers.zones}
          objectiveStates={battleContext.objectiveStates}
        />
        <VehicleRefreshLayer
          points={modeData?.vehicleRefreshPoints ?? []}
          rules={modeData?.vehicleRefreshRules ?? []}
          context={battleContext}
          stages={runtimeStages}
          currentStageIndex={runtimeStageIndex}
          usedRuleIds={usedVehicleRefreshRuleIds}
          deployedRuleIds={vehicles.map((vehicle) => vehicle.sourceRuleUid).filter((uid): uid is string => Boolean(uid))}
          visible={layers.vehicleRefresh}
          interactive={interactive}
          onDeploy={onDeployVehicleRefresh}
          onRestore={onRestoreVehicleRefresh}
          onLocateVehicle={onLocateVehicleRefresh}
        />
        {wargame.enabled && <UnitFireLineLayer view={view} visible={wargame.showFireLines} operators={operators} teams={teams} vehicles={vehicles} buildings={buildings} />}
        {wargame.enabled && <FieldSupportLayer supports={fieldSupports} view={view} interactive={interactive} onMove={onMoveFieldSupport} onDelete={onDeleteFieldSupport} />}
        {wargame.enabled && <OperatorSkillLayer actions={state.skillActions ?? []} operators={operators} view={view} onDelete={onDeleteSkillAction} onUpdateGeometry={onUpdateSkillActionGeometry} />}
        <VehicleLayer
          vehicles={vehicles}
          view={view}
          canDrag={interactive}
          interactive={interactive}
          allowSelect={platform.kind === 'android' || !wargame.enabled}
          onMove={onMoveVehicle}
          onRotate={onRotateVehicle}
          onToggleFireLine={onToggleVehicleFireLine}
          onDelete={onDeleteVehicle}
          onLocateRefreshSource={onLocateVehicleRefreshSource}
          onToggleSide={onToggleVehicleSide}
          onChangeTeam={onChangeVehicleTeam}
          onStartRoute={(uid) => {
            onTool('pan')
            onCloseDetail()
            setSelectedRouteUid(null)
            setBranchPickRouteUid(null)
            setRouteDraftSource({ kind: 'vehicle', vehicleUid: uid })
          }}
          posRef={vehiclePosRef}
        />
        {wargame.enabled && (
          <BuildingLayer
            buildings={buildings}
            view={view}
            interactive={interactive}
            posRef={buildingPosRef}
            onMove={onMoveBuilding}
            onRotate={onRotateBuilding}
            onToggleFireLine={onToggleBuildingFireLine}
            onToggleSide={onToggleBuildingSide}
            onChangeTeam={onChangeBuildingTeam}
            onDelete={onDeleteBuilding}
            onStartRoute={(uid) => {
              onTool('pan')
              onCloseDetail()
              setSelectedRouteUid(null)
              setBranchPickRouteUid(null)
              setRouteDraftSource({ kind: 'building', buildingUid: uid })
            }}
          />
        )}
        {/* 兵棋推演：干员标记层（视角桶内含双方 40 人；我方绿圈可交互，敌方红圈亦可部署/连线对抗） */}
        {wargame.enabled && (
          <OperatorLayer
            view={view}
            operators={operators}
            posRef={operatorPosRef}
            canDrag={interactive}
            connectMode={wargame.connectMode}
            pendingConnect={pendingConnect}
            interactive={interactive}
            onMove={onMoveOperator}
            onRotate={onRotateOperator}
            onToggleFireLine={onToggleOperatorFireLine}
            onClearDeploy={onClearOperatorDeploy}
            onStartRoute={(uid) => {
              onTool('pan')
              onCloseDetail()
              setSelectedRouteUid(null)
              setBranchPickRouteUid(null)
              setRouteDraftSource({ kind: 'operator', operatorUid: uid })
            }}
            onConnectClick={onConnectClick}
            onEditClick={handleOpBubbleEdit}
            onRenameClick={handleOpRenameClick}
            skillTargeting={(skillActionDraft?.skill?.placementMode ?? skillActionDraft?.tacticalMode?.placementMode) === 'target-unit' || (skillActionDraft?.skill?.placementMode ?? skillActionDraft?.tacticalMode?.placementMode) === 'ally-unit'}
            onSkillTarget={onSelectSkillTarget}
          />
        )}
        {/* 兵棋推演：通用队标层，只表达队伍字母与归属；右键删除。 */}
        {wargame.enabled && (
          <RouteLayer
            routes={routes}
            view={view}
            teams={teams}
            operators={operators}
            vehicles={vehicles}
            buildings={buildings}
            snapTargets={routeSnapTargets}
            draftSource={routeDraftSource}
            selectedUid={selectedRouteUid}
            branchPicking={branchPickRouteUid === selectedRouteUid && selectedRouteUid != null}
            interactive={interactive}
            showRouteLabels={wargame.showRouteLabels}
            onSelect={handleSelectRoute}
            onBranchPoint={(waypointIndex) => {
              if (!selectedRouteUid) return
              setBranchPickRouteUid(null)
              setRouteDraftSource({ kind: 'branch', routeUid: selectedRouteUid, waypointIndex })
            }}
            onDraftEnd={() => setRouteDraftSource(null)}
            onCreate={onCreateRoute}
            onPatch={onUpdateRoute}
            onDelete={onDeleteRoute}
            onMoveAnchor={(route, lat, lng) => {
              if (route.anchorMode === 'operator' && route.anchorOperatorUid) onMoveOperator(route.anchorOperatorUid, lat, lng)
              else if (route.anchorMode === 'vehicle' && route.anchorVehicleUid) onMoveVehicle(route.anchorVehicleUid, lat, lng)
              else if (route.anchorMode === 'building' && route.anchorBuildingUid) onMoveBuilding(route.anchorBuildingUid, lat, lng)
              else if (route.anchorMode === 'team' && route.teamMarkerUid) onMoveTeamMarker(route.teamMarkerUid, lat, lng)
            }}
          />
        )}
        {selectedRoute && !routeDrawing && !routeEditorOpen && (
          <RouteEditorTrigger
            route={selectedRoute}
            onOpen={() => setRouteEditorOpen(true)}
            onDelete={() => {
              onDeleteRoute(selectedRoute.uid)
              setSelectedRouteUid(null)
              setRouteEditorOpen(false)
              setBranchPickRouteUid(null)
            }}
          />
        )}
        {wargame.enabled && (
          <TeamLayer
            view={view}
            teams={teams}
            teamNames={wargame.teamRoles ?? {}}
            posRef={teamPosRef}
            canDrag={interactive}
            interactive={interactive}
            onMove={onMoveTeamMarker}
            onRotate={onRotateTeamMarker}
            onToggleFireLine={onToggleTeamFireLine}
            onDelete={onDeleteTeamMarker}
            onStartRoute={(uid) => {
              onTool('pan')
              onCloseDetail()
              setSelectedRouteUid(null)
              setBranchPickRouteUid(null)
              setRouteDraftSource({ kind: 'team', teamUid: uid })
            }}
          />
        )}
        {/* 兵棋推演：无方向协同关系层；只表示谁与谁协同。 */}
        {wargame.enabled && (
          <ConnectionLayer
            connections={connections}
            operators={operators}
            visible={wargame.showConnections}
            connectMode={wargame.connectMode}
            interactive={interactive}
            view={view}
            onRemoveConnection={onRemoveConnection}
          />
        )}
        <LayerManager
          view={view}
          tool={tool}
          geoJson={geoJson}
          draw={draw}
          onCommitDraw={onCommitDraw}
          deleteSelectedTick={deleteSelectedTick}
          clearDrawTick={clearDrawTick}
          onDeleteSelCount={onDeleteSelCount}
          onDrawSaved={onDrawSaved}
          onStartEdit={handleStartEdit}
          onFinishEdit={finishTextEdit}
          onExitDraw={() => onTool('pan')}
          vehicles={vehicles}
          vehiclePosRef={vehiclePosRef}
          onMoveVehicles={onMoveVehicles}
          onDeleteVehicles={onDeleteVehicles}
          operators={operators}
          operatorPosRef={operatorPosRef}
          onMoveOperators={onMoveOperators}
          onDeleteOperators={onDeleteOperators}
          teams={teams}
          teamPosRef={teamPosRef}
          onMoveTeams={onMoveTeamMarkers}
          onDeleteTeams={onDeleteTeamMarkers}
        />
        <CanvasKeyboard
          enabled={interactive}
          positionRefs={keyboardPositionRefs}
          onMove={handleKeyboardMove}
          onRemove={handleKeyboardRemove}
        />
      </MapContainer>
      {skillActionDraft && (() => {
        const definition = skillActionDraft.skill ?? skillActionDraft.tacticalItem
        const placementMode = skillActionDraft.skill?.placementMode ?? skillActionDraft.tacticalMode?.placementMode
        return <div className="skill-action-hint"><img src={definition.iconUrl} alt="" /><span>部署：{definition.name}</span><small>{placementMode === 'ally-unit' ? '选择己方干员' : placementMode === 'target-unit' ? '选择敌方干员' : '点击地图确定位置'}</small><button type="button" onClick={onCancelSkillAction} title="取消部署" aria-label="取消部署"><i className="fa-solid fa-xmark" /></button></div>
      })()}

      {selectedRoute && !routeDrawing && routeEditorOpen && (
        <RouteEditorPanel
          key={selectedRoute.uid}
          route={selectedRoute}
          view={view}
          availableOperators={operators.filter((operator) => operator.side === selectedRoute.side && operator.team === selectedRoute.team)}
          branchPicking={branchPickRouteUid === selectedRoute.uid}
          onPatch={(patch) => onUpdateRoute(selectedRoute.uid, patch)}
          onCopy={() => {
            const copy: TacticalRoute = {
              ...selectedRoute,
              uid: genUid('route'),
              name: `${selectedRoute.name} · 副本`,
              anchorMode: 'free',
              anchorOperatorUid: undefined,
              anchorVehicleUid: undefined,
              teamMarkerUid: '',
              branchFromRouteUid: undefined,
              branchFromWaypointIndex: undefined,
              waypoints: selectedRoute.waypoints.map((point) => [...point] as [number, number]),
              operatorIds: [...selectedRoute.operatorIds],
              vehicleIds: [...selectedRoute.vehicleIds],
              createdAt: Date.now(),
            }
            onCreateRoute(copy)
            setSelectedRouteUid(copy.uid)
            setRouteEditorOpen(false)
          }}
          onReverse={() => onUpdateRoute(selectedRoute.uid, {
            waypoints: [...selectedRoute.waypoints].reverse(),
            labelPosition: undefined,
            anchorMode: 'free',
            anchorOperatorUid: undefined,
            anchorVehicleUid: undefined,
            teamMarkerUid: '',
            branchFromRouteUid: undefined,
            branchFromWaypointIndex: undefined,
            target: undefined,
          })}
          onBranch={() => setBranchPickRouteUid((uid) => uid === selectedRoute.uid ? null : selectedRoute.uid)}
          onDelete={() => {
            onDeleteRoute(selectedRoute.uid)
            setSelectedRouteUid(null)
            setRouteEditorOpen(false)
            setBranchPickRouteUid(null)
          }}
          onClose={() => {
            setRouteEditorOpen(false)
            setBranchPickRouteUid(null)
          }}
        />
      )}

      {/* 干员操作级联菜单：桌面悬浮展开，触屏点击进入 */}
      {bubbleOp && opBubble && (
        <OpBubble
          op={bubbleOp}
          position={opBubble}
          onOperatorChange={onOperatorChange}
          onStatusChange={onOperatorStatusChange}
          onSkillUse={onOperatorSkillUse}
          onTacticalItemUse={onOperatorTacticalItemUse}
          onClose={handleCloseOpBubble}
        />
      )}

      {/* 干员昵称快捷编辑（单击代号弹出） */}
      {renameTarget && renameOp && (
        <OpRenameBar
          uid={renameTarget.uid}
          initial={renameTarget.name}
          position={renameOp}
          onSubmit={onOperatorRename}
          onClose={handleCloseRename}
        />
      )}

      {/* 区域图例（第 7 项：绿=守方、红=攻方、白=交战区域；仅当前争夺阶段显示） */}
      {runtimeStageIndex < runtimeStages.length && (
        <div className={`zone-legend${legendOpen ? '' : ' collapsed'}`}>
          {legendOpen ? (
            <>
              <div className="zone-legend-title">
                <span>区域 · {runtimeStages[runtimeStageIndex].id}</span>
                <button type="button" className="zone-legend-toggle" onClick={onToggleLegend} title="收起图例" aria-label="收起区域图例" aria-expanded="true">
                  <i className="fa-solid fa-chevron-down" aria-hidden="true" />
                </button>
              </div>
              <div className="zone-legend-item">
                <span className="swatch defense" />
                本方 / 守方区域（绿）
              </div>
              <div className="zone-legend-item">
                <span className="swatch attack" />
                敌方 / 攻方区域（红）
              </div>
              <div className="zone-legend-item">
                <span className="swatch contested" />
                交战区域（白色实线）
              </div>
            </>
          ) : (
            <button type="button" className="zone-legend-toggle compact" onClick={onToggleLegend} title="展开图例" aria-label="展开区域图例" aria-expanded="false">
              <i className="fa-solid fa-map" aria-hidden="true" />
              <span>图例</span>
              <i className="fa-solid fa-chevron-up" aria-hidden="true" />
            </button>
          )}
        </div>
      )}

      {/* 选中点位详情卡 */}
      {selectedPoint && selectedStage && (
        <div className="point-detail objective-state-editor" style={{ '--objective-state-color': selectedObjectiveColor, '--objective-progress-color': selectedObjectiveProgressColor } as CSSProperties}>
          <div className="point-detail-head">
            <span className="point-detail-name">{selectedPoint.point.name}</span>
            <span className="point-detail-status objective-owner">{selectedObjectiveState?.owner === 'neutral' ? '中立争夺' : selectedObjectiveState?.owner === view ? '我方占领' : '敌方占领'}</span>
          </div>
          <div className="point-detail-row">
            <span className="dim">阶段</span>
            <span>{selectedStage.id} · {selectedStage.label}</span>
          </div>
          {selectedObjectiveState ? <div className="objective-state-controls">
            <span className="objective-control-label">据点归属</span>
            <div className="objective-owner-segments">
              <button type="button" className={selectedObjectiveState.owner === view ? 'active own' : ''} onClick={() => onObjectiveStateChange(selectedPoint.point.name, { owner: view, capturingSide: null, progress: 100 })}>我方</button>
              <button type="button" className={selectedObjectiveState.owner === 'neutral' ? 'active neutral' : ''} onClick={() => onObjectiveStateChange(selectedPoint.point.name, { owner: 'neutral', capturingSide: selectedObjectiveState.capturingSide ?? view, progress: selectedObjectiveState.owner === 'neutral' ? selectedObjectiveState.progress : 0 })}>中立</button>
              <button type="button" className={selectedObjectiveState.owner !== 'neutral' && selectedObjectiveState.owner !== view ? 'active enemy' : ''} onClick={() => onObjectiveStateChange(selectedPoint.point.name, { owner: view === 'attack' ? 'defense' : 'attack', capturingSide: null, progress: 100 })}>敌方</button>
            </div>
            {selectedObjectiveState.owner === 'neutral' ? <>
              <span className="objective-control-label">正在占领</span>
              <div className="objective-capturing-segments">
                <button type="button" className={selectedObjectiveState.capturingSide === view ? 'active own' : ''} onClick={() => onObjectiveStateChange(selectedPoint.point.name, { ...selectedObjectiveState, capturingSide: view })}>我方读条</button>
                <button type="button" className={selectedObjectiveState.capturingSide && selectedObjectiveState.capturingSide !== view ? 'active enemy' : ''} onClick={() => onObjectiveStateChange(selectedPoint.point.name, { ...selectedObjectiveState, capturingSide: view === 'attack' ? 'defense' : 'attack' })}>敌方读条</button>
              </div>
            </> : <button type="button" className={`objective-contested-toggle ${selectedObjectiveState.capturingSide ? 'active' : ''}`} onClick={() => onObjectiveStateChange(selectedPoint.point.name, { ...selectedObjectiveState, capturingSide: selectedObjectiveState.capturingSide ? null : selectedObjectiveState.owner === 'attack' ? 'defense' : 'attack', progress: 100 })}>
              <i className={`fa-solid ${selectedObjectiveState.capturingSide ? 'fa-toggle-on' : 'fa-toggle-off'}`} />{selectedObjectiveState.capturingSide ? '正在被另一方占领' : '当前无人读条'}
            </button>}
            {selectedObjectiveState.capturingSide ? <label className="objective-progress-control">
              <span>占领进度 <b>{Math.round(selectedObjectiveState.progress)}%</b></span>
              <input type="range" min="0" max="100" step="1" value={selectedObjectiveState.progress} style={rangeProgressStyle(selectedObjectiveState.progress, 0, 100, selectedObjectiveProgressColor)} onChange={(event) => onObjectiveStateChange(selectedPoint.point.name, { ...selectedObjectiveState, progress: Number(event.target.value) })} />
            </label> : null}
          </div> : null}
          {selectedPoint.point.note && (
            <div className="point-detail-row">
              <span className="dim">备注</span>
              <span>{selectedPoint.point.note}</span>
            </div>
          )}
          <button className="btn point-detail-close" onClick={onCloseDetail}>
            关闭
          </button>
        </div>
      )}

    </div>
  )
}
