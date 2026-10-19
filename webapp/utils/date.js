const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function pad(n) {
  return n < 10 ? '0' + n : String(n)
}

/** Date 对象 -> '2026-10-10' */
function dateKey(date) {
  const d = date || new Date()
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

/** 今天的日期 key */
function todayKey() {
  return dateKey(new Date())
}

/** '2026-10-10' -> Date 对象（本地时区零点） */
function parseKey(key) {
  const parts = String(key).split('-')
  return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]))
}

/** '10月10日' */
function labelOf(key) {
  const d = parseKey(key)
  return d.getMonth() + 1 + '月' + d.getDate() + '日'
}

/** '周六' */
function weekdayOf(key) {
  return WEEKDAYS[parseKey(key).getDay()]
}

/** '10月10日 周六' */
function fullLabelOf(key) {
  return labelOf(key) + ' ' + weekdayOf(key)
}

/** 在 key 的基础上偏移天数，返回新的 key */
function shiftKey(key, days) {
  const d = parseKey(key)
  d.setDate(d.getDate() + days)
  return dateKey(d)
}

/**
 * 「逻辑日期」：每天从 dayStartHour 点才开始算新的一天。
 * 默认 4 点，所以凌晨 2 点写的任务仍然算前一天，符合"睡前才算一天结束"的习惯。
 */
function logicalKey(dayStartHour) {
  const h = typeof dayStartHour === 'number' ? dayStartHour : 0
  const now = new Date()
  if (h > 0 && now.getHours() < h) {
    now.setDate(now.getDate() - 1)
  }
  return dateKey(now)
}

/** 现在是不是"过了零点但还没到结算时间"的深夜时段 */
function isLateNight(dayStartHour) {
  const h = typeof dayStartHour === 'number' ? dayStartHour : 0
  return h > 0 && new Date().getHours() < h
}

module.exports = {
  dateKey,
  todayKey,
  parseKey,
  labelOf,
  weekdayOf,
  fullLabelOf,
  shiftKey,
  logicalKey,
  isLateNight
}
