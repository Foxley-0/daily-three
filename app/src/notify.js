/**
 * 本地通知
 *
 * 用 Android 系统的定时通知，**不依赖任何服务器、不需要网络、没有额度**。
 * 这是 APK 相比微信小程序最大的优势：小程序要一次授权一条，这里想发就发。
 *
 * 阶段 2 先用固定文案跑通链路。
 * 阶段 3 只要页面暴露 window.DailyData，这里就能自动换成智能文案。
 */
(function () {
  var Plugins = (window.Capacitor && window.Capacitor.Plugins) || {}
  var LocalNotifications = Plugins.LocalNotifications

  var ID = 1
  var DEFAULT_HOUR = 22
  var DEFAULT_MINUTE = 30
  var CHANNEL = 'daily'

  /** 是不是跑在 App 里（浏览器里打开就跳过） */
  function isApp() {
    return !!(window.Capacitor &&
      typeof window.Capacitor.isNativePlatform === 'function' &&
      window.Capacitor.isNativePlatform())
  }

  /**
   * 生成通知内容。
   * 页面如果提供了 window.DailyData，就用真实数据生成；否则用兜底文案。
   */
  function buildContent() {
    var hook = window.DailyData
    if (hook && typeof hook.getReminderContext === 'function' && window.Reminder) {
      try {
        var msg = window.Reminder.buildMessage(hook.getReminderContext())
        if (msg && msg.send !== false) {
          return {
            title: msg.title,
            body: (msg.lines || []).join(' · ')
          }
        }
        if (msg && msg.send === false) return null // 今天放假之类，不发
      } catch (e) {
        console.warn('[notify] 生成文案失败，用兜底文案', e)
      }
    }
    return {
      title: '今天的三件事做完了吗',
      body: '点开看看，别让连续记录断了'
    }
  }

  function askPermission() {
    if (!LocalNotifications) return Promise.resolve(false)
    return LocalNotifications.requestPermissions().then(function (res) {
      return res && res.display === 'granted'
    })
  }

  function ensureChannel() {
    if (!LocalNotifications || !LocalNotifications.createChannel) return Promise.resolve()
    return LocalNotifications.createChannel({
      id: CHANNEL,
      name: '每日提醒',
      description: '每天提醒你打卡',
      importance: 4,
      visibility: 1,
      vibration: true
    }).catch(function () {
      // 渠道已存在时会报错，忽略
    })
  }

  /** 排一条每天重复的通知（先取消旧的，避免重复叠加） */
  function schedule(hour, minute, title, body) {
    if (!LocalNotifications) return Promise.resolve()
    return LocalNotifications.cancel({ notifications: [{ id: ID }] })
      .catch(function () {})
      .then(function () {
        return LocalNotifications.schedule({
          notifications: [{
            id: ID,
            title: title,
            body: body,
            channelId: CHANNEL,
            schedule: {
              on: { hour: hour, minute: minute },
              repeats: true,
              // 省电模式 / 打盹模式下也要能触发
              allowWhileIdle: true
            }
          }]
        })
      })
  }

  /**
   * 重新排一次。
   * 每次打开 App 或改完设置都该调一下 —— 文案会跟着数据变。
   */
  function refresh(opts) {
    opts = opts || {}
    var hour = opts.hour === undefined ? DEFAULT_HOUR : opts.hour
    var minute = opts.minute === undefined ? DEFAULT_MINUTE : opts.minute

    var content = buildContent()
    if (!content) {
      // 明确表示今天不该发（比如放假），取消掉
      if (LocalNotifications) {
        return LocalNotifications.cancel({ notifications: [{ id: ID }] }).catch(function () {})
      }
      return Promise.resolve()
    }
    return schedule(hour, minute, content.title, content.body)
  }

  function init() {
    if (!isApp()) {
      console.log('[notify] 不在 App 环境里，跳过（浏览器预览时正常）')
      return Promise.resolve()
    }
    if (!LocalNotifications) {
      console.warn('[notify] 没找到 LocalNotifications 插件')
      return Promise.resolve()
    }
    return askPermission().then(function (granted) {
      if (!granted) {
        console.warn('[notify] 用户没给通知权限')
        return
      }
      return ensureChannel().then(function () {
        return refresh()
      }).then(function () {
        console.log('[notify] 已排好每天 ' + DEFAULT_HOUR + ':' + DEFAULT_MINUTE + ' 的提醒')
      })
    })
  }

  window.addEventListener('load', function () {
    init().catch(function (e) {
      console.error('[notify] 初始化失败', e)
    })
  })

  window.DailyNotify = {
    init: init,
    refresh: refresh,
    isApp: isApp
  }
})()
