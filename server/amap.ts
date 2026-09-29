import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync } from 'node:fs'
import { amapCredentials } from './trip-data.mjs'

if (existsSync('.env.local')) process.loadEnvFile('.env.local')

export async function handleAmapRequest(request: IncomingMessage, response: ServerResponse) {
  const credentials = await amapCredentials()
  if (request.url === '/api/map-config') {
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.setHeader('Cache-Control', 'no-store')
    response.end(JSON.stringify({ key: credentials.key }))
    return
  }

  const url = new URL(request.url ?? '/', 'http://localhost')
  if (!url.pathname.startsWith('/_AMapService/')) {
    response.writeHead(404).end()
    return
  }
  if (!credentials.securityCode) {
    response.writeHead(503).end('AMap security code is not configured')
    return
  }

  const path = url.pathname.slice('/_AMapService/'.length)
  const isStyle = path.startsWith('v4/map/styles')
  const upstream = new URL(isStyle ? `https://webapi.amap.com/${path}` : `https://restapi.amap.com/${path}`)
  url.searchParams.forEach((value, key) => upstream.searchParams.append(key, value))
  upstream.searchParams.set('jscode', credentials.securityCode)

  try {
    const result = await fetch(upstream, { signal: AbortSignal.timeout(15000) })
    response.writeHead(result.status, {
      'Content-Type': result.headers.get('content-type') ?? 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    response.end(Buffer.from(await result.arrayBuffer()))
  } catch {
    response.writeHead(502).end('AMap request failed')
  }
}
