/**
 * 提醒：配置 + 文案生成
 *
 * 这里只放纯逻辑，**不碰 wx.***，原因有两个：
 *   1. 好单测（Node 里直接跑）
 *   2. 云函数也要用它生成文案，云函数里没有 wx
 *
 * 数据从哪来由调用方负责：小程序端从 store 算，云函数从云数据库读。
 */

/** 默认提醒配置 */
const DEFAULT = {
  enabled: false,
  /** 提醒时间 HH:mm */
  time: '22:30',
  /** 提醒哪一件：'all' = 只说还差几件；0/1/2 = 指定第几件 */
  target: 'all',
  /** 周日那条要不要带周报数据 */
  weekly: true
}

/** 18:00 之前算「早间」，用昨天的数据；之后用今天的数据 */
const MORNING_CUTOFF = 18 * 60

/** 订阅消息 thing 类字段一般不超过 20 字 */
const FIELD_MAX = 20

function pad2(n) {
  return (n < 10 ? '0' : '') + n
}

function hhmmToMinutes(s) {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(s == null ? '' : s).trim())
  if (!m) return 22 * 60 + 30
  const h = Math.min(23, Math.max(0, Number(m[1])))
  const mi = Math.min(59, Math.max(0, Number(m[2])))
  return h * 60 + mi
}

function minutesToHhmm(n) {
  const v = Math.max(0, Math.min(23 * 60 + 59, Math.round(n)))
  return pad2(Math.floor(v / 60)) + ':' + pad2(v % 60)
}

/** 补全并夹取提醒配置 */
function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  let target = r.target
  if (target !== 'all') {
    target = Number(target)
    if (!(target === 0 || target === 1 || target === 2)) target = 'all'
  }
  return {
    enabled: !!r.enabled,
    time: minutesToHhmm(hhmmToMinutes(r.time)),
    target: target,
    weekly: r.weekly === undefined ? true : !!r.weekly
  }
}

function clip(s) {
  const t = String(s == null ? '' : s).trim()
  return t.length > FIELD_MAX ? t.slice(0, FIELD_MAX - 1) + '…' : t
}

function streakLine(streak) {
  return streak > 0 ? '连续 ' + streak + ' 天' : '还没有连续记录'
}

function fullLine(totalFull) {
  return totalFull > 0 ? '累计全勤 ' + totalFull + ' 天' : '还没有全勤记录'
}

/**
 * 生成一条日报的文案
 *
 * ctx 由调用方组装：
 * {
 *   time: '22:30',                 // 配置的提醒时间，决定早/晚模式
 *   isSunday: false,
 *   today:     { total, done, rest, restName },
 *   yesterday: { total, done, rest },
 *   streak: 0,                     // 含今天（今天全勤才算）
 *   totalFull: 0,                  // 含今天
 *   week: { total, done, rate },   // 最近 7 天
 *   target: 'all' | 0 | 1 | 2,
 *   targetText: '',                // 指定那件当天写的文字
 *   targetDone: false
 * }
 *
 * 返回 { kind, send, title, lines }
 *   kind: 'rest' | 'morning' | 'blank' | 'warning' | 'done'
 *   send: false 表示这条不该发（省额度）
 */
function buildMessage(ctx) {
  const c = ctx && typeof ctx === 'object' ? ctx : {}
  const today = c.today || { total: 0, done: 0 }
  const yest = c.yesterday || { total: 0, done: 0 }
  const streak = Number(c.streak) || 0
  const totalFull = Number(c.totalFull) || 0

  // 今天放假：不记录、不断签，没必要提醒
  if (today.rest) {
    return {
      kind: 'rest',
      send: false,
      title: clip('今天放假'),
      lines: [clip(today.restName || '假期愉快')]
    }
  }

  const morning = hhmmToMinutes(c.time) < MORNING_CUTOFF
  return morning
    ? buildMorning(yest, streak, totalFull)
    : buildEvening(c, today, streak, totalFull)
}

/* ---------------- 早间：今天还没开始，用昨天的数据 ---------------- */

