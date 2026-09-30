import { useEffect, useRef, useState } from 'react'
import MapPanel from './MapPanel'
import Entry from './Entry'
import Expenses, { api, calculate, money, type Expense, type UserId } from './Expenses'
import Install from './Install'
import Admin from './Admin'
import type { Day, TripConfig } from './tripConfig'
import { demoTrip as initialConfig } from './demoTrip'

type Position = { latitude: number; longitude: number }

function formatMoney(value: number) {
  return value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function openMap(day: Day, provider: 'amap' | 'baidu', position?: Position) {
  const address = `${day.stay?.hotel}，${day.stay?.address}`
  let url: string

  if (provider === 'baidu' && position) {
    url = `https://api.map.baidu.com/direction?origin=${position.latitude},${position.longitude}&destination=${encodeURIComponent(address)}&mode=driving&region=中国&output=html`
  } else if (provider === 'baidu') {
    url = `https://api.map.baidu.com/geocoder?address=${encodeURIComponent(address)}&output=html&src=tripweave`
  } else {
    url = `https://uri.amap.com/search?keyword=${encodeURIComponent(address)}&city=${encodeURIComponent(day.place)}`
  }

  window.open(url, '_blank', 'noopener,noreferrer')
}

function App() {
  const [auth, setAuth] = useState<'loading' | 'locked' | 'choose' | 'ready'>('loading')
  const [config, setConfig] = useState<TripConfig | null>(null)
  const [user, setUser] = useState<UserId | null>(null)
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [expenseError, setExpenseError] = useState('')
  const [expensesLoaded, setExpensesLoaded] = useState(false)
  const [offline, setOffline] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [position, setPosition] = useState<Position>()
  const [locationState, setLocationState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [notes, setNotes] = useState(() => localStorage.getItem('tripweave-notes') ?? '')
  const [noteStatus, setNoteStatus] = useState('正在连接…')
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    if (location.pathname === '/install' || location.pathname === '/admin') return
    void api<{ installed: boolean }>('/api/install/status').then(async ({ installed }) => {
      if (!installed) { location.assign('/install'); return }
      const data = await api<{ authenticated: boolean; user: UserId | null }>('/api/trip/session')
      if (data.authenticated) {
        const result = await api<{ config: TripConfig }>('/api/trip/config')
        setConfig(result.config)
        localStorage.setItem('trip-offline-config', JSON.stringify(result.config))
      }
      setUser(data.user)
      if (data.user) localStorage.setItem('trip-offline-user', data.user)
      setAuth(data.authenticated ? data.user ? 'ready' : 'choose' : 'locked')
    }).catch(() => {
      try {
        const cached = localStorage.getItem('trip-offline-config')
        const cachedUser = localStorage.getItem('trip-offline-user')
        if (cached && cachedUser) {
          setConfig(JSON.parse(cached)); setUser(cachedUser)
          setExpenses(JSON.parse(localStorage.getItem('trip-offline-expenses') || '[]'))
          setExpensesLoaded(true); setOffline(true); setAuth('ready')
          return
        }
      } catch { /* Corrupt offline cache falls back to the access page. */ }
      setAuth('locked')
    })
  }, [])

  async function loadConfig() {
    const result = await api<{ config: TripConfig }>('/api/trip/config')
    setConfig(result.config)
    localStorage.setItem('trip-offline-config', JSON.stringify(result.config))
    setAuth('choose')
  }

  async function refreshExpenses() {
    try {
      const data = await api<{ expenses: Expense[] }>('/api/trip/expenses')
      setExpenses(data.expenses)
      localStorage.setItem('trip-offline-expenses', JSON.stringify(data.expenses))
      setExpenseError('')
      setExpensesLoaded(true)
    } catch (cause) { setExpenseError((cause as Error).message); setExpensesLoaded(false) }
  }

  useEffect(() => {
    if (auth !== 'ready') return
    if (offline) return
    void refreshExpenses()
    let cancelled = false
    fetch('/api/trip/notes')
      .then(async (response) => {
        if (!response.ok) throw new Error('共享备注暂不可用')
        return response.json() as Promise<{ content: string }>
      })
      .then((data) => {
        if (cancelled) return
        if (data.content) {
          setNotes(data.content)
          localStorage.setItem('tripweave-notes', data.content)
        }
        setNoteStatus('已连接共享备注')
      })
      .catch((error) => { if (!cancelled) setNoteStatus(error.message) })
    return () => { cancelled = true }
  }, [auth, offline])

  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current) }, [])

  const days = config?.days ?? initialConfig.days
  const members = config?.members ?? initialConfig.members
  const activeDay = days[Math.min(activeIndex, days.length - 1)]
  const activeStay = activeDay.stay
  const progress = `${activeIndex + 1} / ${days.length}`

  function locate() {
    if (!navigator.geolocation) {
      setLocationState('error')
      return
    }
    setLocationState('loading')
    navigator.geolocation.getCurrentPosition(
      (result) => {
        setPosition({ latitude: result.coords.latitude, longitude: result.coords.longitude })
        setLocationState('ready')
      },
      () => setLocationState('error'),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 },
    )
  }

  useEffect(() => {
    if (auth === 'ready' && locationState === 'idle') locate()
  }, [auth, locationState])

  function saveNotes(value: string) {
    setNotes(value)
    localStorage.setItem('tripweave-notes', value)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    setNoteStatus('保存中…')
    saveTimer.current = setTimeout(() => {
      void fetch('/api/trip/notes', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: value }),
      }).then((response) => {
        if (!response.ok) throw new Error('共享保存失败')
        setNoteStatus('已同步到共享备注')
      }).catch((error) => setNoteStatus(error.message))
    }, 600)
  }

  async function logout() {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    await api('/api/trip/session', { method: 'DELETE' })
    localStorage.removeItem('trip-offline-config'); localStorage.removeItem('trip-offline-user'); localStorage.removeItem('trip-offline-expenses')
    setUser(null); setExpenses([]); setExpensesLoaded(false); setAuth('locked')
  }

  if (location.pathname === '/install') return <Install template={initialConfig} />
  if (location.pathname === '/admin') return <Admin />
  if (auth === 'loading') return <main className="entry-shell"><p>正在载入行程…</p></main>
  if (auth !== 'ready' || !user) return <Entry unlocked={auth === 'choose'} members={members} onUnlock={loadConfig} onSelect={(selected) => { setUser(selected); setAuth('ready') }} />

  const sharedTotal = calculate(expenses, members).total
  const totalShares = members.reduce((sum, member) => sum + member.shares, 0)

  return (
    <main className="app-shell">
      {offline && <p className="offline-banner" role="status">当前离线，显示上次保存的行程与账本；路况和消费操作需要联网。</p>}
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark">{config?.title ?? '出行计划'}</span>
          <span className="brand-caption">TRIP</span>
        </div>
        <div className="topbar-actions"><button className="identity-button" type="button" onClick={() => setAuth('choose')} title="切换用户">{members.find((person) => person.id === user)?.name} ▾</button><button className="logout-button" type="button" onClick={() => void logout()}>退出</button><button className="location-button" onClick={locate} type="button">
          <span className="location-dot" aria-hidden="true" />
          {locationState === 'loading' ? '定位中' : locationState === 'ready' ? '已定位' : '获取位置'}
        </button></div>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">{totalShares} 份 · {days.length} 天 · 自驾</p>
          <h1>{config?.title ?? '出行计划'}<br /><em>慢慢抵达</em></h1>
          <p className="hero-intro">{config?.subtitle}</p>
        </div>
        <div className="hero-stamp" aria-label="行程日期">
          <span>TRIP</span>
          <strong>{days.length} DAYS</strong>
          <small>{days[0]?.date} - {days.at(-1)?.date}</small>
        </div>
      </section>

      <section className="summary-strip" aria-label="费用概览">
        <div>
          <span className="summary-label">已知共同开支</span>
          <strong>{expensesLoaded ? `¥ ${money(sharedTotal)}` : expenseError ? '暂不可用' : '载入中'}</strong>
        </div>
        <div>
          <span className="summary-label">每份约</span>
          <strong>{expensesLoaded ? `¥ ${money(Math.round(sharedTotal / totalShares))}` : '—'}</strong>
        </div>
        <div>
          <span className="summary-label">行程进度</span>
          <strong>{progress}</strong>
        </div>
      </section>

      <nav className="day-nav" aria-label="选择日期">
        {days.map((day, index) => (
          <button
            className={`day-tab ${index === activeIndex ? 'is-active' : ''}`}
            key={day.date}
            onClick={() => setActiveIndex(index)}
            type="button"
          >
            <span>{day.date}</span>
            <small>{day.place}</small>
          </button>
        ))}
      </nav>

      <section className="day-panel" aria-live="polite">
        <div className="day-heading">
          <div>
            <p className="eyebrow">{activeDay.weekday} · DAY {activeIndex + 1}</p>
            <h2>{activeDay.title}</h2>
          </div>
          <span className="day-date">{activeDay.date}</span>
        </div>

        <div className="route-line">
          <span className="route-pin" aria-hidden="true">↗</span>
          <span>{activeDay.route}</span>
        </div>
        <p className="day-detail">{activeDay.detail}</p>
        <p className="timing-line">{activeDay.timing}</p>

        <div className="tag-row">
          {activeDay.tags.map((tag) => <span className="tag" key={tag}>{tag}</span>)}
        </div>

        {activeDay.legs.map((leg, legIndex) => (
          <MapPanel key={`${activeDay.date}-${leg.label}`} dayIndex={activeIndex} legIndex={legIndex} origin={leg.origin} destination={leg.destination} originPoint={leg.originPoint} destinationPoint={leg.destinationPoint} routeLabel={leg.label} position={position} />
        ))}

        <div className="plan-list">
          <div className="section-label plan-title">途中安排</div>
          {activeDay.items.map((item) => (
            <div className="plan-item" key={`${item.kind}-${item.title}`}>
              <span className={`plan-kind plan-kind-${item.kind}`}>{item.kind}</span>
              <div>
                <strong>{item.title}</strong>
                <p>{item.detail}</p>
              </div>
            </div>
          ))}
        </div>

        {activeStay && (
          <article className="stay-card">
            <div className="stay-topline">
              <span className="section-label">今晚入住</span>
              {activeStay.price ? <strong>¥ {formatMoney(activeStay.price)}</strong> : <strong className="pending">待补充</strong>}
            </div>
            <h3>{activeStay.hotel}</h3>
            <p className="address">{activeStay.address}</p>
            <p className="room-note">{activeStay.rooms}{activeStay.note ? ` · ${activeStay.note}` : ''}</p>
            <div className="stay-actions">
              <button type="button" onClick={() => document.querySelector('.map-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>查看站内地图</button>
              <button type="button" onClick={() => openMap(activeDay, 'amap', position)}>高德外部打开</button>
              <button type="button" onClick={() => navigator.clipboard?.writeText(activeStay.address)}>复制地址</button>
            </div>
          </article>
        )}

      </section>

      {expenseError && <p className="form-error" role="alert">账本暂不可用：{expenseError}</p>}
      {expensesLoaded && !offline && <Expenses user={user} expenses={expenses} members={members} refresh={refreshExpenses} />}

      <section className="planning-note">
        <div className="note-heading">
          <div>
            <p className="eyebrow">继续完善</p>
            <h2>把路上的小事记下来</h2>
          </div>
          <span className="note-count">{noteStatus}</span>
        </div>
        <textarea
          value={notes}
          onChange={(event) => saveNotes(event.target.value)}
          placeholder="例如：车辆、门票、充电、氧气、想吃的店……"
          aria-label="行程备注"
        />
      </section>

      <footer className="footer-note">
        {locationState === 'error' ? '定位失败，请检查浏览器权限；仍可查看预设路线。' : position ? '已获取当前位置，可在当日地图中切换为从当前位置出发。' : '地图展示预设路线；获取位置后可查看从当前位置出发的路线。'}
        <span className="legal-note">© 2026 杭州猫萌特科技有限公司 · TripWeave</span>
      </footer>
    </main>
  )
}

export default App
