/**
 * 内置法定节假日表
 *
 * 数据来源：国务院办公厅《关于2026年部分节假日安排的通知》
 *           国办发明电〔2025〕7号，2025-11-04 发布
 *           已逐条核对放假日期的星期与原文一致
 * 覆盖范围：2026 全年
 *
 * 【怎么加下一年】
 *   每年 11 月国务院发布次年安排后，在 BUILT_IN 里追加一组，
 *   并同步更新 COVERAGE。表里没有的日期不会自动生效，
 *   用户可以手动标记兜底，所以漏更新不会出问题。
 */

const dateUtil = require('./date')

const BUILT_IN = [
  { name: '元旦', start: '2026-01-01', end: '2026-01-03' },
  { name: '春节', start: '2026-02-15', end: '2026-02-23' },
  { name: '清明节', start: '2026-04-04', end: '2026-04-06' },
  { name: '劳动节', start: '2026-05-01', end: '2026-05-05' },
  { name: '端午节', start: '2026-06-19', end: '2026-06-21' },
  { name: '中秋节', start: '2026-09-25', end: '2026-09-27' },
  { name: '国庆节', start: '2026-10-01', end: '2026-10-07' }
]

const COVERAGE = { from: '2026-01-01', to: '2026-12-31' }

/** 日期 -> 节日名 的查表，模块加载时展开一次 */
const dayMap = {}
BUILT_IN.forEach(function (h) {
  let cursor = h.start
  let guard = 0
  while (cursor <= h.end && guard < 400) {
    guard += 1
    dayMap[cursor] = h.name
    cursor = dateUtil.shiftKey(cursor, 1)
  }
})

/** 内置表里有没有这一天 */
function builtInName(key) {
  return dayMap[key] || ''
}

/** 手动标记的假期区间里有没有这一天 */
function customName(key, customList) {
  const list = customList || []
  for (let i = 0; i < list.length; i++) {
    const h = list[i]
    if (h && h.start && h.end && key >= h.start && key <= h.end) return h.name || '假期'
  }
  return ''
}

/**
 * 判断某天是不是假期。手动标记优先于内置表（用户说了算）。
 * 返回 null 表示是普通工作日。
 */
function find(key, customList) {
  const custom = customName(key, customList)
  if (custom) return { name: custom, builtIn: false }
  const built = builtInName(key)
  if (built) return { name: built, builtIn: true }
  return null
}

/**
 * 假期分：假期里完成一件 +1，全部完成再额外 +2。
 * 普通工作日不产生假期分。
 */
function pointsFor(total, done, isRest) {
  if (!isRest || !total) return 0
  return done + (done === total ? 2 : 0)
}

function list() {
  return BUILT_IN.slice()
}

function coverage() {
  return { from: COVERAGE.from, to: COVERAGE.to }
}

module.exports = {
  BUILT_IN,
  builtInName,
  find,
  pointsFor,
  list,
  coverage
}
