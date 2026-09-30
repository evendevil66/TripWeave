import { useEffect, useRef, useState } from 'react'
import { getAmap } from './amapClient'

type Position = { latitude: number; longitude: number }
type RoutePoint = { getLng: () => number; getLat: () => number }
type TrafficSegment = { distance?: number | string; status?: string; path?: RoutePoint[] }
type RouteStep = { path?: RoutePoint[]; road?: string; distance?: number; tmcs?: TrafficSegment[] }
type Route = { distance: number; time: number; steps?: RouteStep[] }
type RouteOption = { route: Route; waypoint?: [number, number] }
type RouteEvidence = { distance: number; time: number; covered: number; mainRoads: string[]; traffic: { status: string; distance: number }[]; roads: { road: string; status: string; distance: number }[] }
type DrivingResult = { routes?: Route[]; info?: string; [key: string]: unknown }
type Advice = { advice: string; updatedAt: string; sourceAt: string; source?: 'web-service' | 'js-api' }
type RouteCache = { configured: boolean; evidence: { routes: RouteEvidence[] } | null; fetchedAt: string | null; advice: Advice | null; trafficRefreshMinutes: number; aiRefreshMinutes: number; trafficAutoEnabled: boolean; aiAutoEnabled: boolean }
type Props = { dayIndex: number; legIndex: number; origin: string; destination: string; originPoint: [number, number]; destinationPoint: [number, number]; routeLabel: string; position?: Position }
type RouteMapProps = Props & { active: boolean; currentPosition?: Position; fromCurrent: boolean; onOriginChange: (value: boolean) => void }

type AMapApi = {
  Map: new (container: HTMLElement, options: Record<string, unknown>) => {
    add: (object: unknown) => void
    setFitView: (overlays: unknown[], immediately?: boolean, padding?: number[]) => void
    resize: () => void
    destroy: () => void
  }
  Driving: new (options: Record<string, unknown>) => {
    search: (start: unknown, end: unknown, options: { waypoints: [number, number][] } | ((status: string, result: DrivingResult) => void), callback?: (status: string, result: DrivingResult) => void) => void
    clear: () => void
  }
  Marker: new (options: Record<string, unknown>) => unknown
  TileLayer: { Traffic: new (options: Record<string, unknown>) => unknown }
}

const adviceMemory = new Map<string, Advice>()

function readAdvice(key: string, persist: boolean) {
  if (adviceMemory.has(key)) return adviceMemory.get(key)
  if (!persist) return undefined
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null') as Advice | null
    if (value && typeof value.advice === 'string' && Number.isFinite(Date.parse(value.updatedAt)) && Number.isFinite(Date.parse(value.sourceAt))) return value
  } catch { /* Cache is optional when storage is unavailable. */ }
  return undefined
}

function trafficSummary(route: Route) {
  const { traffic, covered, roads: segments } = routeEvidence(route)
  if (!covered) return '高德未返回可分析的分段路况；可查看地图路况图层，出发前再刷新。'

  const parts = traffic.sort((a, b) => b.distance - a.distance).map(({ status, distance }) => `${status}约 ${(distance / 1000).toFixed(1)} 公里`)
  const roads = [...new Set(segments.filter((item) => item.status.includes('拥堵')).map((item) => item.road))].slice(0, 2)
  const coverage = route.distance > 0 ? Math.min(100, Math.round(covered / route.distance * 100)) : 0
  return `高德标注路段约 ${(covered / 1000).toFixed(1)} 公里（路线约 ${coverage}%）：${parts.join('、')}。${roads.length ? `拥堵集中在 ${roads.join('、')}。` : ''}${coverage < 90 ? '其余路段没有可判断的分段数据。' : ''}`
}

