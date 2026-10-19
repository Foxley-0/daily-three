const store = require('../../utils/store')
const dateUtil = require('../../utils/date')

function tipOf(totalCount, doneCount, rest, points) {
  if (!totalCount) {
    return rest ? '假期中，想做就做，不做也不断签' : '先写下今天要做的三件事'
  }
  if (doneCount === totalCount) {
    return rest ? '假期全完成，+ ' + points + ' 假期分' : '今天全部完成，漂亮'
  }
  return '还剩 ' + (totalCount - doneCount) + ' 件没做'
}

Page({
  data: {
    dateLabel: '',
    weekday: '',
    tasks: [],
    progressText: '0/0',
    percent: 0,
    tipText: '',
    canDelete: false,
    rest: false,
    restName: '',
    lateNight: false,
    dayStartHour: 4,
    profileName: '',
    showNameSetup: false,
    nameInput: '',
    tabAnim: '',         // 底部导航切页时的转场类名
    stagger: false,      // 首次进入：列表逐条淡入
    enteringId: '',      // 正在播放「新增」动画的任务
    leavingId: '',       // 正在播放「删除」动画的任务
    celebrating: false,  // 全部完成时放一次庆祝
    numAnim: false       // 进度数字弹一下
  },

  onLoad() {
    this._doneCount = -1
    this._staggered = false
    this._timers = []
  },

  onUnload() {
    this._timers.forEach(function (t) { clearTimeout(t) })
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 })
    }
    this.playTabAnim()
    const data = store.init()
    const first = !this._staggered
    this._staggered = true

    // 还没起名字就先让用户起一个；跳过过就不再弹（审核员不能被这个挡住）
    this.setData({
      profileName: data.profile.name,
      showNameSetup: !data.profile.name && !data.profile.skipped
    })

    this.render(data, first ? { stagger: true } : null)

    if (first) {
      this.later(function () {
        this.setData({ stagger: false })
      }, 760)
    }
  },

  /** 定时器统一登记，页面卸载时清理 */
  later(fn, delay) {
    const self = this
    const t = setTimeout(function () { fn.call(self) }, delay)
    this._timers.push(t)
    return t
  },

  /**
   * 播一次底部导航的切页转场。
   * wx.switchTab 本身没有动画（原生 tabBar 也没有），方向由 custom-tab-bar
   * 记在 globalData.tabDir 里。动画结束后必须把类摘掉，
   * 否则下次切回来不会重播 —— tab 页的元素不会重建。
   */
  playTabAnim() {
    const app = getApp()
    const g = app && app.globalData ? app.globalData : null
    const dir = (g && g.tabDir) || 'forward'
    if (g) g.tabDir = 'none'

    this.setData({ tabAnim: dir === 'back' ? 'tab-in-back' : 'tab-in-forward' })
    this.later(function () {
      this.setData({ tabAnim: '' })
    }, 340)
  },

  /** 整体刷新界面；extra 用来合并一次性动画状态 */
  render(data, extra) {
    const filled = store.filledTasks(data.tasks)
    const totalCount = filled.length
    const doneCount = filled.filter(function (t) { return t.done }).length
    const info = store.todayInfo(data)

    const patch = {
      dateLabel: dateUtil.labelOf(data.today),
      weekday: dateUtil.weekdayOf(data.today),
      tasks: data.tasks,
      progressText: doneCount + '/' + totalCount,
      percent: totalCount ? Math.round((doneCount / totalCount) * 100) : 0,
      tipText: tipOf(totalCount, doneCount, info.rest, info.points),
      canDelete: data.tasks.length > (data.minTasks || store.MIN_TASKS),
      rest: info.rest,
      restName: info.restName,
      lateNight: dateUtil.isLateNight(data.dayStartHour),
      dayStartHour: data.dayStartHour
    }
    if (extra) {
      Object.keys(extra).forEach(function (k) { patch[k] = extra[k] })
    }
    this.setData(patch)
    this.animateCount(doneCount, totalCount)
  },

  /** 数字变化时弹一下；刚好全部完成时放一次庆祝 */
  animateCount(doneCount, totalCount) {
    const prev = this._doneCount
    this._doneCount = doneCount

    const allDone = totalCount > 0 && doneCount === totalCount
    if (allDone && prev >= 0 && prev !== doneCount) {
      this.setData({ celebrating: true })
      this.later(function () {
        this.setData({ celebrating: false })
      }, 1400)
    }

    if (prev !== doneCount) {
      this.setData({ numAnim: true })
      this.later(function () {
        this.setData({ numAnim: false })
      }, 340)
    }
  },

  /** 只刷新进度相关字段，避免输入时光标跳动 */
  patchProgress(data, index, text) {
    const filled = store.filledTasks(data.tasks)
    const totalCount = filled.length
    const doneCount = filled.filter(function (t) { return t.done }).length
    const info = store.todayInfo(data)
    const patch = {
      progressText: doneCount + '/' + totalCount,
      percent: totalCount ? Math.round((doneCount / totalCount) * 100) : 0,
      tipText: tipOf(totalCount, doneCount, info.rest, info.points)
    }
    if (index !== undefined) patch['tasks[' + index + '].text'] = text
    this.setData(patch)
  },

  onTaskInput(e) {
    const index = Number(e.currentTarget.dataset.index)
    const value = e.detail.value
    const data = store.load()
    if (!data.tasks[index]) return
    data.tasks[index].text = value
    store.save(data)
    this.patchProgress(data, index, value)
  },

  toggleTask(e) {
    const index = Number(e.currentTarget.dataset.index)
    const data = store.load()
    const task = data.tasks[index]
    if (!task) return
    if (!task.text || !task.text.trim()) {
      wx.showToast({ title: '先写点内容', icon: 'none' })
      return
    }
    task.done = !task.done
    store.save(data)
    this.render(data)
  },

  addTask() {
    const data = store.load()
    const task = store.blankTask()
    data.tasks.push(task)
    store.save(data)
    this.render(data, { enteringId: task.id })
    this.later(function () {
      if (this.data.enteringId === task.id) this.setData({ enteringId: '' })
    }, 520)
  },

  removeTask(e) {
    const index = Number(e.currentTarget.dataset.index)
    const data = store.load()
    const min = data.minTasks || store.MIN_TASKS
    if (data.tasks.length <= min) {
      wx.showToast({ title: '至少保留 ' + min + ' 个任务位', icon: 'none' })
      return
    }
    const id = data.tasks[index].id

    // 先播收起动画，动画结束再真正删数据
    this.setData({ leavingId: id })
    this.later(function () {
      const fresh = store.load()
      const at = fresh.tasks.findIndex(function (t) { return t.id === id })
      if (at >= 0) fresh.tasks.splice(at, 1)
      fresh.tasks = store.padToMin(fresh.tasks, fresh.minTasks)
      store.save(fresh)
      this.render(fresh, { leavingId: '' })
    }, 300)
  },

  goSettings() {
    wx.switchTab({ url: '/pages/settings/settings' })
  },

  onNameInput(e) {
    this.setData({ nameInput: e.detail.value })
  },

  submitName() {
    const name = (this.data.nameInput || '').trim()
    if (!name) {
      wx.showToast({ title: '先起个名字吧', icon: 'none' })
      return
    }
    const data = store.load()
    store.setProfileName(data, name)
    store.save(data)
    this.setData({ showNameSetup: false, profileName: data.profile.name, nameInput: '' })
  },

  /** 跳过起名，直接用。名字随时可以在设置里补 */
  skipName() {
    const data = store.load()
    store.skipProfileName(data)
    store.save(data)
    this.setData({ showNameSetup: false })
    wx.showToast({ title: '随时可在设置里补名字', icon: 'none' })
  }
})
