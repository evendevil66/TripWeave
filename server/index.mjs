import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { handleAmapRequest } from './amap.ts'
import { handleTripData } from './trip-data.mjs'

const root = resolve('dist')
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

createServer(async (request, response) => {
  if (request.url?.startsWith('/api/trip/') || request.url?.startsWith('/api/install') || request.url?.startsWith('/api/admin/') || request.url === '/api/health') {
    await handleTripData(request, response)
    return
  }
  if (request.url?.startsWith('/_AMapService/') || request.url === '/api/map-config') {
    await handleAmapRequest(request, response)
    return
  }

  let pathname
  try { pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname) }
  catch { response.writeHead(400).end(); return }
  let file = resolve(root, `.${pathname}`)
  if (file !== root && !file.startsWith(root + sep)) {
    response.writeHead(403).end()
    return
  }
  try {
    if (!(await stat(file)).isFile()) file = resolve(root, 'index.html')
  } catch {
    file = resolve(root, 'index.html')
  }
  try {
    response.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream' })
    response.end(await readFile(file))
  } catch {
    response.writeHead(404).end()
  }
}).listen(Number(process.env.PORT ?? 4173), '0.0.0.0', () => {
  console.log(`Trip planner ready at http://localhost:${process.env.PORT ?? 4173}`)
})
