import { useEffect, useMemo, useRef } from 'react'

/**
 * 浮层互斥仲裁。
 *
 * 背景：应用里至少有 18 个 `position: fixed` 的独立浮层（据点详情、部署栏、
 * 干员气泡、改名条、路线编辑器、文本样式面板、战术板弹窗、启动致谢、移动端
 * 确认框、处理刷新载具对话框、工具设置、快捷键说明、模式配置器的移动端面板
 * 等），它们各自由独立 state 控制，此前没有任何仲裁——用户完全可以同时打开
 * 四五个浮层然后互相遮挡。
 *
 * 设计取舍：**不做"全局只能开一个"的一刀切**。部分浮层本来就是刻意并列的
 * （路线编辑器与据点详情分别停靠地图两侧、左栏与右栏同时展开）。因此按互斥
 * 组声明，并采用"声明式收敛"而不是包装 setter：
 *
 *   1. 调用方把当前所有浮层的开关状态交给 useOverlayArbiter；
 *   2. 仲裁器按组规则算出"应当关闭"的浮层；
 *   3. 通过一次 useEffect 收敛到该状态。
 *
 * 相比包装 setter 的做法，这样不会在 setState 的 updater 里产生副作用
 * （React StrictMode 下 updater 会被调用两次，副作用会被放大），也不需要为
 * 每个浮层建立一个 hook 调用点（那样会牵扯 Hooks 调用顺序）。
 */

export interface OverlaySpec {
  /** 互斥分组名；同组内互斥。 */
  group: string
  /**
   * 本浮层打开时，需要一并关闭的其它组。
   * 方向性压制（只在自己打开时生效），避免两组互相压制导致的开合抖动。
   */
  blocks?: string[]
  /** 该浮层当前是否处于打开状态。 */
  open: boolean
  /** 关闭该浮层。 */
  close: () => void
}

/**
 * @param overlays 全部受管浮层的当前状态与关闭方法（每次渲染重建即可）。
 * @param enabled  为 false 时完全不介入（用于 cinematic 演示等特殊流程）。
 */
export function useOverlayArbiter(overlays: Record<string, OverlaySpec>, enabled = true): void {
  // 只在真正需要收敛时调用 close，避免每次渲染都触发无意义的状态写入。
  const closingRef = useRef<Set<string>>(new Set())

  const plan = useMemo(() => {
    if (!enabled) return [] as string[]
    const openEntries = Object.entries(overlays).filter(([, spec]) => spec.open)
    if (openEntries.length < 2) return [] as string[]

    const toClose = new Set<string>()
    for (const [activeId, active] of openEntries) {
      for (const [otherId, other] of openEntries) {
        if (otherId === activeId) continue
        const sameGroup = other.group === active.group
        const blockedByActive = (active.blocks ?? []).includes(other.group)
        if (sameGroup || blockedByActive) toClose.add(otherId)
      }
    }
    // 同组互斥时若整组都打开（例如两个布尔浮层同时为 true），保留"最后声明"
    // 的那个，避免把整组清空。这里按声明顺序取最后一个作为胜者。
    const declaredOrder = Object.keys(overlays)
    for (const group of new Set(openEntries.map(([, spec]) => spec.group))) {
      const members = openEntries.filter(([, spec]) => spec.group === group).map(([id]) => id)
      if (members.length > 1 && members.every((id) => toClose.has(id))) {
        const winner = members.reduce((best, id) => (declaredOrder.indexOf(id) > declaredOrder.indexOf(best) ? id : best), members[0])
        toClose.delete(winner)
      }
    }
    return [...toClose]
  }, [enabled, overlays])

  useEffect(() => {
    if (!plan.length) { closingRef.current.clear(); return }
    for (const id of plan) {
      if (closingRef.current.has(id)) continue
      overlays[id]?.close()
    }
    closingRef.current = new Set(plan)
  }, [overlays, plan])
}
