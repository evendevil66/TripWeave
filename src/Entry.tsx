import { useState } from 'react'
import { api, type UserId } from './Expenses'
import type { Member } from './tripConfig'

export default function Entry({ unlocked, members, onUnlock, onSelect }: { unlocked: boolean; members: Member[]; onUnlock: () => Promise<void>; onSelect: (user: UserId) => void }) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function unlock(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try { await api('/api/trip/session', { method: 'POST', body: JSON.stringify({ code }) }); await onUnlock() }
    catch (cause) { setError((cause as Error).message) }
    finally { setBusy(false) }
  }

  async function choose(user: UserId) {
    setBusy(true)
    setError('')
    try { await api('/api/trip/user', { method: 'PUT', body: JSON.stringify({ user }) }); onSelect(user) }
    catch (cause) { setError((cause as Error).message) }
    finally { setBusy(false) }
  }

  return <main className="entry-shell">
    <div className="brand-lockup"><span className="brand-mark">出行计划</span><span className="brand-caption">TRIP</span></div>
    <div className="entry-body"><p className="eyebrow">TRIP JOURNAL</p>
      {unlocked ? <><h1>今天由谁<br /><em>来记账？</em></h1><p className="entry-intro">选择当前使用者，随时可以切换。</p>
        <div className="people-choice">{members.map((person) => <button type="button" key={person.id} disabled={busy} onClick={() => choose(person.id)}><strong>{person.name}</strong><span>{person.shares} 份</span><b>→</b></button>)}</div>
      </> : <><h1>出行计划<br /><em>从这里开始</em></h1><p className="entry-intro">输入本次出行的目的地作为访问码，查看行程与共同账本。</p>
        <form className="entry-form" onSubmit={unlock}><label htmlFor="trip-code">访问码</label><input id="trip-code" type="text" value={code} onChange={(event) => setCode(event.target.value)} autoComplete="off" autoFocus required placeholder="请输入本次出行的目的地" /><button type="submit" disabled={busy}>{busy ? '验证中…' : '进入行程'}</button></form>
      </>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div><p className="entry-footer">© 2026 杭州猫萌特科技有限公司 · TripWeave</p>
  </main>
}
