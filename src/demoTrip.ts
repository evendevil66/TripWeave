import type { TripConfig } from './tripConfig'

// Fictional sample data for first-time setup. Replace locations in the admin UI before traveling.
export const demoTrip: TripConfig = {
  title: '山野周末',
  subtitle: '一起出发，沿途看风景。演示行程，请按实际计划修改。',
  members: [
    { id: 'lin', name: '小林', shares: 1 },
    { id: 'chen', name: '小陈', shares: 1 },
    { id: 'zhou', name: '小周', shares: 2 },
  ],
  days: [
    {
      date: '6.13', weekday: '周六', place: '桐庐', route: '杭州 → 桐庐',
      legs: [{ label: '杭州 → 桐庐', origin: '杭州', destination: '桐庐', originPoint: [120.1551, 30.2741], destinationPoint: [119.6918, 29.7974] }],
      title: '沿江出发，住进山间',
      detail: '上午从杭州出发，途中留出午餐和休息时间；下午抵达桐庐，傍晚到江边散步。',
      timing: '示例安排：09:00 出发 · 12:00 午餐 · 下午入住',
      stay: { hotel: '山间小院（虚构示例）', address: '桐庐县城区（请替换实际地址）', rooms: '2 间房', price: 480 },
      tags: ['出发', '入住'],
      items: [
        { kind: '餐饮', title: '桐庐县城午餐', detail: '预留一小时用餐，具体时间按当天路况调整。' },
        { kind: '景点', title: '富春江边散步（可选）', detail: '根据天气和体力安排轻松步行。' },
      ],
    },
    {
      date: '6.14', weekday: '周日', place: '杭州', route: '桐庐 → 杭州',
      legs: [{ label: '桐庐 → 杭州', origin: '桐庐', destination: '杭州', originPoint: [119.6918, 29.7974], destinationPoint: [120.1551, 30.2741] }],
      title: '山间早餐，从容返程',
      detail: '早餐后收拾行李，留足途中休息时间。此模板不包含真实订房或车票信息。',
      timing: '示例安排：10:00 出发 · 途中午餐 · 下午返程',
      tags: ['返程'],
      items: [
        { kind: '餐饮', title: '途中服务区', detail: '按实时路况选择方便停车、用餐的区域。' },
        { kind: '返程', title: '出发前复核路况', detail: '如需换乘，按实际班次预留进站和拥堵时间。' },
      ],
    },
  ],
}
