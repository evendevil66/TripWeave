import { useState } from 'react'
import { allocationLabel, calculate, people, type Expense, type UserId } from './expenseSettlement'
import type { Member } from './tripConfig'
export { calculate, people, type Expense, type UserId } from './expenseSettlement'

export function money(cents: number) {
  return (cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options?.headers } })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error ?? '请求失败')
  return data as T
}

const categories = ['出发前准备', '住宿', '餐饮', '加油', '门票', '停车', '其他']

export default function Expenses({ user, expenses, members, refresh }: { user: UserId; expenses: Expense[]; members: Member[]; refresh: () => Promise<void> }) {
  const [title, setTitle] = useState('')
  const [amount, setAmount] = useState('')
  const [kind, setKind] = useState<'shared' | 'personal'>('shared')
  const [allocationMode, setAllocationMode] = useState<'all' | 'custom'>('all')
  const [allocation, setAllocation] = useState<Partial<Record<UserId, number>>>({})
  const [category, setCategory] = useState('餐饮')
  const [date, setDate] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<'all' | 'mine'>('all')
  const [editingId, setEditingId] = useState<string | null>(null)
  const settlement = calculate(expenses, members)
  const visible = filter === 'mine' ? expenses.filter((expense) => expense.payer === user) : expenses

  function selectMember(id: UserId, checked: boolean) {
    setAllocation((current) => {
      const next = { ...current }
      if (checked) next[id] = current[id] || members.find((person) => person.id === id)!.shares
      else delete next[id]
      return next
    })
    setError('')
  }

  async function add(event: React.FormEvent) {
    event.preventDefault()
    const validMoney = /^\d+(\.\d{1,2})?$/.test(amount.trim())
    const cents = validMoney ? Math.round(Number(amount) * 100) : 0
    if (!title.trim() || cents < 1) { setError('请填写项目和有效金额'); return }
    if (kind === 'shared' && allocationMode === 'custom' && !Object.values(allocation).some((value) => (value ?? 0) > 0)) { setError('请至少选择一位分摊人'); return }
    setBusy(true)
    setError('')
    try {
      await api(editingId ? `/api/trip/expenses/${editingId}` : '/api/trip/expenses', { method: editingId ? 'PUT' : 'POST', body: JSON.stringify({ title, amountCents: cents, kind, category, date: date || null, note, allocation: kind === 'shared' && allocationMode === 'custom' ? allocation : null }) })
      setTitle(''); setAmount(''); setNote(''); setAllocationMode('all'); setAllocation({}); setEditingId(null)
      await refresh()
    } catch (cause) { setError((cause as Error).message) }
    finally { setBusy(false) }
  }

  async function remove(expense: Expense) {
    if (!window.confirm(`删除“${expense.title}” ¥${money(expense.amountCents)}？`)) return
    setBusy(true)
    setError('')
    try { await api(`/api/trip/expenses/${expense.id}`, { method: 'DELETE' }); await refresh() }
    catch (cause) { setError((cause as Error).message) }
    finally { setBusy(false) }
  }

  function edit(expense: Expense) {
    setEditingId(expense.id); setTitle(expense.title); setAmount(money(expense.amountCents)); setKind(expense.kind)
    setCategory(expense.category); setDate(expense.date || ''); setNote(expense.note)
    setAllocationMode(expense.allocation ? 'custom' : 'all'); setAllocation(expense.allocation || {})
    document.querySelector('.expense-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return <section className="expenses-section" id="expenses">
    <div className="expenses-heading"><div><p className="eyebrow">{members.length} 人 · {members.reduce((sum, member) => sum + member.shares, 0)} 份</p><h2>共同账本</h2></div><strong>¥ {money(settlement.total)}</strong></div>
    <div className="settlement-grid">
      {settlement.balance.map((person) => <div className="settlement-person" key={person.id}>
        <strong>{person.name}<small> {person.shares} 份</small></strong>
        <span>已付 ¥ {money(person.paid)}</span><span>应付 ¥ {money(person.due)}</span>
        <b className={person.balance >= 0 ? 'positive' : 'negative'}>{person.balance >= 0 ? '应收' : '应付'} ¥ {money(Math.abs(person.balance))}</b>
      </div>)}
    </div>
    {settlement.transfers.length > 0 && <div className="transfers"><span className="section-label">当前结算建议</span>{settlement.transfers.map((transfer) => <p key={`${transfer.from}-${transfer.to}`}>{transfer.from} → {transfer.to}<strong>¥ {money(transfer.amount)}</strong></p>)}</div>}
    <form className="expense-form" onSubmit={add}>
      <div className="expense-form-heading"><h3>{editingId ? '修改消费' : '记一笔消费'}</h3><span>{members.find((person) => person.id === user)?.name}付款</span></div>
      <div className="expense-type" role="group" aria-label="开支类型">
        <button type="button" className={kind === 'shared' ? 'active' : ''} onClick={() => { setKind('shared'); setError('') }}>共同开支</button>
        <button type="button" className={kind === 'personal' ? 'active' : ''} onClick={() => setKind('personal')}>个人开支</button>
      </div>
      {kind === 'shared' && <div className="expense-split">
        <span className="expense-split-label">分摊方式</span>
        <div className="expense-split-type" role="group" aria-label="分摊方式">
          <button type="button" aria-pressed={allocationMode === 'all'} className={allocationMode === 'all' ? 'active' : ''} onClick={() => { setAllocationMode('all'); setError('') }}>全员分摊</button>
          <button type="button" aria-pressed={allocationMode === 'custom'} className={allocationMode === 'custom' ? 'active' : ''} onClick={() => { setAllocationMode('custom'); setError('') }}>指定成员</button>
        </div>
        {allocationMode === 'custom' && <div className="allocation-options">
          {members.map((person) => <div className="allocation-person" key={person.id}>
            <label><input type="checkbox" checked={Boolean(allocation[person.id])} onChange={(event) => selectMember(person.id, event.target.checked)} /><span>{person.name}</span>{person.shares === 1 && <small>1份</small>}</label>
            {person.shares > 1 && <select aria-label={`${person.name}分摊份数`} value={allocation[person.id] || person.shares} disabled={!allocation[person.id]} onChange={(event) => setAllocation((current) => ({ ...current, [person.id]: Number(event.target.value) }))}>{Array.from({ length: person.shares }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}份</option>)}</select>}
          </div>)}
        </div>}
      </div>}
      <div className="expense-fields">
        <label>项目<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：出发前采购" maxLength={100} required /></label>
        <label>金额（元）<input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" placeholder="0.00" required /></label>
        <label>类别<select value={category} onChange={(event) => { setCategory(event.target.value); if (event.target.value === '出发前准备') setDate('') }}>{categories.map((item) => <option key={item}>{item}</option>)}</select></label>
        <label>日期<input value={date} onChange={(event) => setDate(event.target.value)} type="date" disabled={category === '出发前准备'} /></label>
      </div>
      <label className="expense-note-label">备注（可选）<input value={note} onChange={(event) => setNote(event.target.value)} placeholder="购物清单、付款说明等" maxLength={500} /></label>
      <button className="expense-submit" type="submit" disabled={busy}>{busy ? '保存中…' : editingId ? '保存修改' : '保存消费'}</button>
      {editingId && <button type="button" className="expense-cancel" onClick={() => { setEditingId(null); setTitle(''); setAmount(''); setNote(''); setAllocationMode('all'); setAllocation({}) }}>取消修改</button>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </form>
    <div className="expense-list-heading"><h3>消费明细</h3><div className="expense-filter"><button type="button" className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>全部</button><button type="button" className={filter === 'mine' ? 'active' : ''} onClick={() => setFilter('mine')}>我付的</button></div><a className="expense-export" href="/api/trip/expenses/export.csv" download>导出 CSV</a></div>
    {visible.length === 0 ? <p className="expense-empty">还没有消费记录</p> : <div className="expense-list">{visible.map((expense) => <div className="expense-row" key={expense.id}>
      <div><strong>{expense.title}</strong><span>{expense.category} · {expense.date ? expense.date.slice(5).replace('-', '.') : '出发前'} · {members.find((person) => person.id === expense.payer)?.name ?? expense.payer}付 · {allocationLabel(expense, members)}</span>{expense.note && <small>{expense.note}</small>}</div>
      <div className="expense-row-end"><b>¥ {money(expense.amountCents)}</b>{expense.payer === user && <><button type="button" onClick={() => edit(expense)} disabled={busy} aria-label={`修改${expense.title}`}>修改</button><button type="button" onClick={() => remove(expense)} disabled={busy} aria-label={`删除${expense.title}`}>删除</button></>}</div>
    </div>)}</div>}
  </section>
}
