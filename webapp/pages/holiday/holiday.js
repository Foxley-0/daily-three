const store = require('../../utils/store')
const holidays = require('../../utils/holidays')
const dateUtil = require('../../utils/date')

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

function pad(n) {
  return n < 10 ? '0' + n : String(n)
}

function monthKey(year, month) {
  return year + '-' + pad(month)
}

/** 生成某个月的日历格子 */
function buildCells(year, month, customHolidays, form) {
  const lead = new Date(year, month - 1, 1).getDay()
  const daysInMonth = new Date(year, month, 0).getDate()
  const today = dateUtil.todayKey()
  const cells = []

  for (let i = 0; i < lead; i++) {
    cells.push({ idx: 'lead' + i, blank: true })
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const key = year + '-' + pad(month) + '-' + pad(d)
    const h = holidays.find(key, customHolidays)
    let kind = 'normal'
    if (h) kind = h.builtIn ? 'builtin' : 'custom'
    cells.push({
      idx: key,
      key: key,
      day: d,
      blank: false,
      kind: kind,
      name: h ? h.name : '',
      today: key === today,
      past: key < today,
      selected: !!(form.start && form.end && key >= form.start && key <= form.end)
    })
  }

  while (cells.length % 7 !== 0) {
    cells.push({ idx: 'tail' + cells.length, blank: true })
  }
  return cells
}

function rangeText(start, end) {
  if (start === end) return dateUtil.labelOf(start)
  return dateUtil.labelOf(start) + ' ~ ' + dateUtil.labelOf(end)
}

Page({
  data: {
    weekdays: WEEKDAYS,
    statusBarHeight: 20,
    navHeight: 64,
    year: 0,
    month: 0,
    monthLabel: '',
    cells: [],
    covered: true,
    form: { name: '', start: '', end: '' },
    formTouched: false,
    days: 0,
    minDate: '',
    custom: [],
    coverage: { from: '', to: '' },
    nextYear: ''
  },

  onLoad() {
    const today = dateUtil.todayKey()
    const d = dateUtil.parseKey(today)

    // 用了自定义导航栏，得自己把状态栏高度让出来
    let statusBarHeight = 20
    try {
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
      if (info && info.statusBarHeight) statusBarHeight = info.statusBarHeight
    } catch (e) {
      // 拿不到就用默认值
    }

    this.setData({
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      minDate: today,
      form: { name: '', start: today, end: today },
      days: 1,
      statusBarHeight: statusBarHeight,
      navHeight: statusBarHeight + 44
    })
  },

  onShow() {
    this.refresh()
  },

  goBack() {
    const pages = getCurrentPages()
    if (pages.length > 1) {
      wx.navigateBack()
    } else {
      // 万一被直接打开（没有上一页），退回设置
      wx.switchTab({ url: '/pages/settings/settings' })
    }
  },

  refresh() {
    const data = store.load()
    const cov = holidays.coverage()
    const year = this.data.year
    const month = this.data.month
    const mk = monthKey(year, month)

    const custom = data.customHolidays.map(function (h) {
      return {
        id: h.id,
        name: h.name,
        rangeText: rangeText(h.start, h.end),
        days: store.holidayDays(h.start, h.end)
      }
    })

    this.setData({
      cells: buildCells(year, month, data.customHolidays, this.data.form),
      custom: custom,
      coverage: cov,
      nextYear: String(Number(cov.to.slice(0, 4)) + 1) + ' 年',
      monthLabel: year + ' 年 ' + month + ' 月',
      // 这个月是否落在内置表的覆盖范围里
      covered: mk >= cov.from.slice(0, 7) && mk <= cov.to.slice(0, 7)
    })
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

  /** 点日历上的日期快速选起止：第一次点=选单日，之后往后/往前扩成区间，点区间内重置为单日 */
  tapDay(e) {
    const key = e.currentTarget.dataset.key
    if (!key) return
    if (key < this.data.minDate) {
      wx.showToast({ title: '不能选过去的日期', icon: 'none' })
      return
    }

    const f = this.data.form
    let start
    let end

    if (!this.data.formTouched) {
      // 表单默认是"今天~今天"，那只是个占位，第一次点日历应该是一次全新的选择
      start = key
      end = key
    } else if (f.start && f.end && key > f.start && key < f.end) {
      start = key
      end = key
    } else if (f.start && f.end && key > f.end) {
      start = f.start
      end = key
    } else if (f.start && f.end && key < f.start) {
      start = key
      end = f.end
    } else {
      start = key
      end = key
    }

    this.setData({ form: { name: f.name, start: start, end: end }, formTouched: true })
    this.updateDays(start, end)
    this.refresh()
  },

  onName(e) {
    this.setData({ 'form.name': e.detail.value })
  },

  onStart(e) {
    const start = e.detail.value
    const f = this.data.form
    const end = f.end && f.end >= start ? f.end : start
    this.setData({ form: { name: f.name, start: start, end: end }, formTouched: true })
    this.updateDays(start, end)
    this.refresh()
  },

  onEnd(e) {
    const end = e.detail.value
    const f = this.data.form
    this.setData({ form: { name: f.name, start: f.start, end: end }, formTouched: true })
    this.updateDays(f.start, end)
    this.refresh()
  },

  updateDays(start, end) {
    if (!start || !end || start > end) {
      this.setData({ days: 0 })
      return
    }
    this.setData({ days: store.holidayDays(start, end) })
  },

  submit() {
    const f = this.data.form
    const data = store.load()
    const res = store.addHoliday(data, f.name, f.start, f.end)

    if (!res.ok) {
      wx.showToast({ title: res.msg, icon: 'none' })
      return
    }
    store.save(data)
    wx.showToast({ title: '已加入假期', icon: 'none' })

    const today = dateUtil.todayKey()
    this.setData({ form: { name: '', start: today, end: today }, formTouched: false, days: 1 })
    this.refresh()
  },

  remove(e) {
    const id = e.currentTarget.dataset.id
    const self = this
    wx.showModal({
      title: '删除这个假期',
      content: '删除后这些日子会按普通工作日计算，确定吗？',
      confirmColor: '#e64340',
      success: function (res) {
        if (!res.confirm) return
        const data = store.load()
        store.removeHoliday(data, id)
        store.save(data)
        self.refresh()
      }
    })
  }
})
