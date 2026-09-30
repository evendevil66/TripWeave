import pg from 'pg'
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

if (existsSync('.env.local')) process.loadEnvFile('.env.local')
if (existsSync('.env.ai.local')) process.loadEnvFile('.env.ai.local')

const dataDir = resolve('data')
const databaseFile = resolve(dataDir, 'database.json')
const installLock = resolve(dataDir, 'install.lock')
const savedDatabaseUrl = existsSync(databaseFile) ? JSON.parse(readFileSync(databaseFile, 'utf8')).databaseUrl : ''
let pool = savedDatabaseUrl || process.env.DATABASE_URL ? new pg.Pool({ connectionString: savedDatabaseUrl || process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 5000 }) : null
let installInProgress = false
const tripId = process.env.TRIP_ID || 'default'
const defaultMembers = [
  { id: 'lin', name: '小林', shares: 1 },
  { id: 'chen', name: '小陈', shares: 1 },
  { id: 'zhou', name: '小周', shares: 2 },
]
const trafficAdviceCache = new Map()
const trafficAdvicePending = new Map()
const authAttempts = new Map()
let ready
let cachedAmapCredentials

async function database() {
  if (!pool) throw new Error('Database is not configured')
  ready ??= (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS trip_notes (
        trip_id text PRIMARY KEY, content text NOT NULL DEFAULT '', updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS app_installation (
        id integer PRIMARY KEY CHECK (id = 1),
        admin_hash text NOT NULL,
        admin_username text NOT NULL DEFAULT 'admin',
        access_hash text NOT NULL,
        session_secret text NOT NULL,
        config jsonb NOT NULL,
        amap_js_key text,
        amap_security_code text,
        amap_web_service_key text,
        traffic_refresh_minutes integer NOT NULL DEFAULT 5,
        traffic_auto_enabled boolean NOT NULL DEFAULT true,
        ai_url text,
        ai_api_key text,
        ai_model text,
        ai_refresh_minutes integer NOT NULL DEFAULT 10,
        ai_auto_enabled boolean NOT NULL DEFAULT true,
        installed_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS trip_expenses (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        trip_id text NOT NULL,
        expense_date date,
        title text NOT NULL,
        amount_cents integer NOT NULL CHECK (amount_cents > 0),
        payer text NOT NULL,
        kind text NOT NULL CHECK (kind IN ('shared', 'personal')),
        category text NOT NULL,
        note text NOT NULL DEFAULT '',
        allocation jsonb,
        seed_key text UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz
      );
      CREATE TABLE IF NOT EXISTS trip_audit_log (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        trip_id text NOT NULL,
        actor text NOT NULL,
        action text NOT NULL,
        expense_id bigint,
        snapshot jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS trip_route_cache (
        trip_id text NOT NULL,
        day_index integer NOT NULL,
        leg_index integer NOT NULL,
        signature text NOT NULL,
        evidence jsonb,
        fetched_at timestamptz,
        advice jsonb,
        advice_at timestamptz,
        PRIMARY KEY (trip_id, day_index, leg_index)
      )
    `)
    await pool.query(`ALTER TABLE trip_expenses ADD COLUMN IF NOT EXISTS allocation jsonb`)
    await pool.query('ALTER TABLE app_installation ADD COLUMN IF NOT EXISTS amap_js_key text')
    await pool.query('ALTER TABLE app_installation ADD COLUMN IF NOT EXISTS amap_security_code text')
    await pool.query('ALTER TABLE app_installation ADD COLUMN IF NOT EXISTS amap_web_service_key text')
    await pool.query('ALTER TABLE app_installation ADD COLUMN IF NOT EXISTS traffic_refresh_minutes integer NOT NULL DEFAULT 5')
    await pool.query('ALTER TABLE app_installation ADD COLUMN IF NOT EXISTS traffic_auto_enabled boolean NOT NULL DEFAULT true')
    await pool.query("ALTER TABLE app_installation ADD COLUMN IF NOT EXISTS admin_username text NOT NULL DEFAULT 'admin'")
    await pool.query('ALTER TABLE app_installation ADD COLUMN IF NOT EXISTS ai_url text')
    await pool.query('ALTER TABLE app_installation ADD COLUMN IF NOT EXISTS ai_api_key text')
    await pool.query('ALTER TABLE app_installation ADD COLUMN IF NOT EXISTS ai_model text')
    await pool.query('ALTER TABLE app_installation ADD COLUMN IF NOT EXISTS ai_refresh_minutes integer NOT NULL DEFAULT 10')
    await pool.query('ALTER TABLE app_installation ADD COLUMN IF NOT EXISTS ai_auto_enabled boolean NOT NULL DEFAULT true')
    await pool.query('ALTER TABLE trip_expenses DROP CONSTRAINT IF EXISTS trip_expenses_payer_check')
  })().catch((error) => { ready = undefined; throw error })
  await ready
  return pool
}

function send(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(data))
}

function sendCsv(response, csv) {
  response.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="trip-expenses.csv"',
    'Cache-Control': 'no-store',
  })
  response.end(`\uFEFF${csv}`)
}

function clientAddress(request) {
  return request.headers['x-forwarded-for']?.split(',')[0]?.trim() || request.socket.remoteAddress || 'unknown'
}

function allowAuthAttempt(request, kind) {
  const key = `${kind}:${clientAddress(request)}`
  const now = Date.now()
  const current = authAttempts.get(key)
  if (!current || now - current.startedAt >= 10 * 60 * 1000) {
    authAttempts.set(key, { startedAt: now, count: 1 })
    return true
  }
  if (current.count >= 20) return false
  current.count += 1
  return true
}

function auditSnapshot(value) {
  return { ...value, amountCents: Number(value.amountCents) }
}

async function audit(db, actor, action, expenseId, snapshot) {
  await db.query(`INSERT INTO trip_audit_log (trip_id, actor, action, expense_id, snapshot)
    VALUES ($1, $2, $3, $4, $5)`, [tripId, actor, action, expenseId ?? null, snapshot ? JSON.stringify(auditSnapshot(snapshot)) : null])
}

async function bodyJson(request) {
  let body = ''
  for await (const chunk of request) {
    body += chunk
    if (body.length > 100000) throw new Error('REQUEST_TOO_LARGE')
  }
  return JSON.parse(body || '{}')
}

function hashSecret(value) {
  const salt = randomBytes(16).toString('hex')
  return `${salt}:${scryptSync(value, salt, 32).toString('hex')}`
}

function verifySecret(value, stored) {
  const [salt, digest] = (stored || '').split(':')
  if (!salt || !digest || !/^[a-f0-9]{64}$/.test(digest)) return false
  const candidate = scryptSync(value, salt, 32)
  return timingSafeEqual(candidate, Buffer.from(digest, 'hex'))
}

function sign(value, secret) { return createHmac('sha256', secret).update(value).digest('base64url') }

async function installation() {
  if (!pool) return null
  const db = await database()
  const result = await db.query('SELECT * FROM app_installation WHERE id = 1')
  return result.rows[0] ?? null
}

export function databaseUrlFromFields(value) {
  if (!value || typeof value !== 'object') return null
  const { host, port, name, user, password } = value
  if (typeof host !== 'string' || !/^[a-zA-Z0-9._-]{1,253}$/.test(host) || typeof name !== 'string' || !/^[a-zA-Z0-9_-]{1,63}$/.test(name) || typeof user !== 'string' || !/^[a-zA-Z0-9_-]{1,63}$/.test(user) || typeof password !== 'string' || !password || password.length > 256) return null
  const portNumber = Number(port)
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) return null
  try {
    const url = new URL('postgresql://localhost')
    url.hostname = host
    url.port = String(portNumber)
    url.pathname = `/${name}`
    url.username = user
    url.password = password
    return url.hostname ? url.toString() : null
  } catch { return null }
}

export async function amapCredentials() {
  if (cachedAmapCredentials && Date.now() - cachedAmapCredentials.at < 30_000) return cachedAmapCredentials.value
  try {
    const row = await installation()
    const value = { key: row?.amap_js_key || process.env.AMAP_JS_KEY || '', securityCode: row?.amap_security_code || process.env.AMAP_SECURITY_CODE || '' }
    cachedAmapCredentials = { at: Date.now(), value }
    return value
  } catch {
    return { key: process.env.AMAP_JS_KEY || '', securityCode: process.env.AMAP_SECURITY_CODE || '' }
  }
}

export function validAmapCredential(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9]{32}$/.test(value)
}

export function validAdminUsername(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_]{3,32}$/.test(value)
}

export function validAiUrl(value) {
  if (typeof value !== 'string' || value.length > 500) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname.endsWith('/chat/completions')
  } catch { return false }
}

export function modelsUrl(value) {
  if (!validAiUrl(value)) throw new Error('请输入以 /chat/completions 结尾的 HTTPS 接口地址')
  const url = new URL(value)
  url.pathname = `${url.pathname.slice(0, -'/chat/completions'.length)}/models`
  return url.toString()
}

export function validConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false
  const short = (value, max = 120) => typeof value === 'string' && value.trim().length > 0 && value.length <= max
  const validPoint = (point) => Array.isArray(point) && point.length === 2 && !(point[0] === 0 && point[1] === 0) && point.every((coordinate, index) => typeof coordinate === 'number' && Number.isFinite(coordinate) && Math.abs(coordinate) <= (index === 0 ? 180 : 90))
  const validLeg = (leg) => leg && short(leg.label, 200) && short(leg.origin, 200) && short(leg.destination, 200) && validPoint(leg.originPoint) && validPoint(leg.destinationPoint)
  if (!short(config.title) || !short(config.subtitle, 300) || !Array.isArray(config.members) || config.members.length < 1 || config.members.length > 12) return false
  if (!config.members.every((member) => member && /^[a-z][a-z0-9_-]{0,31}$/.test(member.id) && short(member.name, 40) && Number.isInteger(member.shares) && member.shares >= 1 && member.shares <= 12)) return false
  if (new Set(config.members.map((member) => member.id)).size !== config.members.length) return false
  if (!Array.isArray(config.days) || config.days.length < 1 || config.days.length > 30) return false
  return config.days.every((day) => {
    if (!day || !short(day.date, 20) || !short(day.weekday, 20) || !short(day.place) || !short(day.route, 200) || !short(day.title)) return false
    if (typeof day.detail !== 'string' || day.detail.length > 2000 || typeof day.timing !== 'string' || day.timing.length > 500) return false
    if (!Array.isArray(day.tags) || day.tags.length > 12 || !day.tags.every((tag) => short(tag, 30))) return false
    if (!Array.isArray(day.items) || day.items.length > 30 || !day.items.every((item) => item && ['餐饮', '景点', '节奏', '返程'].includes(item.kind) && short(item.title) && typeof item.detail === 'string' && item.detail.length <= 1000)) return false
    if (!Array.isArray(day.legs) || day.legs.length > 8 || !day.legs.every(validLeg)) return false
    return !day.stay || (short(day.stay.hotel, 200) && short(day.stay.address, 300) && short(day.stay.rooms) && (day.stay.price === undefined || (typeof day.stay.price === 'number' && day.stay.price >= 0)))
  })
}

function publicConfig(row) { return row.config }

export function membersChanged(previous, next) {
  return previous.length !== next.length || previous.some((member, index) =>
    member.id !== next[index]?.id || member.shares !== next[index]?.shares)
}

function session(request, installed, cookieName = 'trip_session') {
  const cookie = request.headers.cookie?.split('; ').find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1)
  if (!cookie) return null
  const [data, signature] = cookie.split('.')
  if (!data || !signature) return null
  const expected = sign(data, installed.session_secret)
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null
  try {
    const parsed = JSON.parse(Buffer.from(data, 'base64url').toString())
    return parsed.expires > Date.now() && (cookieName === 'admin_session' ? parsed.role === 'admin' : parsed.role === 'traveler' && (parsed.user === null || installed.config.members.some((member) => member.id === parsed.user))) ? parsed : null
  } catch { return null }
}

function setSession(request, response, installed, user, admin = false) {
  const maxAge = admin ? 7 * 86400 : 30 * 86400
  const value = Buffer.from(JSON.stringify({ role: admin ? 'admin' : 'traveler', user, expires: Date.now() + maxAge * 1000 })).toString('base64url')
  const secure = request.headers['x-forwarded-proto'] === 'https' || request.socket.encrypted ? '; Secure' : ''
  response.setHeader('Set-Cookie', `${admin ? 'admin_session' : 'trip_session'}=${value}.${sign(value, installed.session_secret)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`)
}

export function validExpense(value, members = defaultMembers) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 100) return false
  if (!Number.isInteger(value.amountCents) || value.amountCents < 1 || value.amountCents > 100000000) return false
  if (!['shared', 'personal'].includes(value.kind)) return false
  if (!['出发前准备', '住宿', '餐饮', '加油', '门票', '停车', '其他'].includes(value.category)) return false
  if (value.date !== null && (typeof value.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.date) || Number.isNaN(Date.parse(value.date)))) return false
  if (typeof value.note !== 'string' || value.note.length > 500) return false
  if (value.allocation !== null && value.allocation !== undefined) {
    if (!value.allocation || typeof value.allocation !== 'object' || Array.isArray(value.allocation)) return false
    const entries = Object.entries(value.allocation)
    if (!entries.length || entries.some(([id, shares]) => !members.some((member) => member.id === id && Number.isInteger(shares) && shares >= 1 && shares <= member.shares))) return false
  }
  return true
}

function validTrafficEvidence(value) {
  const number = (item) => typeof item === 'number' && Number.isFinite(item) && item >= 0 && item < 10000000
  const text = (item, length) => typeof item === 'string' && item.length > 0 && item.length <= length
  return text(value?.routeLabel, 100) && typeof value.sourceAt === 'string' && Number.isFinite(Date.parse(value.sourceAt)) && Array.isArray(value.routes) && value.routes.length > 0 && value.routes.length <= 3 &&
    value.routes.every((route) => route && number(route.distance) && number(route.time) && number(route.covered) &&
      Array.isArray(route.mainRoads) && route.mainRoads.length <= 8 && route.mainRoads.every((road) => text(road, 80)) &&
      Array.isArray(route.traffic) && route.traffic.length <= 10 && route.traffic.every((item) => text(item.status, 12) && number(item.distance)) &&
      Array.isArray(route.roads) && route.roads.length <= 20 && route.roads.every((item) => text(item.road, 80) && text(item.status, 12) && number(item.distance)))
}

function aiSettings(installed) {
  return {
    url: installed.ai_url || process.env.TRAFFIC_AI_URL || '',
    key: installed.ai_api_key || process.env.TRAFFIC_AI_API_KEY || '',
    model: installed.ai_model || process.env.TRAFFIC_AI_MODEL || '',
  }
}

async function trafficAdvice(evidence, installed, force = false) {
  const { url, key, model } = aiSettings(installed)
  if (!key) throw new Error('AI 服务端密钥尚未配置')
  const cacheKey = createHash('sha256').update(JSON.stringify({ url, model, source: evidence.source, routeLabel: evidence.routeLabel, routes: evidence.routes })).digest('hex')
  const cached = trafficAdviceCache.get(cacheKey)
  if (!force && cached && Date.now() - Date.parse(cached.updatedAt) < 5 * 60 * 1000) return cached
  if (trafficAdvicePending.has(cacheKey)) return trafficAdvicePending.get(cacheKey)

  const pending = (async () => {
  const kilometers = (meters) => Number((meters / 1000).toFixed(1))
  const minutes = (seconds) => Math.round(seconds / 60)
  const aiEvidence = {
    routeLabel: evidence.routeLabel,
    routes: evidence.routes.map((route) => ({
      distanceKm: kilometers(route.distance),
      timeMinutes: minutes(route.time),
      coveredKm: kilometers(route.covered),
      mainRoads: route.mainRoads,
      traffic: route.traffic.map((item) => ({ status: item.status, distanceKm: kilometers(item.distance) })),
      roads: route.roads.map((item) => ({ road: item.road, status: item.status, distanceKm: kilometers(item.distance) })),
    })),
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 280,
      messages: [
        { role: 'system', content: `你是自驾路况助手。只依据用户提供的高德驾车路线数据，给出简短、具体的中文建议。距离字段均为公里，时间字段均为分钟；coveredKm 是有路况状态的里程，mainRoads 是实际途经主路，不代表这些主路拥堵。${evidence.source === 'web-service' ? '这些路线由高德 Web 服务返回，可能和浏览器地图的备选路线不同。可以比较后台路线的道路和用时，但不要叫用户切换到浏览器中的某个路线编号；建议用户在地图中核对对应道路。' : '路线按顺序编号，第一条为推荐路线，其余为可切换的备选路线；地图每次只显示选中路线。只有数据中确实有备选路线时，才可比较时间、道路并建议切换，明确引用路线编号。'}不得虚构道路、管制、事故、天气、节省时间或未提供的实时信息。未提供通行数据的路段不得推断畅通，也不能预测国庆未来路况。若数据不足，明确说明无法判断。输出一到两句话纯文本，距离只能用公里；时间不足60分钟用分钟，达到60分钟用x小时x分钟，不使用米和秒，不使用 Markdown。` },
        { role: 'user', content: JSON.stringify(aiEvidence) },
      ],
    }),
    signal: AbortSignal.timeout(60000),
  })
  if (!response.ok) throw new Error(`AI 服务请求失败（${response.status}）`)
  const data = await response.json()
  const advice = data.choices?.[0]?.message?.content?.trim()
  if (typeof advice !== 'string' || !advice) throw new Error('AI 未返回有效建议')
  if (trafficAdviceCache.size > 100) trafficAdviceCache.clear()
  const result = { advice: advice.slice(0, 500), updatedAt: new Date().toISOString(), sourceAt: evidence.sourceAt, source: evidence.source || 'js-api' }
  trafficAdviceCache.set(cacheKey, result)
  return result
  })()
  trafficAdvicePending.set(cacheKey, pending)
  try { return await pending }
  finally { trafficAdvicePending.delete(cacheKey) }
}

function legSignature(leg) {
  return createHash('sha256').update(JSON.stringify([leg.label, leg.originPoint, leg.destinationPoint])).digest('hex')
}

export function webServiceEvidence(data, routeLabel, sourceAt) {
  if (data?.status !== '1' || !Array.isArray(data.route?.paths) || !data.route.paths.length) throw new Error('高德未返回有效路线')
  const routes = data.route.paths.slice(0, 3).map((path) => {
    const traffic = new Map()
    const roads = new Map()
    const mainRoads = new Map()
    for (const step of path.steps ?? []) {
      const road = typeof step.road === 'string' ? step.road.slice(0, 80) : ''
      if (road) mainRoads.set(road, (mainRoads.get(road) ?? 0) + Number(step.distance || 0))
      for (const segment of step.tmcs ?? []) {
        const distance = Number(segment.distance)
        const status = typeof segment.status === 'string' ? segment.status.slice(0, 12) : ''
        if (!status || !Number.isFinite(distance) || distance <= 0) continue
        traffic.set(status, (traffic.get(status) ?? 0) + distance)
        if (road) {
          const key = `${road}\0${status}`
          roads.set(key, { road, status, distance: (roads.get(key)?.distance ?? 0) + distance })
        }
      }
    }
    return {
      distance: Number(path.distance), time: Number(path.duration),
      covered: [...traffic.values()].reduce((sum, value) => sum + value, 0),
      mainRoads: [...mainRoads].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([road]) => road),
      traffic: [...traffic].map(([status, distance]) => ({ status, distance })),
      roads: [...roads.values()].sort((a, b) => b.distance - a.distance).slice(0, 20),
    }
  })
  const evidence = { routeLabel, sourceAt, source: 'web-service', routes }
  if (!validTrafficEvidence(evidence)) throw new Error('高德路线数据格式无效')
  return evidence
}

let trafficRefreshPending = false
export async function refreshTrafficCache({ force = false, target } = {}) {
  if ((trafficRefreshPending && !force) || !pool) return
  if (!force) trafficRefreshPending = true
  try {
    const installed = await installation()
    const key = installed?.amap_web_service_key || process.env.AMAP_WEB_SERVICE_KEY
    if (!installed || !key) return
    const db = await database()
    const aiJobs = []
    for (const [dayIndex, day] of installed.config.days.entries()) for (const [legIndex, leg] of day.legs.entries()) {
      if (target && (target.dayIndex !== dayIndex || target.legIndex !== legIndex)) continue
      const signature = legSignature(leg)
      let current = (await db.query('SELECT * FROM trip_route_cache WHERE trip_id = $1 AND day_index = $2 AND leg_index = $3', [tripId, dayIndex, legIndex])).rows[0]
      const routeDue = (force || installed.traffic_auto_enabled) && (force || current?.signature !== signature || !current?.fetched_at || Date.now() - new Date(current.fetched_at).getTime() >= installed.traffic_refresh_minutes * 60_000)
      if (routeDue) {
        try {
          const url = new URL('https://restapi.amap.com/v3/direction/driving')
          url.searchParams.set('key', key)
          url.searchParams.set('origin', leg.originPoint.join(','))
          url.searchParams.set('destination', leg.destinationPoint.join(','))
          url.searchParams.set('extensions', 'all')
          url.searchParams.set('strategy', '10')
          const response = await fetch(url, { signal: AbortSignal.timeout(15000) })
          if (!response.ok) throw new Error(`高德请求失败：${response.status}`)
          const evidence = webServiceEvidence(await response.json(), leg.label, new Date().toISOString())
          const result = await db.query(`INSERT INTO trip_route_cache (trip_id, day_index, leg_index, signature, evidence, fetched_at)
            VALUES ($1, $2, $3, $4, $5, now())
            ON CONFLICT (trip_id, day_index, leg_index) DO UPDATE SET signature = EXCLUDED.signature,
              evidence = EXCLUDED.evidence, fetched_at = EXCLUDED.fetched_at,
              advice = CASE WHEN trip_route_cache.signature = EXCLUDED.signature THEN trip_route_cache.advice ELSE NULL END,
              advice_at = CASE WHEN trip_route_cache.signature = EXCLUDED.signature THEN trip_route_cache.advice_at ELSE NULL END
            RETURNING *`, [tripId, dayIndex, legIndex, signature, evidence])
          current = result.rows[0]
        } catch (error) { console.error(`Traffic refresh failed for day ${dayIndex + 1} leg ${legIndex + 1}:`, error.message) }
      }
      const evidenceFresh = current?.fetched_at && Date.now() - new Date(current.fetched_at).getTime() <= (installed.traffic_refresh_minutes + 1) * 60_000
      if (current?.signature !== signature || !current?.evidence || !evidenceFresh || !aiSettings(installed).key || !aiSettings(installed).url || !aiSettings(installed).model) continue
      const adviceDue = (force || installed.ai_auto_enabled) && (force || !current.advice_at || Date.now() - new Date(current.advice_at).getTime() >= installed.ai_refresh_minutes * 60_000)
      if (adviceDue) {
        aiJobs.push((async () => {
          try {
            const advice = await trafficAdvice(current.evidence, installed, force)
            await db.query('UPDATE trip_route_cache SET advice = $4, advice_at = now() WHERE trip_id = $1 AND day_index = $2 AND leg_index = $3 AND signature = $5', [tripId, dayIndex, legIndex, advice, signature])
          } catch (error) { console.error(`AI refresh failed for day ${dayIndex + 1} leg ${legIndex + 1}:`, error.message) }
        })())
      }
    }
    await Promise.all(aiJobs)
  } catch (error) { console.error('Traffic scheduler failed:', error.message) }
  finally { if (!force) trafficRefreshPending = false }
}

export function startTrafficScheduler() {
  const timer = setInterval(() => { void refreshTrafficCache() }, 60_000)
  timer.unref()
  void refreshTrafficCache()
}

export async function handleTripData(request, response) {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname
  if (path === '/api/health') {
    try { const db = await database(); await db.query('SELECT 1'); send(response, 200, { status: 'ok', database: 'ok' }) }
    catch { send(response, 503, { status: 'error', database: 'unavailable' }) }
    return true
  }
  if (!path.startsWith('/api/trip/') && !path.startsWith('/api/install') && !path.startsWith('/api/admin/')) return false
  try {
    if (!['GET', 'HEAD'].includes(request.method)) {
      const origin = request.headers.origin
      const host = request.headers.host
      if (origin && new URL(origin).host !== host) { send(response, 403, { error: '请求来源无效' }); return true }
      if (request.method !== 'DELETE' && request.headers['content-type']?.split(';')[0] !== 'application/json') { send(response, 415, { error: '请使用 JSON 请求' }); return true }
    }
    const locked = existsSync(installLock)
    const installed = locked && path === '/api/install/status' ? true : await installation()
    if (path === '/api/install/status' && request.method === 'GET') {
      send(response, 200, { installed: !!installed })
      return true
    }
    if (path === '/api/install' && request.method === 'POST') {
      if (locked || installed || installInProgress) { send(response, 409, { error: '系统已安装或正在安装' }); return true }
      if (!allowAuthAttempt(request, 'install')) { send(response, 429, { error: '尝试次数过多，请稍后再试' }); return true }
      const { database: databaseFields, adminUsername, adminPassword, accessCode: code, config } = await bodyJson(request)
      const databaseUrl = databaseUrlFromFields(databaseFields)
      if (!pool && !databaseUrl) { send(response, 400, { error: '请填写有效的 PostgreSQL 连接信息' }); return true }
      if (!validAdminUsername(adminUsername) || typeof adminPassword !== 'string' || adminPassword.length < 8 || adminPassword.length > 128 || typeof code !== 'string' || code.trim().length < 2 || code.length > 100 || !validConfig(config)) { send(response, 400, { error: '请检查管理员用户名、密码、访问码和行程信息' }); return true }
      if (installInProgress || existsSync(installLock)) { send(response, 409, { error: '系统已安装或正在安装' }); return true }
      installInProgress = true
      try {
        if (!pool) {
          const candidate = new pg.Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 5000 })
          try { await candidate.query('SELECT 1') }
          catch { await candidate.end(); send(response, 400, { error: '数据库连接失败，请检查地址、账号和密码' }); return true }
          pool = candidate
          ready = undefined
        }
        const db = await database()
        const existing = await db.query('SELECT id FROM app_installation WHERE id = 1')
        if (existing.rowCount || existsSync(installLock)) { send(response, 409, { error: '系统已安装' }); return true }
        const existingPayers = await db.query('SELECT DISTINCT payer FROM trip_expenses WHERE trip_id = $1 AND deleted_at IS NULL', [tripId])
        if (existingPayers.rows.some((row) => !config.members.some((member) => member.id === row.payer))) { send(response, 409, { error: '现有账本包含其他成员，请使用原行程模板安装' }); return true }
        if (!existsSync(databaseFile) && !process.env.DATABASE_URL) {
          mkdirSync(dataDir, { recursive: true })
          writeFileSync(databaseFile, JSON.stringify({ databaseUrl }), { mode: 0o600, flag: 'wx' })
        }
        const result = await db.query(`INSERT INTO app_installation (id, admin_username, admin_hash, access_hash, session_secret, config)
          VALUES (1, $1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING RETURNING id`,
        [adminUsername, hashSecret(adminPassword), hashSecret(code), randomBytes(32).toString('hex'), config])
        if (!result.rowCount) { send(response, 409, { error: '系统已安装' }); return true }
        mkdirSync(dataDir, { recursive: true })
        writeFileSync(installLock, new Date().toISOString(), { mode: 0o600, flag: 'wx' })
        send(response, 201, { installed: true })
      } finally {
        installInProgress = false
        if (!existsSync(databaseFile) && !process.env.DATABASE_URL && !existsSync(installLock) && pool) {
          await pool.end()
          pool = null
          ready = undefined
        }
      }
      return true
    }
    if (!installed) { send(response, 409, { error: '系统尚未安装', installRequired: true }); return true }
    if (path === '/api/admin/session') {
      if (request.method === 'GET') { send(response, 200, { authenticated: !!session(request, installed, 'admin_session') }); return true }
      if (request.method === 'POST') {
        if (!allowAuthAttempt(request, 'admin')) { send(response, 429, { error: '尝试次数过多，请稍后再试' }); return true }
        const { username, password } = await bodyJson(request)
        if (typeof username !== 'string' || username !== installed.admin_username || typeof password !== 'string' || password.length > 128 || !verifySecret(password, installed.admin_hash)) { send(response, 401, { error: '管理员用户名或密码错误' }); return true }
        setSession(request, response, installed, null, true)
        send(response, 200, { authenticated: true })
        return true
      }
      if (request.method === 'DELETE') {
        response.setHeader('Set-Cookie', 'admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0')
        send(response, 200, { authenticated: false })
        return true
      }
    }
    if (path.startsWith('/api/admin/')) {
      if (!session(request, installed, 'admin_session')) { send(response, 401, { error: '请先登录管理后台' }); return true }
      if (path === '/api/admin/account' && request.method === 'GET') {
        send(response, 200, { username: installed.admin_username })
        return true
      }
      if (path === '/api/admin/account' && request.method === 'PUT') {
        const { username, password } = await bodyJson(request)
        if ((username !== undefined && !validAdminUsername(username)) || (password !== undefined && (typeof password !== 'string' || password.length < 8 || password.length > 128)) || (username === undefined && password === undefined)) {
          send(response, 400, { error: '用户名须为 3–32 位字母、数字或下划线；密码至少 8 位' }); return true
        }
        if (username === installed.admin_username && password === undefined) { send(response, 200, { username }); return true }
        const db = await database()
        const result = await db.query(`UPDATE app_installation SET admin_username = COALESCE($1, admin_username),
          admin_hash = COALESCE($2, admin_hash), session_secret = $3, updated_at = now() WHERE id = 1 RETURNING *`,
        [username ?? null, password ? hashSecret(password) : null, randomBytes(32).toString('hex')])
        setSession(request, response, result.rows[0], null, true)
        send(response, 200, { username: result.rows[0].admin_username })
        return true
      }
      if (path === '/api/admin/ai-settings' && request.method === 'GET') {
        const current = aiSettings(installed)
        send(response, 200, { url: current.url, model: current.model, keyConfigured: !!current.key, refreshMinutes: installed.ai_refresh_minutes, autoEnabled: installed.ai_auto_enabled })
        return true
      }
      if (path === '/api/admin/ai-settings' && request.method === 'PUT') {
        const { url, apiKey, model, refreshMinutes, autoEnabled } = await bodyJson(request)
        if ((url !== undefined && !validAiUrl(url)) || (apiKey !== undefined && (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 500)) ||
          (model !== undefined && (typeof model !== 'string' || !/^[a-zA-Z0-9_.:/-]{1,120}$/.test(model))) ||
          (refreshMinutes !== undefined && (!Number.isInteger(refreshMinutes) || refreshMinutes < 1 || refreshMinutes > 1440)) ||
          (autoEnabled !== undefined && typeof autoEnabled !== 'boolean')) {
          send(response, 400, { error: '请检查 AI 接口地址、API Key 和模型名称' }); return true
        }
        const db = await database()
        const result = await db.query(`UPDATE app_installation SET ai_url = COALESCE($1, ai_url),
          ai_api_key = COALESCE($2, ai_api_key), ai_model = COALESCE($3, ai_model),
          ai_refresh_minutes = COALESCE($4, ai_refresh_minutes), ai_auto_enabled = COALESCE($5, ai_auto_enabled), updated_at = now()
          WHERE id = 1 RETURNING *`, [url ?? null, apiKey ?? null, model ?? null, refreshMinutes ?? null, autoEnabled ?? null])
        trafficAdviceCache.clear()
        const current = aiSettings(result.rows[0])
        send(response, 200, { url: current.url, model: current.model, keyConfigured: !!current.key, refreshMinutes: result.rows[0].ai_refresh_minutes, autoEnabled: result.rows[0].ai_auto_enabled })
        void refreshTrafficCache()
        return true
      }
      if (path === '/api/admin/ai-models' && request.method === 'POST') {
        const { url, apiKey } = await bodyJson(request)
        const current = aiSettings(installed)
        const endpoint = url || current.url
        const key = apiKey || current.key
        if (!validAiUrl(endpoint) || !key) { send(response, 400, { error: '请先填写有效的 HTTPS 接口地址和 API Key' }); return true }
        try {
          const result = await fetch(modelsUrl(endpoint), {
            headers: { Authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(10000),
          })
          if (!result.ok) { send(response, 502, { error: `获取模型列表失败（${result.status}），可手动填写模型名称` }); return true }
          const data = await result.json()
          const models = Array.isArray(data.data) ? data.data.map((item) => item?.id).filter((id) => typeof id === 'string' && id.length <= 120).slice(0, 200) : []
          if (!models.length) { send(response, 502, { error: '接口未返回可选模型，可手动填写模型名称' }); return true }
          send(response, 200, { models: [...new Set(models)].sort() })
        } catch { send(response, 502, { error: '暂时无法获取模型列表，可手动填写模型名称' }) }
        return true
      }
      if (path === '/api/admin/map-settings' && request.method === 'GET') {
        send(response, 200, { key: installed.amap_js_key || process.env.AMAP_JS_KEY || '', securityConfigured: !!(installed.amap_security_code || process.env.AMAP_SECURITY_CODE), webServiceConfigured: !!(installed.amap_web_service_key || process.env.AMAP_WEB_SERVICE_KEY), refreshMinutes: installed.traffic_refresh_minutes, autoEnabled: installed.traffic_auto_enabled })
        return true
      }
      if (path === '/api/admin/map-settings' && request.method === 'PUT') {
        const { key, securityCode, webServiceKey, refreshMinutes, autoEnabled } = await bodyJson(request)
        if ((key !== undefined && !validAmapCredential(key)) || (securityCode !== undefined && !validAmapCredential(securityCode)) ||
          (webServiceKey !== undefined && !validAmapCredential(webServiceKey)) ||
          (refreshMinutes !== undefined && (!Number.isInteger(refreshMinutes) || refreshMinutes < 1 || refreshMinutes > 1440)) ||
          (autoEnabled !== undefined && typeof autoEnabled !== 'boolean')) {
          send(response, 400, { error: '高德 Key 和安全密钥均应为 32 位字母或数字' }); return true
        }
        const db = await database()
        const result = await db.query(`UPDATE app_installation SET amap_js_key = COALESCE($1, amap_js_key),
          amap_security_code = COALESCE($2, amap_security_code), amap_web_service_key = COALESCE($3, amap_web_service_key),
          traffic_refresh_minutes = COALESCE($4, traffic_refresh_minutes), traffic_auto_enabled = COALESCE($5, traffic_auto_enabled),
          updated_at = now() WHERE id = 1 RETURNING *`, [key ?? null, securityCode ?? null, webServiceKey ?? null, refreshMinutes ?? null, autoEnabled ?? null])
        cachedAmapCredentials = undefined
        send(response, 200, { key: result.rows[0].amap_js_key || process.env.AMAP_JS_KEY || '', securityConfigured: !!(result.rows[0].amap_security_code || process.env.AMAP_SECURITY_CODE), webServiceConfigured: !!(result.rows[0].amap_web_service_key || process.env.AMAP_WEB_SERVICE_KEY), refreshMinutes: result.rows[0].traffic_refresh_minutes, autoEnabled: result.rows[0].traffic_auto_enabled })
        void refreshTrafficCache()
        return true
      }
      if (path === '/api/admin/config' && request.method === 'GET') { send(response, 200, { config: publicConfig(installed) }); return true }
      if (path === '/api/admin/audit' && request.method === 'GET') {
        const limitValue = Number(new URL(request.url ?? '/', 'http://localhost').searchParams.get('limit') ?? 100)
        const limit = Number.isInteger(limitValue) ? Math.min(Math.max(limitValue, 1), 200) : 100
        const db = await database()
        const result = await db.query(`SELECT id::text, actor, action, expense_id::text AS "expenseId", snapshot, created_at AS "createdAt"
          FROM trip_audit_log WHERE trip_id = $1 ORDER BY id DESC LIMIT $2`, [tripId, limit])
        const names = new Map(installed.config.members.map((member) => [member.id, member.name]))
        send(response, 200, { entries: result.rows.map((entry) => ({ ...entry, actorName: names.get(entry.actor) ?? entry.actor })) })
        return true
      }
      if (path === '/api/admin/config' && request.method === 'PUT') {
        const { config, accessCode: code } = await bodyJson(request)
        if (!validConfig(config) || (code !== undefined && (typeof code !== 'string' || code.trim().length < 2 || code.length > 100))) { send(response, 400, { error: '设置格式无效' }); return true }
        const db = await database()
        const client = await db.connect()
        let result
        try {
          await client.query('BEGIN')
          const locked = await client.query('SELECT config FROM app_installation WHERE id = 1 FOR UPDATE')
          const previousMembers = locked.rows[0].config.members
          if (membersChanged(previousMembers, config.members)) {
            await client.query(`UPDATE trip_expenses SET allocation = $2::jsonb
              WHERE trip_id = $1 AND kind = 'shared' AND allocation IS NULL AND deleted_at IS NULL`,
            [tripId, JSON.stringify(Object.fromEntries(previousMembers.map((member) => [member.id, member.shares])))])
          }
          const payers = await client.query('SELECT DISTINCT payer FROM trip_expenses WHERE trip_id = $1 AND deleted_at IS NULL', [tripId])
          const allocations = await client.query("SELECT allocation FROM trip_expenses WHERE trip_id = $1 AND deleted_at IS NULL AND kind = 'shared' AND allocation IS NOT NULL", [tripId])
          const usedIds = new Set([...payers.rows.map((row) => row.payer), ...allocations.rows.flatMap((row) => Object.keys(row.allocation))])
          if ([...usedIds].some((id) => !config.members.some((member) => member.id === id))) {
            await client.query('ROLLBACK')
            send(response, 409, { error: '已有账目引用的成员不能删除' })
            return true
          }
          result = await client.query(`UPDATE app_installation SET config = $1, access_hash = COALESCE($2, access_hash),
            session_secret = CASE WHEN $2::text IS NOT NULL THEN $3 ELSE session_secret END,
            updated_at = now() WHERE id = 1 RETURNING *`,
          [config, code ? hashSecret(code) : null, randomBytes(32).toString('hex')])
          await client.query('COMMIT')
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        } finally { client.release() }
        if (code) setSession(request, response, result.rows[0], null, true)
        send(response, 200, { config: result.rows[0].config })
        return true
      }
      send(response, 404, { error: '接口不存在' })
      return true
    }
    if (path === '/api/trip/session') {
      if (request.method === 'GET') { const current = session(request, installed); send(response, 200, { authenticated: !!current, user: current?.user ?? null }); return true }
      if (request.method === 'POST') {
        if (!allowAuthAttempt(request, 'traveler')) { send(response, 429, { error: '尝试次数过多，请稍后再试' }); return true }
        const { code } = await bodyJson(request)
        if (typeof code !== 'string' || code.length > 100 || !verifySecret(code, installed.access_hash)) { send(response, 401, { error: '访问码不正确' }); return true }
        setSession(request, response, installed, null)
        send(response, 200, { authenticated: true, user: null })
        return true
      }
      if (request.method === 'DELETE') {
        response.setHeader('Set-Cookie', 'trip_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0')
        send(response, 200, { authenticated: false })
        return true
      }
    }
    const current = session(request, installed)
    if (!current) { send(response, 401, { error: '请先输入访问码' }); return true }
    if (path === '/api/trip/config' && request.method === 'GET') { send(response, 200, { config: publicConfig(installed) }); return true }
    if (path === '/api/trip/user' && request.method === 'PUT') {
      const { user } = await bodyJson(request)
      if (!installed.config.members.some((member) => member.id === user)) { send(response, 400, { error: '请选择用户' }); return true }
      setSession(request, response, installed, user)
      send(response, 200, { user })
      return true
    }
    if (!current.user) { send(response, 403, { error: '请先选择用户' }); return true }
    if (path === '/api/trip/route-cache' && ['GET', 'POST'].includes(request.method)) {
      const params = new URL(request.url ?? '/', 'http://localhost').searchParams
      const dayIndex = Number(params.get('day'))
      const legIndex = Number(params.get('leg'))
      const leg = Number.isInteger(dayIndex) && Number.isInteger(legIndex) && dayIndex >= 0 && legIndex >= 0 ? installed.config.days[dayIndex]?.legs[legIndex] : null
      if (!leg) { send(response, 404, { error: '路线不存在' }); return true }
      const configured = !!(installed.amap_web_service_key || process.env.AMAP_WEB_SERVICE_KEY)
      if (request.method === 'POST' && configured) await refreshTrafficCache({ force: true, target: { dayIndex, legIndex } })
      const db = await database()
      const row = (await db.query('SELECT signature, evidence, fetched_at, advice, advice_at FROM trip_route_cache WHERE trip_id = $1 AND day_index = $2 AND leg_index = $3', [tripId, dayIndex, legIndex])).rows[0]
      const valid = row?.signature === legSignature(leg)
      send(response, 200, { configured, evidence: valid ? row.evidence : null, fetchedAt: valid ? row.fetched_at : null, advice: valid ? row.advice : null, adviceAt: valid ? row.advice_at : null, trafficRefreshMinutes: installed.traffic_refresh_minutes, aiRefreshMinutes: installed.ai_refresh_minutes, trafficAutoEnabled: installed.traffic_auto_enabled, aiAutoEnabled: installed.ai_auto_enabled })
      return true
    }
    if (path === '/api/trip/traffic-advice' && request.method === 'POST') {
      const evidence = await bodyJson(request)
      if (!validTrafficEvidence(evidence)) { send(response, 400, { error: '高德路线数据格式无效' }); return true }
      try { send(response, 200, await trafficAdvice(evidence, installed)) }
      catch (error) { send(response, 503, { error: error.message === 'AI 服务端密钥尚未配置' ? error.message : 'AI 建议暂不可用，请稍后重试' }) }
      return true
    }
    const db = await database()
    if (path === '/api/trip/notes') {
      if (request.method === 'GET') {
        const result = await db.query('SELECT content, updated_at FROM trip_notes WHERE trip_id = $1', [tripId])
        send(response, 200, { content: result.rows[0]?.content ?? '', updatedAt: result.rows[0]?.updated_at ?? null })
      } else if (request.method === 'PUT') {
        const { content } = await bodyJson(request)
        if (typeof content !== 'string' || content.length > 5000) { send(response, 400, { error: '备注格式无效' }); return true }
        const result = await db.query(`INSERT INTO trip_notes (trip_id, content) VALUES ($1, $2)
          ON CONFLICT (trip_id) DO UPDATE SET content = EXCLUDED.content, updated_at = now() RETURNING updated_at`, [tripId, content])
        send(response, 200, { updatedAt: result.rows[0].updated_at })
      } else send(response, 405, { error: '不支持此方法' })
      return true
    }
    if (path === '/api/trip/expenses') {
      if (request.method === 'GET') {
        const result = await db.query(`SELECT id::text, expense_date::text AS date, title,
          amount_cents AS "amountCents", payer, kind, category, note, allocation, seed_key AS "seedKey"
          FROM trip_expenses WHERE trip_id = $1 AND deleted_at IS NULL ORDER BY expense_date NULLS FIRST, id`, [tripId])
        send(response, 200, { expenses: result.rows })
      } else if (request.method === 'POST') {
        const value = await bodyJson(request)
        if (!validExpense(value, installed.config.members)) { send(response, 400, { error: '请检查消费内容和金额' }); return true }
        const result = await db.query(`INSERT INTO trip_expenses
          (trip_id, expense_date, title, amount_cents, payer, kind, category, note, allocation)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id::text`,
        [tripId, value.date, value.title.trim(), value.amountCents, current.user, value.kind, value.category, value.note.trim(), value.kind === 'shared' ? (value.allocation ?? null) : null])
        const created = await db.query(`SELECT id::text, expense_date::text AS date, title, amount_cents AS "amountCents", payer, kind, category, note, allocation, seed_key AS "seedKey"
          FROM trip_expenses WHERE id = $1`, [result.rows[0].id])
        await audit(db, current.user, 'create', result.rows[0].id, created.rows[0])
        send(response, 201, { id: result.rows[0].id })
      } else send(response, 405, { error: '不支持此方法' })
      return true
    }
    const match = path.match(/^\/api\/trip\/expenses\/(\d+)$/)
    if (match && request.method === 'PUT') {
      const value = await bodyJson(request)
      if (!validExpense(value, installed.config.members)) { send(response, 400, { error: '请检查消费内容和金额' }); return true }
      const result = await db.query(`UPDATE trip_expenses SET expense_date = $1, title = $2, amount_cents = $3,
        kind = $4, category = $5, note = $6, allocation = $7
        WHERE id = $8 AND trip_id = $9 AND payer = $10 AND deleted_at IS NULL RETURNING id`,
      [value.date, value.title.trim(), value.amountCents, value.kind, value.category, value.note.trim(), value.kind === 'shared' ? (value.allocation ?? null) : null, match[1], tripId, current.user])
      if (!result.rowCount) { send(response, 404, { error: '记录不存在或不属于当前用户' }); return true }
      const updated = await db.query(`SELECT id::text, expense_date::text AS date, title, amount_cents AS "amountCents", payer, kind, category, note, allocation, seed_key AS "seedKey"
        FROM trip_expenses WHERE id = $1`, [match[1]])
      await audit(db, current.user, 'update', match[1], updated.rows[0])
      send(response, 200, { expense: updated.rows[0] })
      return true
    }
    if (match && request.method === 'DELETE') {
      const existing = await db.query(`SELECT id::text, expense_date::text AS date, title, amount_cents AS "amountCents", payer, kind, category, note, allocation, seed_key AS "seedKey"
        FROM trip_expenses WHERE id = $1 AND trip_id = $2 AND payer = $3 AND deleted_at IS NULL`, [match[1], tripId, current.user])
      if (!existing.rowCount) { send(response, 404, { error: '记录不存在或不属于当前用户' }); return true }
      const result = await db.query(`UPDATE trip_expenses SET deleted_at = now()
        WHERE id = $1 AND trip_id = $2 AND payer = $3 AND deleted_at IS NULL RETURNING id`, [match[1], tripId, current.user])
      await audit(db, current.user, 'delete', match[1], existing.rows[0])
      send(response, result.rowCount ? 200 : 404, result.rowCount ? { deleted: true } : { error: '记录不存在或不属于当前用户' })
      return true
    }
    if (path === '/api/trip/expenses/export.csv' && request.method === 'GET') {
      const result = await db.query(`SELECT expense_date::text AS date, title, amount_cents AS "amountCents", payer, kind, category, note, allocation
        FROM trip_expenses WHERE trip_id = $1 AND deleted_at IS NULL ORDER BY expense_date NULLS FIRST, id`, [tripId])
      const memberName = new Map(installed.config.members.map((member) => [member.id, member.name]))
      const quote = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`
      const rows = result.rows.map((row) => [row.date ?? '出发前', row.title, (Number(row.amountCents) / 100).toFixed(2), memberName.get(row.payer) ?? row.payer, row.kind === 'shared' ? '共同开支' : '个人开支', row.category, row.note, row.allocation ? Object.entries(row.allocation).map(([id, shares]) => `${memberName.get(id) ?? id}${shares}份`).join('、') : '全员分摊'])
      sendCsv(response, [['日期', '项目', '金额', '付款人', '类型', '类别', '备注', '分摊'], ...rows].map((row) => row.map(quote).join(',')).join('\r\n'))
      return true
    }
    send(response, 404, { error: '接口不存在' })
  } catch (error) {
    if (error.message === 'REQUEST_TOO_LARGE') send(response, 413, { error: '内容过长' })
    else if (error instanceof SyntaxError) send(response, 400, { error: '请求格式无效' })
    else { console.error('Trip data request failed:', error); send(response, 503, { error: '数据服务暂不可用' }) }
  }
  return true
}
