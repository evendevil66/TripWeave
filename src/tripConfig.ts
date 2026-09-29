export type Member = { id: string; name: string; shares: number }

export type Day = {
  date: string
  weekday: string
  place: string
  route: string
  legs: { label: string; origin: string; destination: string; originPoint: [number, number]; destinationPoint: [number, number] }[]
  title: string
  detail: string
  timing: string
  stay?: { hotel: string; address: string; rooms: string; price?: number; note?: string }
  tags: string[]
  items: { kind: '餐饮' | '景点' | '节奏' | '返程'; title: string; detail: string }[]
}

export type TripConfig = {
  title: string
  subtitle: string
  members: Member[]
  days: Day[]
}
