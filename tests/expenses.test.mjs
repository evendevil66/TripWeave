import assert from 'node:assert/strict'
import { test } from 'node:test'
import { allocationLabel, calculate } from '../src/expenseSettlement.ts'
import { validExpense } from '../server/trip-data.mjs'

const expense = (amountCents, allocation = null, kind = 'shared') => ({
  id: '1', date: null, title: '测试消费', amountCents, payer: 'lin',
  kind, category: '其他', note: '', seedKey: null, allocation,
})
const due = (expenses) => calculate(expenses).balance.map((person) => person.due)

test('old expenses keep the default 1:1:2 split and cent order', () => {
  assert.deepEqual(due([expense(101)]), [26, 25, 50])
  assert.deepEqual(due([expense(98765)]), [24692, 24691, 49382])
  assert.equal(allocationLabel(expense(101)), '全员分摊')
})

test('a ticket paid by one member can be owed only by another', () => {
  const result = calculate([expense(12345, { chen: 1 })])
  assert.deepEqual(result.balance.map(({ paid, due }) => ({ paid, due })), [
    { paid: 12345, due: 0 }, { paid: 0, due: 12345 }, { paid: 0, due: 0 },
  ])
  assert.deepEqual(result.transfers, [{ from: '小陈', to: '小林', amount: 12345 }])
})

test('selected members split by their selected shares, including one or two for zhou', () => {
  assert.deepEqual(due([expense(101, { lin: 1, chen: 1 })]), [51, 50, 0])
  assert.deepEqual(due([expense(101, { lin: 1, zhou: 1 })]), [51, 0, 50])
  assert.deepEqual(due([expense(101, { lin: 1, zhou: 2 })]), [34, 0, 67])
  assert.equal(allocationLabel(expense(101, { lin: 1, zhou: 2 })), '小林 1份、小周 2份')
})

test('personal expenses do not affect AA', () => {
  assert.deepEqual(due([expense(10000, { chen: 1 }, 'personal')]), [0, 0, 0])
  assert.equal(calculate([expense(10000, { chen: 1 }, 'personal')]).total, 0)
})

test('server accepts selected shares and rejects malformed allocations', () => {
  const value = { title: '车票', amountCents: 12345, kind: 'shared', category: '其他', date: null, note: '', allocation: { chen: 1 } }
  assert.equal(validExpense(value), true)
  assert.equal(validExpense({ ...value, allocation: { zhou: 1 } }), true)
  assert.equal(validExpense({ ...value, allocation: { zhou: 2 } }), true)
  for (const allocation of [{}, [], { chen: 2 }, { zhou: 3 }, { other: 1 }, { chen: 0 }]) {
    assert.equal(validExpense({ ...value, allocation }), false)
  }
})
