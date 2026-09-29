import { useEffect, useState } from 'react'
import { api } from './Expenses'
import type { TripConfig } from './tripConfig'

export default function Install({ template }: { template: TripConfig }) {
  const [status, setStatus] = useState<{ installed: boolean; ready: boolean } | null>(null)
  const [installToken, setInstallToken] = useState('')
  const [title, setTitle] = useState('')
  const [subtitle, setSubtitle] = useState('')
  const [code, setCode] = useState('')
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [useTemplate, setUseTemplate] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    void api<{ installed: boolean; ready: boolean }>('/api/install/status').then(setStatus).catch((cause) => setError((cause as Error).message))
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
      await api('/api/install', { method: 'POST', body: JSON.stringify({ installToken, adminUsername: username.trim(), adminPassword: password, accessCode: code, config }) })
      location.assign('/admin')
    } catch (cause) { setError((cause as Error).message); setBusy(false) }
  }

  if (status === null) return <main className="admin-shell"><p>{error || '正在检查安装状态…'}</p></main>
  if (status.installed) return <main className="admin-shell install-done"><h1>系统已安装</h1><p>初始化入口已关闭，后续设置请在管理后台修改。</p><a href="/admin">进入管理后台</a></main>

  return <main className="admin-shell install-shell">
    <header className="admin-header"><div><small>SETUP / 01</small><h1>安装出行系统</h1><p>连接好 PostgreSQL 后，在这里完成首次设置。</p></div></header>
    <form className="admin-form install-form" onSubmit={submit}>
      {!status.ready && <p className="form-error">服务器尚未配置 INSTALL_TOKEN，请先设置后重启服务。</p>}
      <div className="admin-form-grid">
        <label>安装令牌<input required type="password" value={installToken} onChange={(event) => setInstallToken(event.target.value)} autoComplete="off" placeholder="部署环境变量中的 INSTALL_TOKEN" /></label>
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
  </main>
}
