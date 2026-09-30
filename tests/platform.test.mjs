import assert from 'node:assert/strict'
import { test } from 'node:test'
import { calculate } from '../src/expenseSettlement.ts'
import { databaseUrlFromFields, membersChanged, modelsUrl, validAdminUsername, validAiUrl, validAmapCredential, validConfig, validExpense, webServiceEvidence } from '../server/trip-data.mjs'

const config = {
  title: '周末自驾', subtitle: '两天轻松出行',
  members: [{ id: 'a', name: '甲', shares: 1 }, { id: 'b', name: '乙', shares: 2 }],
  days: [{ date: '2026-06-13', weekday: '周六', place: '目的地', route: '起点 → 终点', title: '第一天', detail: '', timing: '', tags: [], items: [], legs: [{ label: '路段', origin: '起点', destination: '终点', originPoint: [120.1, 30.2], destinationPoint: [119.6, 29.8] }] }],
}

test('install and admin configuration validates members, days and map points', () => {
  assert.equal(validConfig(config), true)
  assert.equal(validConfig({ ...config, members: [config.members[0], config.members[0]] }), false)
  assert.equal(validConfig({ ...config, days: [{ ...config.days[0], legs: [{ ...config.days[0].legs[0], destinationPoint: [200, 29.9] }] }] }), false)
  assert.equal(validConfig({ ...config, days: [{ ...config.days[0], legs: [{ ...config.days[0].legs[0], destinationPoint: [0, 0] }] }] }), false)
})

test('installer accepts database fields and encodes a password safely', () => {
  const url = databaseUrlFromFields({ host: '127.0.0.1', port: 5432, name: 'tripweave', user: 'tripweave', password: 'a:b@c' })
  assert.equal(new URL(url).password, 'a%3Ab%40c')
  assert.equal(databaseUrlFromFields({ host: 'bad/host', port: 5432, name: 'tripweave', user: 'tripweave', password: 'pass' }), null)
  assert.equal(databaseUrlFromFields({ host: '127.0.0.1', port: 0, name: 'tripweave', user: 'tripweave', password: 'pass' }), null)
})

test('map credentials accept only complete AMap keys', () => {
  assert.equal(validAmapCredential('a'.repeat(32)), true)
  assert.equal(validAmapCredential('a'.repeat(31)), false)
  assert.equal(validAmapCredential('a'.repeat(31) + '!'), false)
})

test('Web Service driving data becomes bounded traffic evidence for AI', () => {
  const evidence = webServiceEvidence({ status: '1', route: { paths: [{ distance: '12000', duration: '1200', steps: [{ road: '示例道路', distance: '12000', tmcs: [{ status: '缓行', distance: '3000' }] }] }] } }, '路段', '2026-09-30T00:00:00.000Z')
  assert.equal(evidence.routes[0].covered, 3000)
  assert.deepEqual(evidence.routes[0].mainRoads, ['示例道路'])
  assert.equal(evidence.routes[0].traffic[0].status, '缓行')
  assert.throws(() => webServiceEvidence({ status: '0' }, '路段', '2026-09-30T00:00:00.000Z'))
})

test('admin names and AI endpoints are validated before persistence or model discovery', () => {
  assert.equal(validAdminUsername('admin_2026'), true)
  assert.equal(validAdminUsername('a b'), false)
  assert.equal(validAdminUsername('ab'), false)
  assert.equal(validAiUrl('https://api.example.com/v1/chat/completions'), true)
  assert.equal(modelsUrl('https://api.example.com/v1/chat/completions'), 'https://api.example.com/v1/models')
  assert.equal(validAiUrl('http://api.example.com/v1/chat/completions'), false)
  assert.equal(validAiUrl('https://user:pass@api.example.com/v1/chat/completions'), false)
  assert.equal(validAiUrl('https://api.example.com/v1/chat/completions?key=secret'), false)
})

test('member settings drive split validation and settlement', () => {
  const value = { title: '车票', amountCents: 10001, kind: 'shared', category: '其他', date: null, note: '', allocation: { b: 1 } }
  assert.equal(validExpense(value, config.members), true)
  assert.equal(validExpense({ ...value, allocation: { b: 3 } }, config.members), false)
  const result = calculate([{ ...value, id: '1', payer: 'a', seedKey: null }], config.members)
  assert.deepEqual(result.balance.map(({ due }) => due), [0, 10001])
  assert.deepEqual(result.transfers, [{ from: '乙', to: '甲', amount: 10001 }])
})

test('member changes require freezing prior all-member allocations', () => {
  assert.equal(membersChanged(config.members, config.members.map((member) => ({ ...member, name: `${member.name}新` }))), false)
  assert.equal(membersChanged(config.members, [{ ...config.members[0], shares: 2 }, config.members[1]]), true)
  assert.equal(membersChanged(config.members, [...config.members, { id: 'c', name: '丙', shares: 1 }]), true)
  const oldExpense = { id: 'old', payer: 'a', amountCents: 300, kind: 'shared', allocation: { a: 1, b: 2 } }
  const updated = [...config.members, { id: 'c', name: '丙', shares: 1 }]
  assert.deepEqual(calculate([oldExpense], updated).balance.map(({ due }) => due), [100, 200, 0])
})