function cachedTrafficSummary(evidence: RouteEvidence) {
  if (!evidence.covered) return '高德未返回可分析的分段路况。'
  const coverage = evidence.distance > 0 ? Math.min(100, Math.round(evidence.covered / evidence.distance * 100)) : 0
  const parts = evidence.traffic.map(({ status, distance }) => `${status}约 ${(distance / 1000).toFixed(1)} 公里`).join('、')
  return `高德标注路段约 ${(evidence.covered / 1000).toFixed(1)} 公里（路线约 ${coverage}%）：${parts}。${coverage < 90 ? '其余路段没有可判断的分段数据。' : ''}`
}

function readableAdvice(value: string) {
  const formatMinutes = (count: string) => {
    const minutes = Math.round(Number(count))
    return minutes >= 60 ? `${Math.floor(minutes / 60)}小时${minutes % 60}分钟` : `${minutes}分钟`
  }
  return value
    .replace(/(\d+(?:\.\d+)?)\s*米/g, (_, count: string) => `${(Number(count) / 1000).toFixed(1)}公里`)
    .replace(/(\d+(?:\.\d+)?)\s*秒/g, (_, count: string) => `${Math.round(Number(count) / 60)}分钟`)
    .replace(/(\d+(?:\.\d+)?)\s*(至|到|[~～-])\s*(\d+(?:\.\d+)?)\s*分钟/g, (_, start: string, separator: string, end: string) => `${formatMinutes(start)}${separator}${formatMinutes(end)}`)
    .replace(/(\d+(?:\.\d+)?)\s*分钟/g, (_, count: string) => formatMinutes(count))
}

function routeDuration(seconds: number) {
  const totalMinutes = Math.round(seconds / 60)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return hours ? `${hours} 小时 ${minutes} 分` : `${minutes} 分`
}

function alternateWaypoint(route: Route, primary: Route): [number, number] | undefined {
  const baseline = primary.steps?.flatMap((step) => step.path ?? []) ?? []
  const candidate = route.steps?.flatMap((step) => step.path ?? []) ?? []
  if (!baseline.length || !candidate.length) return undefined
  const sample = (points: RoutePoint[], start: number, end: number) => {
    const count = Math.min(160, end - start)
    return Array.from({ length: count }, (_, index) => points[start + Math.floor(index * (end - start - 1) / Math.max(1, count - 1))])
  }
  const baselineSample = sample(baseline, 0, baseline.length)
  const candidateSample = sample(candidate, Math.floor(candidate.length * .2), Math.ceil(candidate.length * .8))
  let best: RoutePoint | undefined
  let maxGap = 0
  for (const point of candidateSample) {
    const gap = Math.min(...baselineSample.map((other) => Math.hypot((point.getLng() - other.getLng()) * 96, (point.getLat() - other.getLat()) * 111)))
    if (gap > maxGap) { maxGap = gap; best = point }
  }
  return best ? [best.getLng(), best.getLat()] : undefined
}

function routeEvidence(route: Route): RouteEvidence {
  const traffic = new Map<string, number>()
  const roads = new Map<string, { road: string; status: string; distance: number }>()
  const mainRoads = new Map<string, number>()
  for (const step of route.steps ?? []) {
    if (step.road) mainRoads.set(step.road, (mainRoads.get(step.road) ?? 0) + Number(step.distance || 0))
  }
  for (const step of route.steps ?? []) for (const segment of step.tmcs ?? []) {
    const distance = Number(segment.distance)
    const status = segment.status?.trim()
    if (!status || status === '未知' || !Number.isFinite(distance) || distance <= 0) continue
    traffic.set(status, (traffic.get(status) ?? 0) + distance)
    if (step.road) {
      const key = `${step.road}\0${status}`
      const current = roads.get(key)
      roads.set(key, { road: step.road, status, distance: (current?.distance ?? 0) + distance })
    }
  }
  return {
    distance: route.distance,
    time: route.time,
    covered: [...traffic.values()].reduce((sum, distance) => sum + distance, 0),
    mainRoads: [...mainRoads].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([road]) => road),
    traffic: [...traffic].map(([status, distance]) => ({ status, distance })),
    roads: [...roads.values()].sort((a, b) => Number(b.status.includes('拥堵')) - Number(a.status.includes('拥堵')) || b.distance - a.distance).slice(0, 20),
  }
}

