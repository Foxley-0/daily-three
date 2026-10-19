const store = require('../../utils/store')
const dateUtil = require('../../utils/date')

function buildLabels(count, unit, offset) {
  const out = []
  for (let i = 0; i < count; i++) {
    out.push(String(i + (offset || 0)) + ' ' + unit)
  }
  return out
}

Page({
  data: {
    accounts: [],
    maxAccounts: store.MAX_ACCOUNTS,
    tabAnim: '',
    dayStartHour: 4,
    minTasks: 3,
    maxCards: 3,
    hourLabels: [],
    minLabels: [],
    cardLabels: [],
    calendarKey: '',
    currentLabel: '',
    lateNight: false,
    customCount: 0,
    startDateLabel: ''
  },

  onLoad() {
    this.setData({
      hourLabels: buildLabels(24, '点', 0),
      minLabels: buildLabels(10, '个', 1),
      cardLabels: buildLabels(10, '张', 1)
    })
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 })
    }
    this.playTabAnim()
    this.sync(store.init())
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

  sync(data) {
    const d = data || store.load()
    const calendar = dateUtil.todayKey()
    const current = dateUtil.logicalKey(d.dayStartHour)

    this.setData({
      accounts: store.listAccounts(),
      dayStartHour: d.dayStartHour,
      minTasks: d.minTasks,
      maxCards: d.maxCards,
      calendarKey: calendar,
      currentLabel: dateUtil.labelOf(current) + ' ' + dateUtil.weekdayOf(current),
      lateNight: dateUtil.isLateNight(d.dayStartHour),
      customCount: d.customHolidays.length,
      startDateLabel: d.achievements.startDate ? dateUtil.labelOf(d.achievements.startDate) : '—'
    })
  },

  /* ---------------- 账号 ---------------- */

  onAccountTap(e) {
    const id = e.currentTarget.dataset.id
    const acc = this.data.accounts.filter(function (a) { return a.id === id })[0]
    if (!acc) return

    if (acc.active) {
      this.renameAccount(id)
      return
    }

    const res = store.switchAccount(id)
    if (!res.ok) {
      wx.showToast({ title: res.msg, icon: 'none' })
      return
    }
    wx.showToast({ title: '已切到「' + acc.name + '」', icon: 'none' })
    this.sync(store.init())
  },

  onAccountDelete(e) {
    const self = this
    const id = e.currentTarget.dataset.id
    const acc = this.data.accounts.filter(function (a) { return a.id === id })[0]
    if (!acc) return

    wx.showModal({
      title: '删除账号',
      content: '「' + acc.name + '」的任务、历史、假期和成就都会一起删除，无法恢复。',
      confirmText: '删除',
      confirmColor: '#e64340',
      success: function (res) {
        if (!res.confirm) return
        const r = store.removeAccount(id)
        if (!r.ok) {
          wx.showToast({ title: r.msg, icon: 'none' })
          return
        }
        wx.showToast({ title: '已删除', icon: 'none' })
        self.sync(store.init())
      }
    })
  },

  onAddAccount() {
    const self = this
    wx.showModal({
      title: '新账号的名字',
      editable: true,
      placeholderText: '比如：工作 / 个人',
      success: function (res) {
        if (!res.confirm) return
        const name = (res.content || '').trim()
        if (!name) {
          wx.showToast({ title: '起个名字吧', icon: 'none' })
          return
        }
        const r = store.addAccount(name)
        if (!r.ok) {
          wx.showToast({ title: r.msg, icon: 'none' })
          return
        }
        wx.showToast({ title: '已添加并切换', icon: 'none' })
        self.sync(store.init())
      }
    })
  },

  renameAccount(id) {
    const self = this
    const acc = this.data.accounts.filter(function (a) { return a.id === id })[0]
    wx.showModal({
      title: '修改名字',
      editable: true,
      placeholderText: '输入名字',
      // 用 rawName，别把"未命名"这个占位文字预填进去
      content: acc ? acc.rawName : '',
      success: function (res) {
        if (!res.confirm) return
        const r = store.renameAccount(id, res.content)
        if (!r.ok) {
          wx.showToast({ title: r.msg, icon: 'none' })
          return
        }
        self.sync(store.init())
      }
    })
  },

  /* ---------------- 设置项 ---------------- */

  onHour(e) {
    const data = store.load()
    store.setDayStartHour(data, Number(e.detail.value))
    store.save(data)
    this.sync(data)
    wx.showToast({ title: '已保存', icon: 'none' })
  },

  onMin(e) {
    const data = store.load()
    store.setMinTasks(data, Number(e.detail.value) + 1)
    store.save(data)
    this.sync(data)
    wx.showToast({ title: '已保存', icon: 'none' })
  },

  onCards(e) {
    const data = store.load()
    store.setMaxCards(data, Number(e.detail.value) + 1)
    store.save(data)
    this.sync(data)
    wx.showToast({ title: '已保存', icon: 'none' })
  },

  goHoliday() {
    wx.navigateTo({ url: '/pages/holiday/holiday' })
  }
})
