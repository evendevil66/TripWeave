import type { Member } from './tripConfig'

export type UserId = string
export type Allocation = Partial<Record<UserId, number>> | null
export type Expense = {
  id: string
  date: string | null
  title: string
  amountCents: number
  payer: UserId
  kind: 'shared' | 'personal'
  category: string
  note: string
  seedKey: string | null
  allocation?: Allocation
}

export const people: Member[] = [
  { id: 'lin', name: '小林', shares: 1 },
  { id: 'chen', name: '小陈', shares: 1 },
  { id: 'zhou', name: '小周', shares: 2 },
]

export function allocationLabel(expense: Expense, members: Member[] = people) {
  if (expense.kind === 'personal') return '个人'
  if (!expense.allocation) return '全员分摊'
  return members.filter((person) => expense.allocation?.[person.id])
    .map((person) => `${person.name} ${expense.allocation?.[person.id]}份`).join('、') || '全员分摊'
}

export function calculate(expenses: Expense[], members: Member[] = people) {
  const shared = expenses.filter((expense) => expense.kind === 'shared')
  const total = shared.reduce((sum, expense) => sum + expense.amountCents, 0)
  const paid = members.map((person) => shared.filter((expense) => expense.payer === person.id).reduce((sum, expense) => sum + expense.amountCents, 0))
  const due = members.map(() => 0)
  for (const expense of shared) {
    const weights = members.map((person) => expense.allocation?.[person.id] ?? 0)
    if (!weights.some((weight) => weight > 0)) members.forEach((person, index) => { weights[index] = person.shares })
    const totalShares = weights.reduce((sum, weight) => sum + weight, 0)
    const base = Math.floor(expense.amountCents / totalShares)
    let remainder = expense.amountCents % totalShares
    // Each selected share gets the same base; extra cents follow the existing member order.
    weights.forEach((weight, index) => {
      const extra = Math.min(remainder, weight)
      due[index] += base * weight + extra
      remainder -= extra
    })
  }
  const balance = members.map((person, index) => ({ ...person, paid: paid[index], due: due[index], balance: paid[index] - due[index] }))
  const debtors = balance.filter((person) => person.balance < 0).map((person) => ({ ...person, remaining: -person.balance }))
  const creditors = balance.filter((person) => person.balance > 0).map((person) => ({ ...person, remaining: person.balance }))
  const transfers: { from: string; to: string; amount: number }[] = []
  for (const debtor of debtors) for (const creditor of creditors) {
    const amount = Math.min(debtor.remaining, creditor.remaining)
    if (amount) transfers.push({ from: debtor.name, to: creditor.name, amount })
    debtor.remaining -= amount
    creditor.remaining -= amount
  }
  return { total, balance, transfers }
}