function buildMorning(yest, streak, totalFull) {
  const yTotal = Number(yest.total) || 0
  const yDone = Number(yest.done) || 0
  const yFull = yTotal > 0 && yDone === yTotal

  let title
  const lines = []

  if (yest.rest) {
    title = '假期结束，今天开始'
    lines.push('今天记三件事吧')
  } else if (yFull) {
    title = '昨天全勤，今天继续'
    lines.push('今天记三件事吧')
  } else if (yTotal === 0) {
    title = '今天重新开始'
    lines.push('昨天没记，今天记三件事吧')
  } else {
    title = '今天重新开始'
    lines.push('昨天差 ' + (yTotal - yDone) + ' 件')
  }

  lines.push(streakLine(streak))
  lines.push(fullLine(totalFull))

  return { kind: 'morning', send: true, title: clip(title), lines: lines.map(clip) }
}

/* ---------------- 晚间：用今天的数据 ---------------- */

function buildEvening(c, today, streak, totalFull) {
  const total = Number(today.total) || 0
  const done = Number(today.done) || 0
  const left = total - done
  const week = c.week && typeof c.week === 'object' ? c.week : null

  /* 一件都没写 */
  if (total === 0) {
    const title = streak >= 3 ? '连续 ' + streak + ' 天要断了' : '今天还是空白'
    // 全新用户没有数据可给，别连说两句「还没有…」
    const tail = streak > 0 || totalFull > 0
      ? fullLine(totalFull)
      : '今天做一件就算开始'
    return {
      kind: 'blank',
      send: true,
      title: clip(title),
      lines: [clip('现在补还来得及'), clip(streakLine(streak)), clip(tail)]
    }
  }

  /* 写了但没做完 */
  if (done < total) {
    // 标题给情绪，第一行给数据 —— 两者别重复
    const title = streak >= 3 ? '连续 ' + streak + ' 天要断了' : '今天还没完成'
    const lines = [clip('还差 ' + left + ' 件没做')]

    // 第二行：指定的那件；不指定或那件已完成，就给个兜底，保证行数固定
    const t = targetLine(c)
    if (t) {
      lines.push(t)
    } else if (done > 0) {
      lines.push(clip('已经做了 ' + done + ' 件'))
    } else {
      lines.push(clip('现在补还来得及'))
    }

    // 第三行：累计数据；全新用户没数据可给，就给句鼓励
    let tail
    if (week && c.isSunday) {
      tail = streakLine(streak) + ' · 本周 ' + week.rate + '%'
    } else if (streak > 0) {
      tail = streakLine(streak) + ' · 累计 ' + totalFull + ' 天'
    } else if (totalFull > 0) {
      tail = fullLine(totalFull)
    } else {
      tail = '今天做一件就算开始'
    }
    lines.push(clip(tail))

    return { kind: 'warning', send: true, title: clip(title), lines: lines }
  }

  /* 全做完了 —— 换成「明天也要加油」+ 数据总结 */
  if (c.isSunday && week && c.weekly !== false) {
    return {
      kind: 'done',
      send: true,
      title: clip('本周 ' + week.done + '/' + week.total + ' 件'),
      lines: [
        clip('今天也全勤，连续 ' + streak + ' 天'),
        clip('累计全勤 ' + totalFull + ' 天'),
        clip('本周完成率 ' + week.rate + '%')
      ]
    }
  }

  return {
    kind: 'done',
    send: true,
    title: clip('今天全勤，明天继续'),
    lines: [
      clip('连续 ' + streak + ' 天'),
      clip(fullLine(totalFull)),
      clip(week ? '本周完成率 ' + week.rate + '%' : '明天也要加油')
    ]
  }
}

/** 指定提醒第几件：那件做完了就不提，省得烦人 */
function targetLine(c) {
  const raw = c.target
  if (raw === 'all' || raw === undefined || raw === null) return ''
  const i = Number(raw)
  if (!(i === 0 || i === 1 || i === 2)) return ''
  if (c.targetDone) return ''

  const txt = String(c.targetText == null ? '' : c.targetText).trim()
  const no = '第 ' + (i + 1) + ' 件'
  if (!txt) return clip(no + '还没写')
  return clip(no + '「' + txt + '」还没动')
}

module.exports = {
  DEFAULT,
  MORNING_CUTOFF,
  FIELD_MAX,
  normalize,
  buildMessage,
  hhmmToMinutes,
  minutesToHhmm
}
