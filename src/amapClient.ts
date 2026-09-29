import { load } from '@amap/amap-jsapi-loader'

let amapPromise: Promise<any> | undefined

export function getAmap(): Promise<any> {
  if (!amapPromise) {
    amapPromise = fetch('/api/map-config', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('地图配置获取失败')
        const { key } = await response.json() as { key: string }
        if (!key) throw new Error('缺少高德 JSAPI Key')
        ;(window as Window & { _AMapSecurityConfig?: { serviceHost: string } })._AMapSecurityConfig = {
          serviceHost: `${location.origin}/_AMapService`,
        }
        return load({ key, version: '2.0', plugins: ['AMap.Driving', 'AMap.PlaceSearch'] })
      })
      .catch((error) => {
        amapPromise = undefined
        throw error
      })
  }
  return amapPromise
}
