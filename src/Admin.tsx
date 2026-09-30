import { useEffect, useState } from 'react'
import { api } from './Expenses'
import type { Day, TripConfig } from './tripConfig'
import PlacePicker from './PlacePicker'

type Section = 'overview' | 'members' | 'days' | 'audit' | 'map' | 'ai' | 'security'
type MapSettings = { key: string; securityConfigured: boolean; webServiceConfigured: boolean; refreshMinutes: number; autoEnabled: boolean }
type AiSettings = { url: string; model: string; keyConfigured: boolean; refreshMinutes: number; autoEnabled: boolean }

type AuditEntry = {
  id: string
  actor: string
  actorName: string
  action: string
  expenseId: string | null
  snapshot: { title?: string; amountCents?: number } | null
  createdAt: string
}

function newDay(): Day {
  const date = new Date().toISOString().slice(0, 10)
  return { date, weekday: '待设置', place: '待设置', route: '待设置', title: '新的一天', detail: '', timing: '', legs: [], tags: [], items: [] }
}

export default function Admin() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null)
  const [password, setPassword] = useState('')
  const [loginUsername, setLoginUsername] = useState('')
  const [adminUsername, setAdminUsername] = useState('')
  const [config, setConfig] = useState<TripConfig | null>(null)
  const [section, setSection] = useState<Section>('overview')
  const [dayIndex, setDayIndex] = useState(0)
  const [accessCode, setAccessCode] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [mapSettings, setMapSettings] = useState<MapSettings>({ key: '', securityConfigured: false, webServiceConfigured: false, refreshMinutes: 5, autoEnabled: true })
  const [mapKey, setMapKey] = useState('')
  const [mapSecurityCode, setMapSecurityCode] = useState('')
  const [webServiceKey, setWebServiceKey] = useState('')
  const [trafficRefreshMinutes, setTrafficRefreshMinutes] = useState(5)
  const [trafficAutoEnabled, setTrafficAutoEnabled] = useState(true)
  const [aiSettings, setAiSettings] = useState<AiSettings>({ url: '', model: '', keyConfigured: false, refreshMinutes: 10, autoEnabled: true })
  const [aiRefreshMinutes, setAiRefreshMinutes] = useState(10)
  const [aiAutoEnabled, setAiAutoEnabled] = useState(true)
  const [aiUrl, setAiUrl] = useState('')
  const [aiKey, setAiKey] = useState('')
  const [aiModel, setAiModel] = useState('')
  const [aiModels, setAiModels] = useState<string[]>([])
  const [modelsBusy, setModelsBusy] = useState(false)
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  async function loadSettings() {
    const [map, ai, account] = await Promise.all([
      api<MapSettings>('/api/admin/map-settings'),
      api<AiSettings>('/api/admin/ai-settings'),
      api<{ username: string }>('/api/admin/account'),
    ])
    setMapSettings(map); setTrafficRefreshMinutes(map.refreshMinutes); setTrafficAutoEnabled(map.autoEnabled)
    setAiSettings(ai); setAiUrl(ai.url); setAiModel(ai.model); setAiRefreshMinutes(ai.refreshMinutes); setAiAutoEnabled(ai.autoEnabled); setAdminUsername(account.username)
  }

  useEffect(() => {
    void api<{ installed: boolean }>('/api/install/status').then(async ({ installed }) => {
      if (!installed) { location.assign('/install'); return }
      const result = await api<{ authenticated: boolean }>('/api/admin/session')
      setAuthenticated(result.authenticated)
      if (result.authenticated) {
        setConfig((await api<{ config: TripConfig }>('/api/admin/config')).config)
        await loadSettings()
      }
    }).catch((cause) => { setError((cause as Error).message); setAuthenticated(false) })
  }, [])

  async function login(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      await api('/api/admin/session', { method: 'POST', body: JSON.stringify({ username: loginUsername, password }) })
      setConfig((await api<{ config: TripConfig }>('/api/admin/config')).config)
      await loadSettings()
      setAuthenticated(true); setPassword('')
    } catch (cause) { setError((cause as Error).message) }
    finally { setBusy(false) }
  }

  async function save() {
    if (!config) return
    if (config.days.some((item) => item.legs.some((leg) =>
      (leg.originPoint[0] === 0 && leg.originPoint[1] === 0) ||
      (leg.destinationPoint[0] === 0 && leg.destinationPoint[1] === 0)))) {
      setError('请先从高德搜索结果中选择每条路线的起点和终点。')
      return
    }
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await api<{ config: TripConfig }>('/api/admin/config', { method: 'PUT', body: JSON.stringify({ config, ...(accessCode ? { accessCode } : {}) }) })
      setConfig(result.config); setAccessCode(''); setMessage('设置已保存，手机端重新打开即可看到最新行程。')
    } catch (cause) { setError((cause as Error).message) }
    finally { setBusy(false) }
  }

  async function saveMapSettings() {
    setBusy(true); setError(''); setMessage('')
    try {
      const settings = await api<MapSettings>('/api/admin/map-settings', { method: 'PUT', body: JSON.stringify({ ...(mapKey ? { key: mapKey } : {}), ...(mapSecurityCode ? { securityCode: mapSecurityCode } : {}), ...(webServiceKey ? { webServiceKey } : {}), refreshMinutes: trafficRefreshMinutes, autoEnabled: trafficAutoEnabled }) })
      setMapSettings(settings); setMapKey(''); setMapSecurityCode(''); setWebServiceKey(''); setMessage('地图设置已保存。')
    } catch (cause) { setError((cause as Error).message) }
    finally { setBusy(false) }
  }

  async function saveAiSettings() {
    setBusy(true); setError(''); setMessage('')
    try {
      const settings = await api<AiSettings>('/api/admin/ai-settings', { method: 'PUT', body: JSON.stringify({ ...(aiUrl.trim() ? { url: aiUrl.trim() } : {}), ...(aiModel.trim() ? { model: aiModel.trim() } : {}), ...(aiKey ? { apiKey: aiKey.trim() } : {}), refreshMinutes: aiRefreshMinutes, autoEnabled: aiAutoEnabled }) })
      setAiSettings(settings); setAiKey(''); setMessage('AI 设置已保存，新分析会使用当前配置。')
    } catch (cause) { setError((cause as Error).message) }
    finally { setBusy(false) }
  }

  async function loadModels() {
    setModelsBusy(true); setError(''); setMessage('')
    try {
      const result = await api<{ models: string[] }>('/api/admin/ai-models', { method: 'POST', body: JSON.stringify({ url: aiUrl.trim(), ...(aiKey ? { apiKey: aiKey.trim() } : {}) }) })
      setAiModels(result.models); setMessage(`已获取 ${result.models.length} 个模型。`)
    } catch (cause) { setAiModels([]); setError((cause as Error).message) }
    finally { setModelsBusy(false) }
  }

  async function saveAccount() {
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await api<{ username: string }>('/api/admin/account', { method: 'PUT', body: JSON.stringify({ username: adminUsername.trim(), ...(newPassword ? { password: newPassword } : {}) }) })
      setAdminUsername(result.username); setNewPassword(''); setMessage('管理员账号已更新。')
    } catch (cause) { setError((cause as Error).message) }
    finally { setBusy(false) }
  }

  useEffect(() => {
    if (!authenticated || section !== 'audit') return
    void api<{ entries: AuditEntry[] }>('/api/admin/audit?limit=100').then((result) => setAudit(result.entries)).catch((cause) => setError((cause as Error).message))
  }, [authenticated, section])

  function updateDay(patch: Partial<Day>) {
    setConfig((current) => current && ({ ...current, days: current.days.map((day, index) => index === dayIndex ? { ...day, ...patch } : day) }))
  }

  function updateLeg(index: number, patch: Partial<Day['legs'][number]>) {
    if (!day) return
    updateDay({ legs: day.legs.map((leg, legIndex) => legIndex === index ? { ...leg, ...patch } : leg) })
  }

  async function logout() {
    await api('/api/admin/session', { method: 'DELETE' })
    setAuthenticated(false); setConfig(null)
  }

  const day = config?.days[dayIndex]
  if (authenticated === null) return <main className="admin-shell"><p>{error || '正在载入管理后台…'}</p></main>
  if (!authenticated) return <main className="admin-shell admin-login"><header className="admin-header"><div><small>MANAGEMENT</small><h1>管理后台</h1><p>编辑行程、成员和访问设置。</p></div></header><form className="admin-form" onSubmit={login}><label>管理员用户名<input autoFocus required value={loginUsername} onChange={(event) => setLoginUsername(event.target.value)} autoComplete="username" /></label><label>管理员密码<input required type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /></label>{error && <p className="form-error">{error}</p>}<button className="admin-primary" disabled={busy}>{busy ? '验证中…' : '登录'}</button></form><a className="admin-back" href="/">返回行程</a><p className="legal-note">© 2026 杭州猫萌特科技有限公司 · TripWeave</p></main>
  if (!config) return <main className="admin-shell"><p>{error || '正在读取配置…'}</p></main>

  return <main className="admin-shell">
    <header className="admin-header"><div><small>TRIP CONTROL</small><h1>管理后台</h1><p>{config.title}</p></div><div className="admin-header-actions"><a href="/">查看行程</a><button type="button" onClick={() => void logout()}>退出</button></div></header>
    <nav className="admin-tabs" aria-label="管理项目">
      {([['overview', '行程信息'], ['days', '每日安排'], ['members', '出行成员'], ['audit', '操作记录'], ['map', '地图设置'], ['ai', 'AI 设置'], ['security', '访问与账号']] as [Section, string][]).map(([id, label]) => <button type="button" key={id} aria-current={section === id ? 'page' : undefined} onClick={() => { setSection(id); setMessage(''); setError('') }}>{label}</button>)}
    </nav>
    {section === 'overview' && <section className="admin-panel"><h2>行程信息</h2><div className="admin-form-grid"><label>行程名称<input value={config.title} maxLength={120} onChange={(event) => setConfig({ ...config, title: event.target.value })} /></label><label>简介<input value={config.subtitle} maxLength={300} onChange={(event) => setConfig({ ...config, subtitle: event.target.value })} /></label></div><div className="admin-metrics"><span>{config.days.length} 天</span><span>{config.members.length} 位成员</span><span>{config.members.reduce((sum, member) => sum + member.shares, 0)} 份分摊</span></div></section>}
    {section === 'members' && <section className="admin-panel"><div className="admin-section-heading"><div><h2>出行成员</h2><p>成员 ID 会关联已有账目，名称和默认份数可以调整。</p></div><button type="button" onClick={() => setConfig({ ...config, members: [...config.members, { id: `member-${crypto.randomUUID().slice(0, 8)}`, name: '新成员', shares: 1 }] })}>添加成员</button></div><div className="admin-member-list">{config.members.map((member, index) => <div className="admin-member-row" key={member.id}><span>{String(index + 1).padStart(2, '0')}</span><label>姓名<input maxLength={40} value={member.name} onChange={(event) => setConfig({ ...config, members: config.members.map((item) => item.id === member.id ? { ...item, name: event.target.value } : item) })} /></label><label>默认份数<input type="number" min="1" max="12" value={member.shares} onChange={(event) => setConfig({ ...config, members: config.members.map((item) => item.id === member.id ? { ...item, shares: Number(event.target.value) } : item) })} /></label><button type="button" disabled={config.members.length === 1} onClick={() => setConfig({ ...config, members: config.members.filter((item) => item.id !== member.id) })}>移除</button></div>)}</div><p className="admin-hint">已有消费记录引用的成员无法移除；系统会在保存时检查。</p></section>}
    {section === 'days' && day && <section className="admin-panel"><div className="admin-section-heading"><div><h2>每日安排</h2><p>修改路线坐标后，手机端地图会按新起终点重新规划。</p></div><button type="button" onClick={() => { setConfig({ ...config, days: [...config.days, newDay()] }); setDayIndex(config.days.length) }}>添加一天</button></div><div className="admin-day-list">{config.days.map((item, index) => <button type="button" className={index === dayIndex ? 'active' : ''} key={index} onClick={() => setDayIndex(index)}>{item.date}<small>{item.place}</small></button>)}</div><div className="admin-day-title"><strong>DAY {dayIndex + 1}</strong><button type="button" disabled={config.days.length === 1} onClick={() => { if (!confirm(`删除 ${day.date} 的安排？`)) return; setConfig({ ...config, days: config.days.filter((_, index) => index !== dayIndex) }); setDayIndex(Math.max(0, dayIndex - 1)) }}>删除这一天</button></div><div className="admin-form-grid"><label>日期<input value={day.date} onChange={(event) => updateDay({ date: event.target.value })} placeholder="2026-10-01" /></label><label>星期<input value={day.weekday} onChange={(event) => updateDay({ weekday: event.target.value })} /></label><label>目的地<input value={day.place} onChange={(event) => updateDay({ place: event.target.value })} /></label><label>路线概览<input value={day.route} onChange={(event) => updateDay({ route: event.target.value })} /></label><label className="admin-span">当日标题<input value={day.title} onChange={(event) => updateDay({ title: event.target.value })} /></label><label className="admin-span">行程说明<textarea value={day.detail} onChange={(event) => updateDay({ detail: event.target.value })} /></label><label className="admin-span">时间安排<input value={day.timing} onChange={(event) => updateDay({ timing: event.target.value })} /></label><label className="admin-span">标签（逗号分隔）<input value={day.tags.join('，')} onChange={(event) => updateDay({ tags: event.target.value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean) })} /></label></div>
      <div className="admin-subsection">
        <div className="admin-section-heading"><h3>驾车路线</h3><button type="button" onClick={() => updateDay({ legs: [...day.legs, { label: '新路线', origin: '', destination: '', originPoint: [0, 0], destinationPoint: [0, 0] }] })}>添加路段</button></div>
        {day.legs.map((leg, index) => <div className="admin-line-item" key={index}>
          <div className="admin-section-heading"><strong>路段 {index + 1}</strong><button type="button" onClick={() => updateDay({ legs: day.legs.filter((_, legIndex) => legIndex !== index) })}>移除</button></div>
          <div className="admin-form-grid">
            <label className="admin-span">标题<input value={leg.label} onChange={(event) => updateLeg(index, { label: event.target.value })} /></label>
            <PlacePicker label="起点" name={leg.origin} point={leg.originPoint} onChange={(origin, originPoint) => updateLeg(index, { origin, originPoint })} />
            <PlacePicker label="终点" name={leg.destination} point={leg.destinationPoint} onChange={(destination, destinationPoint) => updateLeg(index, { destination, destinationPoint })} />
          </div>
        </div>)}
      </div>
      <div className="admin-subsection"><div className="admin-section-heading"><h3>途中安排</h3><button type="button" onClick={() => updateDay({ items: [...day.items, { kind: '景点', title: '新安排', detail: '' }] })}>添加安排</button></div>{day.items.map((item, index) => <div className="admin-line-item" key={index}><div className="admin-form-grid"><label>类别<select value={item.kind} onChange={(event) => updateDay({ items: day.items.map((entry, itemIndex) => itemIndex === index ? { ...entry, kind: event.target.value as typeof item.kind } : entry) })}>{['餐饮', '景点', '节奏', '返程'].map((kind) => <option key={kind}>{kind}</option>)}</select></label><label>标题<input value={item.title} onChange={(event) => updateDay({ items: day.items.map((entry, itemIndex) => itemIndex === index ? { ...entry, title: event.target.value } : entry) })} /></label><label className="admin-span">说明<textarea value={item.detail} onChange={(event) => updateDay({ items: day.items.map((entry, itemIndex) => itemIndex === index ? { ...entry, detail: event.target.value } : entry) })} /></label></div><button type="button" className="admin-remove" onClick={() => updateDay({ items: day.items.filter((_, itemIndex) => itemIndex !== index) })}>移除安排</button></div>)}</div>
      <div className="admin-subsection"><div className="admin-section-heading"><h3>今晚住宿</h3><label className="admin-check"><input type="checkbox" checked={!!day.stay} onChange={(event) => updateDay({ stay: event.target.checked ? { hotel: '', address: '', rooms: '' } : undefined })} />安排住宿</label></div>{day.stay && <div className="admin-form-grid"><label>酒店<input value={day.stay.hotel} onChange={(event) => updateDay({ stay: { ...day.stay!, hotel: event.target.value } })} /></label><label>房间<input value={day.stay.rooms} onChange={(event) => updateDay({ stay: { ...day.stay!, rooms: event.target.value } })} /></label><label className="admin-span">地址<input value={day.stay.address} onChange={(event) => updateDay({ stay: { ...day.stay!, address: event.target.value } })} /></label><label>费用（元）<input type="number" min="0" step="0.01" value={day.stay.price ?? ''} onChange={(event) => updateDay({ stay: { ...day.stay!, price: event.target.value ? Number(event.target.value) : undefined } })} /></label><label>备注<input value={day.stay.note ?? ''} onChange={(event) => updateDay({ stay: { ...day.stay!, note: event.target.value } })} /></label></div>}</div>
    </section>}
    {section === 'map' && <section className="admin-panel"><h2>地图设置</h2><p className="admin-hint">Web JS API 用于页面绘制官方路线；Web 服务 Key 用于服务器定时获取路况。密钥留空表示不修改。</p><div className="admin-form-grid"><label>新 JS API Key<input value={mapKey} onChange={(event) => setMapKey(event.target.value.trim())} autoComplete="off" placeholder={mapSettings.key || '32 位 Key'} maxLength={32} /></label><label>新安全密钥<input type="password" value={mapSecurityCode} onChange={(event) => setMapSecurityCode(event.target.value.trim())} autoComplete="new-password" placeholder={mapSettings.securityConfigured ? '已配置，留空保持不变' : '32 位安全密钥'} maxLength={32} /></label><label>Web 服务 Key<input type="password" value={webServiceKey} onChange={(event) => setWebServiceKey(event.target.value.trim())} autoComplete="new-password" placeholder={mapSettings.webServiceConfigured ? '已配置，留空保持不变' : '32 位 Web 服务 Key'} maxLength={32} /></label><label>路况更新间隔（分钟）<input type="number" min="1" max="1440" value={trafficRefreshMinutes} onChange={(event) => setTrafficRefreshMinutes(Number(event.target.value))} /></label></div><label className="admin-check"><input type="checkbox" checked={trafficAutoEnabled} onChange={(event) => setTrafficAutoEnabled(event.target.checked)} />后台自动更新路况</label><p className="admin-hint admin-map-status">Web 服务 Key：{mapSettings.webServiceConfigured ? '已配置' : '未配置'}。关闭自动更新后，打开路线页仍会获取最新数据。</p></section>}
    {section === 'ai' && <section className="admin-panel"><h2>AI 设置</h2><p className="admin-hint">路况建议仅使用高德返回的路线数据。API Key 保存在服务端，留空表示保持当前密钥。</p><div className="admin-form-grid"><label className="admin-span">聊天补全接口地址<input type="url" value={aiUrl} onChange={(event) => { setAiUrl(event.target.value); setAiModels([]) }} placeholder="https://example.com/v1/chat/completions" /></label><label>API Key<input type="password" value={aiKey} onChange={(event) => setAiKey(event.target.value)} autoComplete="new-password" placeholder={aiSettings.keyConfigured ? '已配置，留空保持不变' : '填写 API Key'} /></label><label>模型<input list="ai-models" value={aiModel} onChange={(event) => setAiModel(event.target.value)} placeholder="选择或手动填写模型" /><datalist id="ai-models">{aiModels.map((model) => <option key={model} value={model} />)}</datalist></label><label>AI 更新间隔（分钟）<input type="number" min="1" max="1440" value={aiRefreshMinutes} onChange={(event) => setAiRefreshMinutes(Number(event.target.value))} /></label></div><label className="admin-check"><input type="checkbox" checked={aiAutoEnabled} onChange={(event) => setAiAutoEnabled(event.target.checked)} />后台自动分析路况</label><div className="admin-section-heading"><p className="admin-hint">当前密钥：{aiSettings.keyConfigured ? '已配置' : '未配置'}。关闭自动分析后，打开路线页仍会分析最新数据。</p><button type="button" disabled={modelsBusy || busy} onClick={() => void loadModels()}>{modelsBusy ? '获取中…' : '获取模型列表'}</button></div></section>}
    {section === 'security' && <section className="admin-panel"><h2>访问与账号</h2><p className="admin-hint">访问码用于旅伴入口，管理员账号用于后台登录。</p><div className="admin-form-grid"><label>新访问码<input value={accessCode} onChange={(event) => setAccessCode(event.target.value)} autoComplete="off" placeholder="留空则保持不变" /></label></div><div className="admin-subsection"><h3>管理员账号</h3><div className="admin-form-grid"><label>用户名<input required minLength={3} maxLength={32} value={adminUsername} onChange={(event) => setAdminUsername(event.target.value)} autoComplete="username" /></label><label>新密码<input type="password" minLength={8} maxLength={128} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" placeholder="至少 8 位，留空不修改" /></label></div><p className="admin-hint">用户名使用 3–32 位字母、数字或下划线。修改账号后所有其他会话需要重新登录。</p><button type="button" disabled={busy} onClick={() => void saveAccount()}>更新管理员账号</button></div></section>}
    {section === 'audit' && <section className="admin-panel"><div className="admin-section-heading"><div><h2>操作记录</h2><p>记录旅伴对共同账本的新增、修改和删除操作，最近记录在前。</p></div><button type="button" onClick={() => void api<{ entries: AuditEntry[] }>('/api/admin/audit?limit=100').then((result) => setAudit(result.entries))}>刷新</button></div><div className="admin-audit-list">{audit.length === 0 ? <p className="admin-hint">暂时没有消费操作记录。</p> : audit.map((entry) => <article className="admin-audit-row" key={entry.id}><div><strong>{entry.actorName}</strong><span>{entry.action === 'create' ? '新增' : entry.action === 'update' ? '修改' : '删除'}消费{entry.snapshot?.title ? ` · ${entry.snapshot.title}` : ''}</span></div><time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString('zh-CN', { hour12: false })}</time></article>)}</div></section>}
    <div className="admin-savebar">{error && <p className="form-error" role="alert">{error}</p>}{message && <p className="admin-success" role="status">{message}</p>}{section !== 'audit' && <button className="admin-primary" type="button" disabled={busy || (section === 'security' && !accessCode)} onClick={() => void (section === 'map' ? saveMapSettings() : section === 'ai' ? saveAiSettings() : save())}>{busy ? '保存中…' : section === 'security' ? '保存访问码' : '保存更改'}</button>}</div>
    <p className="legal-note">© 2026 杭州猫萌特科技有限公司 · TripWeave</p>
  </main>
}
