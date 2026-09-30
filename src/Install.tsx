import { useEffect, useState } from 'react'
import { api } from './Expenses'
import type { TripConfig } from './tripConfig'

export default function Install({ template }: { template: TripConfig }) {
  const [status, setStatus] = useState<{ installed: boolean } | null>(null)
  const [dbHost, setDbHost] = useState('127.0.0.1')
  const [dbPort, setDbPort] = useState('5432')
  const [dbName, setDbName] = useState('tripweave')
  const [dbUser, setDbUser] = useState('tripweave')
  const [dbPassword, setDbPassword] = useState('')
  const [title, setTitle] = useState('')
  const [subtitle, setSubtitle] = useState('')
  const [code, setCode] = useState('')
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [useTemplate, setUseTemplate] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    void api<{ installed: boolean }>('/api/install/status').then(setStatus).catch((cause) => setError((cause as Error).message))
  }, [])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true); setError('')
    const date = new Date()
    const firstDay = {
      date: date.toISOString().slice(0, 10), weekday: '待设置', place: '待设置', route: '待设置', title: '第一天',
      detail: '', timing: '', legs: [], tags: [], items: [],
    }
    const config: TripConfig = useTemplate
      ? { ...template, title: title.trim(), subtitle: subtitle.trim() }
      : { title: title.trim(), subtitle: subtitle.trim(), members: [{ id: 'organizer', name: '发起人', shares: 1 }], days: [firstDay] }
    try {
      await api('/api/install', { method: 'POST', body: JSON.stringify({ database: { host: dbHost.trim(), port: Number(dbPort), name: dbName.trim(), user: dbUser.trim(), password: dbPassword }, adminUsername: username.trim(), adminPassword: password, accessCode: code, config }) })
      location.assign('/admin')
    } catch (cause) { setError((cause as Error).message); setBusy(false) }
  }

  if (status === null) return <main className="admin-shell"><p>{error || '正在检查安装状态…'}</p></main>
  if (status.installed) return <main className="admin-shell install-done"><h1>系统已安装</h1><p>初始化入口已关闭，后续设置请在管理后台修改。</p><a href="/admin">进入管理后台</a></main>

  return <main className="admin-shell install-shell">
    <header className="admin-header"><div><small>SETUP / 01</small><h1>安装出行系统</h1><p>填写 PostgreSQL 连接信息和行程设置，完成首次安装。</p></div></header>
    <form className="admin-form install-form" onSubmit={submit}>
      <div className="admin-form-grid">
        <p className="admin-span admin-hint">数据库连接</p>
        <label>数据库地址<input required value={dbHost} onChange={(event) => setDbHost(event.target.value)} autoComplete="off" /></label>
        <label>端口<input required type="number" min="1" max="65535" value={dbPort} onChange={(event) => setDbPort(event.target.value)} /></label>
        <label>数据库名<input required value={dbName} onChange={(event) => setDbName(event.target.value)} autoComplete="off" /></label>
        <label>数据库用户<input required value={dbUser} onChange={(event) => setDbUser(event.target.value)} autoComplete="off" /></label>
        <label className="admin-span">数据库密码<input required type="password" value={dbPassword} onChange={(event) => setDbPassword(event.target.value)} autoComplete="new-password" /></label>
        <p className="admin-span admin-hint">行程与管理员</p>
        <label>行程名称<input required maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：山野周末" /></label>
        <label>访问码<input required minLength={2} maxLength={100} value={code} onChange={(event) => setCode(event.target.value)} placeholder="旅伴进入时使用" /></label>
        <label>管理员用户名<input required minLength={3} maxLength={32} pattern="[A-Za-z0-9_]+" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" /></label>
        <label className="admin-span">行程简介<input required maxLength={300} value={subtitle} onChange={(event) => setSubtitle(event.target.value)} placeholder="写一句简短介绍" /></label>
        <label className="admin-span">管理员密码<input required type="password" minLength={8} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" placeholder="至少 8 位，用于管理后台" /></label>
      </div>
      <label className="install-template"><input type="checkbox" checked={useTemplate} onChange={(event) => setUseTemplate(event.target.checked)} />使用虚构的两日行程示例作为模板</label>
      <p className="admin-hint">不选模板时会创建一天空白行程，可在后台继续添加日期、成员和路线。</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="admin-primary" disabled={busy} type="submit">{busy ? '正在安装…' : '完成安装'}</button>
    </form>
    <p className="legal-note">© 2026 杭州猫萌特科技有限公司 · TripWeave</p>
  </main>
}