export default function MapPanel(props: Props) {
  const [fromCurrent, setFromCurrent] = useState(false)
  const currentKey = props.position ? `${props.position.longitude},${props.position.latitude}` : ''

  return (
    <div className="map-panel-stack">
      <RouteMap {...props} active={!fromCurrent || !props.position} fromCurrent={false} onOriginChange={setFromCurrent} />
      {props.position && (
        <RouteMap key={currentKey} {...props} active={fromCurrent} currentPosition={props.position} fromCurrent={fromCurrent} onOriginChange={setFromCurrent} />
      )}
    </div>
  )
}

function RouteMap({ dayIndex, legIndex, originPoint, destinationPoint, routeLabel, position, currentPosition, active, fromCurrent, onOriginChange }: RouteMapProps) {
  const element = useRef<HTMLDivElement>(null)
  const mapRef = useRef<InstanceType<AMapApi['Map']> | undefined>(undefined)
  const markerRef = useRef<unknown[]>([])
  const [route, setRoute] = useState<Route>()
  const [routes, setRoutes] = useState<RouteOption[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [routeLoading, setRouteLoading] = useState(false)
  const selectRoute = useRef<(option: RouteOption, index: number) => void>(undefined)
  const [state, setState] = useState('正在获取高德路线…')
  const [trafficOn, setTrafficOn] = useState(true)
  const [refresh, setRefresh] = useState(0)
  const [checkedAt, setCheckedAt] = useState<Date>()
  const [serverCache, setServerCache] = useState<RouteCache | null>(null)
  const [refreshMinutes, setRefreshMinutes] = useState(5)
  const adviceKey = `trip-ai:api-routes:${routeLabel}:${currentPosition ? `${currentPosition.longitude},${currentPosition.latitude}` : 'planned'}`
  const [aiAdvice, setAiAdvice] = useState<Advice | undefined>(() => readAdvice(adviceKey, !currentPosition))
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState('')

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) setRefresh((value) => value + 1)
    }, refreshMinutes * 60 * 1000)
    const onVisible = () => {
      if (!document.hidden) setRefresh((value) => value + 1)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [refreshMinutes])

  useEffect(() => {
    if (!active || !mapRef.current || !markerRef.current.length) return
    window.requestAnimationFrame(() => {
      mapRef.current?.resize()
      mapRef.current?.setFitView(markerRef.current, true, [42, 42, 42, 42])
    })
  }, [active])

  useEffect(() => {
    let cancelled = false
    let map: InstanceType<AMapApi['Map']> | undefined
    const aiRequest = new AbortController()

    async function start() {
      try {
        setState('正在获取最新高德路线…')
        setAiAdvice(readAdvice(adviceKey, !currentPosition))
        setAiLoading(false)
        setAiError('')
        const cacheUrl = `/api/trip/route-cache?day=${dayIndex}&leg=${legIndex}`
        const applyCache = (data: RouteCache) => {
          if (cancelled) return
          setServerCache(data)
          setRefreshMinutes(data.trafficRefreshMinutes)
          if (data.advice) {
            setAiAdvice(data.advice)
            adviceMemory.set(adviceKey, data.advice)
            try { localStorage.setItem(adviceKey, JSON.stringify(data.advice)) } catch { /* Optional cache. */ }
          }
        }
        const cachePromise = currentPosition ? Promise.resolve(null) : fetch(cacheUrl, { cache: 'no-store', signal: aiRequest.signal })
          .then(async (response) => response.ok ? await response.json() as RouteCache : null)
          .catch(() => null)
        if (!currentPosition) void cachePromise.then((cached) => {
          if (!cached || cancelled) return
          applyCache(cached)
          if (!cached.configured) return
          setAiLoading(true)
          void fetch(cacheUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: aiRequest.signal })
            .then(async (response) => {
              if (!response.ok) throw new Error('后台路况更新失败')
              return response.json() as Promise<RouteCache>
            }).then(applyCache)
            .catch(() => { if (!cancelled) setAiError('后台更新暂不可用，显示上次建议。') })
            .finally(() => { if (!cancelled) setAiLoading(false) })
        })
        const api = await getAmap()
        if (cancelled || !element.current) return
        const startPoint = currentPosition ? [currentPosition.longitude, currentPosition.latitude] : originPoint
        const createdMap: InstanceType<AMapApi['Map']> = new api.Map(element.current, { center: startPoint, zoom: 10, resizeEnable: true, mapStyle: 'amap://styles/normal' })
        map = createdMap
        mapRef.current = createdMap
        if (trafficOn) createdMap.add(new api.TileLayer.Traffic({ zIndex: 12 }))
        const endpointMarkers = [
          new api.Marker({ position: startPoint, title: '起点', anchor: 'bottom-center', content: '<span class="route-endpoint route-endpoint-start">起</span>' }),
          new api.Marker({ position: destinationPoint, title: '终点', anchor: 'bottom-center', content: '<span class="route-endpoint route-endpoint-end">终</span>' }),
        ]
        createdMap.add(endpointMarkers)
        markerRef.current = endpointMarkers
        const driving = new api.Driving({ map, policy: 10, extensions: 'all', showTraffic: trafficOn, hideMarkers: true, autoFitView: false })
        const fitRoute = () => window.requestAnimationFrame(() => {
          if (!cancelled) map?.setFitView(endpointMarkers, true, [42, 42, 42, 42])
        })
        const search = (waypoint?: [number, number]) => new Promise<Route[] | undefined>((resolve) => {
          const callback = (status: string, result: DrivingResult) => resolve(status === 'complete' ? result.routes : undefined)
          if (waypoint) driving.search(startPoint, destinationPoint, { waypoints: [waypoint] }, callback)
          else driving.search(startPoint, destinationPoint, callback)
        })
        selectRoute.current = (option, index) => {
          setRouteLoading(true)
          setRoute(undefined)
          setState('正在切换高德路线…')
          driving.clear()
          void search(option.waypoint).then((results) => {
            if (cancelled) return
            const selected = results?.[0]
            if (selected) {
              setSelectedIndex(index)
              setRoute(selected)
              setRoutes((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, route: selected } : item))
              setCheckedAt(new Date())
              setState(`高德路线查询结果 · 每 ${refreshMinutes} 分钟自动更新`)
              fitRoute()
            } else setState('路线暂不可用，请重新选择或刷新')
          }).finally(() => { if (!cancelled) setRouteLoading(false) })
        }
        const results = await search()
        if (cancelled) return
        const first = results?.[0]
        if (first) {
          setRoute(first)
          setState(`高德路线查询结果 · 每 ${refreshMinutes} 分钟自动更新`)
          const queriedAt = new Date()
          setCheckedAt(queriedAt)
          fitRoute()
          const options: RouteOption[] = results!.slice(0, 3).map((candidate, index) => ({ route: candidate, waypoint: index ? alternateWaypoint(candidate, first) : undefined }))
          setRoutes(options)
          setSelectedIndex(0)
          const cache = await cachePromise
          if (!cache?.configured) {
          setAiLoading(true)
          void fetch('/api/trip/traffic-advice', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ routeLabel, sourceAt: queriedAt.toISOString(), routes: options.map((option) => routeEvidence(option.route)) }),
              signal: aiRequest.signal,
            }).then(async (response) => {
              const data = await response.json() as Advice & { error?: string }
              if (!response.ok || !data.advice) throw new Error(data.error ?? 'AI 建议暂不可用')
              if (!cancelled) {
                setAiAdvice(data)
                adviceMemory.set(adviceKey, data)
                if (!currentPosition) {
                  try { localStorage.setItem(adviceKey, JSON.stringify(data)) } catch { /* Memory cache still works. */ }
                }
              }
            }).catch((error) => {
              if (!cancelled) setAiError(error instanceof Error ? error.message : 'AI 建议暂不可用')
            }).finally(() => { if (!cancelled) setAiLoading(false) })
          }
        } else {
          setRoute(undefined)
          setRoutes([])
          setCheckedAt(undefined)
          setAiError('路线不可用，暂时无法更新建议。')
          setState('路线暂不可用')
        }
      } catch (error) {
        if (!cancelled) {
          setRoute(undefined)
          setRoutes([])
          setCheckedAt(undefined)
          setAiError('路线不可用，暂时无法更新建议。')
          setState(error instanceof Error ? error.message : '地图加载失败')
        }
      }
    }

    void start()
    return () => {
      cancelled = true
      aiRequest.abort()
      selectRoute.current = undefined
      mapRef.current = undefined
      markerRef.current = []
      map?.destroy()
    }
  }, [dayIndex, legIndex, originPoint, destinationPoint, routeLabel, currentPosition, adviceKey, trafficOn, refresh])

  return (
    <section className={`map-section ${active ? '' : 'map-section-inactive'}`} aria-label={`${routeLabel} 地图`} aria-hidden={!active} inert={!active}>
      <div className="map-heading">
        <div>
          <span className="section-label">当日路线</span>
          <strong>{routeLabel}</strong>
        </div>
        <button type="button" onClick={() => { setRoute(undefined); setState('正在刷新路线…'); setRefresh((value) => value + 1) }} title="刷新路线" aria-label="刷新路线">↻</button>
      </div>
      <div className="map-canvas" ref={element} role="img" aria-label={`${routeLabel} 路线与交通地图`} />
      {routes.length > 1 && <div className="route-options" role="group" aria-label="高德备选路线">
        {routes.map((option, index) => <button type="button" key={index} disabled={routeLoading || (index > 0 && !option.waypoint)} aria-pressed={selectedIndex === index} onClick={() => selectRoute.current?.(option, index)}>
          <strong>路线 {index + 1}{index === 0 ? ' · 推荐' : ''}</strong><span>{(option.route.distance / 1000).toFixed(0)} 公里 · {routeDuration(option.route.time)}</span>
        </button>)}
      </div>}
      <div className="map-status">
        <div>
          <strong>{route ? `${(route.distance / 1000).toFixed(0)} 公里 · ${routeDuration(route.time)}` : state}</strong>
          {route && <span>{state}</span>}
        </div>
        <label className="traffic-toggle">
          <input type="checkbox" checked={trafficOn} onChange={(event) => setTrafficOn(event.target.checked)} />
          路况
        </label>
      </div>
      <div className="traffic-report" aria-live="polite">
        <div className="traffic-report-heading">
          <strong>当前路况</strong>
          <div className="traffic-report-actions">
            {checkedAt ? <time dateTime={checkedAt.toISOString()}>{checkedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 查询</time> : serverCache?.fetchedAt && <time dateTime={serverCache.fetchedAt}>{new Date(serverCache.fetchedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 缓存</time>}
            {position && (
              <label className="map-origin-note">
                <input type="checkbox" checked={fromCurrent} onChange={(event) => onOriginChange(event.target.checked)} />
                从当前位置出发
              </label>
            )}
          </div>
        </div>
        <p>{route ? trafficSummary(route) : serverCache?.evidence?.routes[0] ? cachedTrafficSummary(serverCache.evidence.routes[0]) : state}</p>
        <div className="ai-advice">
          <div><strong>AI 建议</strong>{aiAdvice && <time dateTime={aiAdvice.updatedAt}>{new Date(aiAdvice.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 更新</time>}</div>
          <p>{aiAdvice ? readableAdvice(aiAdvice.advice) : aiLoading ? '正在根据最新路况分析…' : '等待高德路线数据…'}</p>
          <small>{aiLoading ? aiAdvice ? '显示上次建议，正在后台分析最新路况…' : '正在后台分析，不影响地图更新。' : aiError || (aiAdvice ? `依据 ${new Date(aiAdvice.sourceAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 高德${aiAdvice.source === 'web-service' ? ' Web 服务' : ''}数据` : '')}</small>
        </div>
      </div>
    </section>
  )
}
