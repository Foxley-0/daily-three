const store = require('./utils/store')

App({
  globalData: {
    /**
     * 底部导航切页的方向，供目标页 onShow 播转场用。
     * 微信的 wx.switchTab 本身没有转场动画，只能自己补一个。
     * 'forward' 从右侧滑入 / 'back' 从左侧滑入 / 'none' 不播
     */
    tabDir: 'forward'
  },

  onLaunch() {
    // 启动时先做一次跨天检查：归档昨天 + 清空任务栏
    store.init()
  },

  onShow() {
    // 从后台切回前台也可能已经跨天了，再检查一次
    store.init()
  }
})
