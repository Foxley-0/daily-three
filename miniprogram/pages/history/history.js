const store = require('../../utils/store')
const dateUtil = require('../../utils/date')

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

function pad(n) {
  return n < 10 ? '0' + n : String(n)
}

/** 一天的格子类型：补签 > 假期 > 全勤 > 缺勤 > 部分 */
function cellKind(rec) {
  if (!rec) return 'none'
  if (rec.makeup) return 'makeup'
  if (rec.rest) return 'rest'
  if (store.isFull(rec)) return 'full'
  if (!rec.total) return 'miss'
  return 'part'
}

function buildCells(year, month, data, selected) {
  const lead = new Date(year, month - 1, 1).getDay()
  const daysInMonth = new Date(year, month, 0).getDate()
  const cells = []

  for (let i = 0; i < lead; i++) cells.push({ idx: 'lead' + i, blank: true })

  for (let d = 1; d <= daysInMonth; d++) {
    const key = year + '-' + pad(month) + '-' + pad(d)
    const rec = store.dayRecord(data, key)
    const kind = cellKind(rec)
    cells.push({
      idx: key,
      key: key,
      day: d,
      blank: false,
      kind: kind,
      restFull: kind === 'rest' && store.isFull(rec),
      today: key === data.today,
      future: key > data.today,
      selected: key === selected
    })
  }

  while (cells.length % 7 !== 0) cells.push({ idx: 'tail' + cells.length, blank: true })
  return cells
}

/** 某天的详情：干了什么 + 拿到了什么 */
function buildDetail(data, key, candidates, cards) {
  const rec = store.dayRecord(data, key)
  const label = dateUtil.fullLabelOf(key)

  if (!rec) {
    return {
      key: key,
      label: label,
      empty: true,
      emptyText: key > data.today ? '这天还没到' : '这天还没有记录'
    }
  }

  const full = store.isFull(rec)
  let statusText = ''
  let statusClass = 'part'

  if (rec.makeup) {
    statusText = '补签'
    statusClass = 'makeup'
  } else if (rec.rest) {
    statusText = rec.restName || '假期'
    statusClass = 'rest'
  } else if (full) {
    statusText = '全勤'
    statusClass = 'full'
  } else if (!rec.total) {
    statusText = '缺勤'
    statusClass = 'miss'
  } else {
    statusText = Math.round((rec.done / rec.total) * 100) + '%'
    statusClass = 'part'
  }

  const tasks = (rec.tasks || []).map(function (t) {
    return { text: t.text, done: !!t.done }
  })

  const rewards = []
  if (full) rewards.push({ text: '全勤 +1 天', kind: 'full' })
  if (rec.points > 0) rewards.push({ text: '假期分 +' + rec.points, kind: 'points' })
  if (rec.makeup) rewards.push({ text: '补签 -1 张', kind: 'makeup' })
  if (rec.rest && !full) rewards.push({ text: '假期，不算缺勤', kind: 'rest' })

  return {
    key: key,
    label: label,
    empty: false,
    isToday: key === data.today,
    statusText: statusText,
    statusClass: statusClass,
    rest: rec.rest,
    restName: rec.restName,
    tasks: tasks,
    hasTasks: tasks.length > 0,
    doneCount: rec.done,
    totalCount: rec.total,
    rewards: rewards,
    canMakeup: cards > 0 && candidates.indexOf(key) >= 0
  }
}

