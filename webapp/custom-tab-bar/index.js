Component({
  data: {
    selected: 0,
    list: [
      { pagePath: '/pages/index/index', text: '今日', icon: 'today' },
      { pagePath: '/pages/history/history', text: '记录', icon: 'chart' },
      { pagePath: '/pages/settings/settings', text: '设置', icon: 'gear' }
    ]
  },

  methods: {
    switchTab(e) {
      const index = Number(e.currentTarget.dataset.index)
      const item = this.data.list[index]
      if (!item) return

      // 用当前页面路由判断，而不是 selected 状态 ——
      // selected 只记录"上次是哪个 tab"，从设置里推出去的页面（比如假期设置）
      // 会让 selected 停在 2，导致再点"设置"没反应、退不回去。
      const pages = getCurrentPages()
      const cur = pages.length ? pages[pages.length - 1] : null
      const curRoute = cur && cur.route ? '/' + cur.route : ''
      if (curRoute === item.pagePath) return

      // 记下切页方向，目标页 onShow 里据此决定从哪边滑进来
      const app = getApp()
      if (app && app.globalData) {
        app.globalData.tabDir = index > this.data.selected ? 'forward' : 'back'
      }

      wx.switchTab({ url: item.pagePath })
    }
  }
})
