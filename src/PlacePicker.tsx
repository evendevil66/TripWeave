import { useEffect, useRef, useState } from 'react'
import { getAmap } from './amapClient'

type Point = [number, number]
type Poi = { id?: string; name: string; address?: string; district?: string; location?: { getLng?: () => number; getLat?: () => number; lng?: number; lat?: number } }
type Props = { label: string; name: string; point: Point; onChange: (name: string, point: Point) => void }

function coordinates(poi: Poi): Point | null {
  const location = poi.location
  const lng = location?.getLng?.() ?? location?.lng
  const lat = location?.getLat?.() ?? location?.lat
  return typeof lng === 'number' && typeof lat === 'number' && Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null
}

export default function PlacePicker({ label, name, point, onChange }: Props) {
  const [query, setQuery] = useState(name)
  const [results, setResults] = useState<Poi[]>([])
  const [status, setStatus] = useState('')
  const [open, setOpen] = useState(false)
  const searchVersion = useRef(0)

  useEffect(() => { setQuery(name) }, [name])
  useEffect(() => {
    if (!open || query.trim().length < 2) return
    const version = ++searchVersion.current
    const timer = setTimeout(() => {
      void getAmap().then((amap) => {
        const search = new amap.PlaceSearch({ pageSize: 8, extensions: 'base' })
        search.search(query.trim(), (state: string, result: { poiList?: { pois?: Poi[] } }) => {
          if (version !== searchVersion.current) return
          const pois = state === 'complete' ? (result.poiList?.pois ?? []).filter((poi) => coordinates(poi)) : []
          setResults(pois)
          setStatus(pois.length ? '' : '未找到可选位置，请尝试更具体的名称或地址')
        })
      }).catch(() => { if (version === searchVersion.current) setStatus('高德地点搜索暂不可用，请检查地图设置') })
    }, 280)
    return () => { clearTimeout(timer); searchVersion.current++ }
  }, [query, open])

  return <div className="admin-place-picker">
    <label>{label}<input value={query} placeholder="搜索酒店、景区或地址" autoComplete="off" onFocus={() => { if (query.trim().length >= 2 && (point[0] === 0 && point[1] === 0)) setOpen(true) }} onChange={(event) => {
      const value = event.target.value
      setQuery(value); setOpen(true); setStatus(value.trim().length < 2 ? '至少输入两个字' : '正在搜索…'); setResults([])
      onChange(value, [0, 0])
    }} /></label>
    {open && results.length > 0 && <div className="admin-place-results" role="listbox" aria-label={`${label}搜索结果`}>
      {results.map((poi, index) => <button type="button" role="option" aria-selected="false" key={`${poi.id ?? poi.name}-${index}`} onClick={() => {
        const selected = coordinates(poi)
        if (!selected) return
        searchVersion.current++
        onChange(poi.name, selected); setQuery(poi.name); setOpen(false); setResults([]); setStatus('')
      }}><strong>{poi.name}</strong><small>{[poi.district, poi.address].filter(Boolean).join(' · ')}</small></button>)}
    </div>}
    {open && status && <small className="admin-place-status">{status}</small>}
    {point[0] !== 0 || point[1] !== 0 ? <small className="admin-place-status">已选位置：{point[0].toFixed(5)}, {point[1].toFixed(5)}</small> : <small className="admin-place-status admin-place-required">请选择搜索结果以确定位置</small>}
  </div>
}