Page({
  data: {
    weekdays: WEEKDAYS,
    tabAnim: '',
    year: 0,
    month: 0,
    monthLabel: '',
    cells: [],
    selected: '',
    detail: { empty: true, emptyText: '' },
    streak: 0,
    totalFull: 0,
    longestStreak: 0,
    holidayPoints: 0,
    makeupCards: 0,
    restDays: 0,
    summaryText: '',
    achGroups: [],
    achUnlocked: 0,
    achTotal: 0
  },

  onLoad() {
    const today = dateUtil.todayKey()
    const d = dateUtil.parseKey(today)
    this.setData({
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      selected: today
    })
  },

  onUnload() {
    if (this._timer) clearInterval(this._timer)
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 1 })
    }
    this.playTabAnim()
    if (!this.data.year) this.onLoad()
    this.refresh()
  },

  /**
   * 播一次底部导航的切页转场（wx.switchTab 本身没有动画）。
   * 动画结束后把类摘掉，否则下次切回来不会重播。
   */
  playTabAnim() {
    const app = getApp()
    const g = app && app.globalData ? app.globalData : null
    const dir = (g && g.tabDir) || 'forward'
    if (g) g.tabDir = 'none'

    const self = this
    this.setData({ tabAnim: dir === 'back' ? 'tab-in-back' : 'tab-in-forward' })
    if (this._animTimer) clearTimeout(this._animTimer)
    this._animTimer = setTimeout(function () {
      self.setData({ tabAnim: '' })
    }, 340)
  },

  refresh() {
    const data = store.init()
    const s = store.stats(data)
    const candidates = store.makeupCandidates(data)
    const year = this.data.year
    const month = this.data.month
    const selected = this.data.selected || data.today

    const achGroups = Object.keys(store.MILESTONES).map(function (type) {
      const current = s[type]
      const levels = store.MILESTONES[type]
      const unit = type === 'holidayPoints' ? '分' : '天'
      let next = null
      let unlockedHere = 0
      const items = levels.map(function (m) {
        const done = current >= m
        if (done) unlockedHere += 1
        if (!done && next === null) next = m
        return { value: m, state: done ? 'done' : (m === next ? 'next' : '') }
      })
      return {
        type: type,
        label: store.MILESTONE_LABEL[type],
        current: current,
        unit: unit,
        unlockedHere: unlockedHere,
        totalHere: levels.length,
        nextText: next === null
          ? '这一组已经全部解锁'
          : '下一个 ' + next + ' ' + unit + ' · 还差 ' + (next - current) + ' ' + unit,
        items: items
      }
    })

    let achUnlocked = 0
    let achTotal = 0
    achGroups.forEach(function (g) {
      achUnlocked += g.unlockedHere
      achTotal += g.totalHere
    })

    this.setData({
      cells: buildCells(year, month, data, selected),
      monthLabel: year + ' 年 ' + month + ' 月',
      selected: selected,
      detail: buildDetail(data, selected, candidates, s.makeupCards),
      achGroups: achGroups,
      achUnlocked: achUnlocked,
      achTotal: achTotal,
      makeupCards: s.makeupCards,
      restDays: s.restDays,
      summaryText: '累计记录 ' + s.recordedDays + ' 天 · 完成 ' + s.doneTasks + '/' + s.totalTasks + ' 件' +
        (s.restDays ? ' · 假期 ' + s.restDays + ' 天' : '') +
        (s.makeupDays ? ' · 补签 ' + s.makeupDays + ' 天' : '')
    })

    this.countUp(s)
  },

  countUp(target) {
    const self = this
    if (this._timer) clearInterval(this._timer)

    const steps = 20
    let i = 0
    this.setData({ streak: 0, totalFull: 0, longestStreak: 0, holidayPoints: 0 })

    this._timer = setInterval(function () {
      i++
      const eased = 1 - Math.pow(1 - i / steps, 3)
      self.setData({
        streak: Math.round(target.streak * eased),
        totalFull: Math.round(target.totalFull * eased),
        longestStreak: Math.round(target.longestStreak * eased),
        holidayPoints: Math.round(target.holidayPoints * eased)
      })
      if (i >= steps) {
        clearInterval(self._timer)
        self._timer = null
      }
    }, 26)
  },

  prevMonth() {
    let y = this.data.year
    let m = this.data.month - 1
    if (m < 1) {
      m = 12
      y -= 1
    }
    const self = this
    this.setData({ year: y, month: m }, function () { self.refresh() })
  },

  nextMonth() {
    let y = this.data.year
    let m = this.data.month + 1
    if (m > 12) {
      m = 1
      y += 1
    }
    const self = this
    this.setData({ year: y, month: m }, function () { self.refresh() })
  },

  /** 点某天 -> 显示那天的记录 */
  tapDay(e) {
    const key = e.currentTarget.dataset.key
    if (!key || key === this.data.selected) return
    const self = this
    this.setData({ selected: key }, function () { self.refresh() })
  },

  makeupDay() {
    const key = this.data.selected
    const data = store.load()
    const res = store.makeup(data, key)

    if (!res.ok) {
      wx.showToast({ title: res.msg, icon: 'none' })
      return
    }
    store.save(data)
    wx.showToast({ title: '补签成功', icon: 'success' })
    this.refresh()
  },

  goSettings() {
    wx.switchTab({ url: '/pages/settings/settings' })
  },

  goToday() {
    wx.switchTab({ url: '/pages/index/index' })
  }
})
