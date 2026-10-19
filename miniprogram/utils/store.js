const dateUtil = require('./date')
const holidays = require('./holidays')

const STORAGE_KEY = 'daily_three_v1'

/** 可配置项的默认值（设置页可以改） */
const DEFAULTS = {
  /** 每天几点算新的一天。默认凌晨 4 点：凌晨写的任务还算前一天 */
  dayStartHour: 4,
  /** 任务栏最少保留几个位置 */
  minTasks: 3,
  /** 补签卡最多存几张 */
  maxCards: 3
}

/** 任务栏最少几个位置（默认值，实际以 data.minTasks 为准） */
const MIN_TASKS = DEFAULTS.minTasks
/** 补签卡最多存几张（默认值，实际以 data.maxCards 为准） */
const MAX_CARDS = DEFAULTS.maxCards
/** 跨天时最多往前补几天空白记录，避免久未打开后一次生成几百条 */
const MAX_GAP_DAYS = 30
/** 每连续多少天送一张补签卡 */
const CARDS_PER = 7
/** 只能补签最近几天的缺勤 */
const MAKEUP_WINDOW = 3
/** 回溯上限，防死循环 */
const MAX_LOOKBACK = 2000

/** 成就里程碑 */
const MILESTONES = {
  totalFull: [10, 30, 50, 100, 200, 365],
  longestStreak: [7, 30, 100, 365],
  holidayPoints: [30, 100, 300]
}

const MILESTONE_LABEL = {
  totalFull: '累计全勤',
  longestStreak: '最长连续',
  holidayPoints: '假期分'
}

let seq = 0
function newId() {
  seq += 1
  return 't' + Date.now().toString(36) + seq
}

function blankTask() {
  return { id: newId(), text: '', done: false }
}

/** 把任务列表补足到最少 min 个位置 */
function padToMin(list, min) {
  const n = typeof min === 'number' && min > 0 ? min : DEFAULTS.minTasks
  const out = (list || []).slice()
  while (out.length < n) out.push(blankTask())
  return out
}

function filledTasks(list) {
  return (list || []).filter(function (t) {
    return t && typeof t.text === 'string' && t.text.trim()
  })
}

/** 某天算不算全勤：写了任务且全部完成。假期和空白日都不算 */
function isFull(rec) {
  return !!rec && rec.total > 0 && rec.done === rec.total
}

/* ---------------- 归档 ---------------- */

/**
 * 把某一天归档进历史。
 * 即使一条任务都没写也会留一条记录 —— 那天必须"存在"，
 * 否则连续打卡会被隐形跳过。
 */
function archive(data, key, tasks) {
  const filled = filledTasks(tasks)
  const h = holidays.find(key, data.customHolidays)
  const total = filled.length
  const done = filled.filter(function (t) {
    return t.done
  }).length

  data.history[key] = {
    date: key,
    tasks: filled.map(function (t) {
      return { text: t.text.trim(), done: !!t.done }
    }),
    total: total,
    done: done,
    rest: !!h,
    restName: h ? h.name : '',
    makeup: false,
    points: holidays.pointsFor(total, done, !!h),
    archivedAt: Date.now()
  }
  return data.history[key]
}

/* ---------------- 连续天数 ---------------- */

/** 从 key 往回数连续天数（含 key 本身） */
function streakEndingAt(data, key) {
  let streak = 0
  let cursor = key
  let guard = 0
  while (guard < MAX_LOOKBACK) {
    guard += 1
    const rec = data.history[cursor]
    if (!rec) break
    // 先看有没有完成 —— 假期里全做完也算数，不能因为它是假期就抹掉
    if (isFull(rec) || rec.makeup) {
      streak += 1
      cursor = dateUtil.shiftKey(cursor, -1)
      continue
    }
    // 假期没做完：跳过，不算也不断
    if (rec.rest) {
      cursor = dateUtil.shiftKey(cursor, -1)
      continue
    }
    break
  }
  return streak
}

/** 当前连续打卡：含今天（今天没做完也不扣，只是不加） */
function computeStreak(data) {
  let streak = 0
  const todayFilled = filledTasks(data.tasks)
  if (todayFilled.length && todayFilled.every(function (t) { return t.done })) {
    streak += 1
  }
  return streak + streakEndingAt(data, dateUtil.shiftKey(data.today, -1))
}

/** 历史最长连续：从 history 正着扫一遍，含今天 */
function longestStreakOf(data) {
  const keys = Object.keys(data.history).sort()
  let best = 0
  let run = 0
  let prev = ''
  let lastKey = ''

  keys.forEach(function (k) {
    const r = data.history[k]
    // 记录之间必须首尾相接，否则连续中断（老数据可能缺天）
    if (prev && dateUtil.shiftKey(prev, 1) !== k) run = 0
    prev = k
    lastKey = k

    // 先看有没有完成 —— 假期里全做完也算数
    if (isFull(r) || r.makeup) {
      run += 1
      if (run > best) best = run
    } else if (!r.rest) {
      // 假期没做完：跳过，不算也不断
      run = 0
    }
  })

  const filled = filledTasks(data.tasks)
  if (filled.length && filled.every(function (t) { return t.done })) {
    run = lastKey && dateUtil.shiftKey(lastKey, 1) === data.today ? run + 1 : 1
    if (run > best) best = run
  }
  return best
}

/* ---------------- 从 history 推导统计 ---------------- */

/**
 * 所有统计都从 history + 今天推导出来，不额外维护累加器 ——
 * 两个真相来源一定会漂移。
 */
function derived(data) {
  const info = todayInfo(data)
  const todayFull = info.total > 0 && info.done === info.total

  let totalFull = todayFull ? 1 : 0
  let holidayPoints = info.points
  let fullDays = 0
  let blankDays = 0
  let restDays = 0
  let makeupDays = 0
  let totalTasks = info.total
  let doneTasks = info.done

  const keys = Object.keys(data.history)
  keys.forEach(function (k) {
    const r = data.history[k]
    totalTasks += r.total || 0
    doneTasks += r.done || 0
    if (isFull(r)) {
      fullDays += 1
      totalFull += 1
    }
    if (r.makeup) makeupDays += 1
    if (r.rest) restDays += 1
    else if (!r.total) blankDays += 1
    holidayPoints += r.points || 0
  })

  return {
    streak: computeStreak(data),
    longestStreak: longestStreakOf(data),
    totalFull: totalFull,
    holidayPoints: holidayPoints,
    recordedDays: keys.length,
    fullDays: fullDays,
    blankDays: blankDays,
    restDays: restDays,
    makeupDays: makeupDays,
    totalTasks: totalTasks,
    doneTasks: doneTasks,
    rate: totalTasks ? Math.round((doneTasks / totalTasks) * 100) : 0
  }
}

/** 检查并记录里程碑解锁时间 */
function refreshUnlocked(data) {
  const a = data.achievements
  const d = derived(data)
  const today = data.today
  Object.keys(MILESTONES).forEach(function (type) {
    MILESTONES[type].forEach(function (m) {
      const key = type + m
      if (d[type] >= m && !a.unlocked[key]) a.unlocked[key] = today
    })
  })
  return a.unlocked
}

/* ---------------- 读写 ---------------- */

/** 一个账号的全部数据。多个账号之间完全独立（任务、历史、假期、成就各一份）。 */
function emptyAccount(name) {
  const today = dateUtil.logicalKey(DEFAULTS.dayStartHour)
  return {
    id: 'a' + Date.now().toString(36) + (seq++),
    profile: { name: String(name == null ? '' : name).trim().slice(0, 12), since: today },
    today: today,
    dayStartHour: DEFAULTS.dayStartHour,
    minTasks: DEFAULTS.minTasks,
    maxCards: DEFAULTS.maxCards,
    tasks: padToMin([], DEFAULTS.minTasks),
    history: {},
    customHolidays: [],
    makeupCards: 0,
    makeupUsed: 0,
    lastGrantStreak: 0,
    achievements: {
      startDate: today,
      unlocked: {}
    }
  }
}

function defaultContainer() {
  const acc = emptyAccount('')
  return { version: 4, activeId: acc.id, accounts: [acc] }
}

/** 把一份（可能是老版本的）账号数据补齐字段 */
function migrateAccount(raw) {
  const base = emptyAccount('')
  const out = raw && typeof raw === 'object' ? raw : base

  if (typeof out.id !== 'string' || !out.id) out.id = base.id
  if (!Array.isArray(out.tasks)) out.tasks = base.tasks
  if (typeof out.dayStartHour !== 'number' || out.dayStartHour < 0 || out.dayStartHour > 23) {
    out.dayStartHour = DEFAULTS.dayStartHour
  }
  if (typeof out.minTasks !== 'number' || out.minTasks < 1) out.minTasks = DEFAULTS.minTasks
  if (typeof out.maxCards !== 'number' || out.maxCards < 1) out.maxCards = DEFAULTS.maxCards
  // 空数组也要补足 —— 只判 !Array.isArray 会让 tasks: [] 一条任务都不显示
  out.tasks = padToMin(out.tasks, out.minTasks)
  if (!out.history || typeof out.history !== 'object') out.history = {}
  if (!Array.isArray(out.customHolidays)) out.customHolidays = []
  if (typeof out.makeupCards !== 'number') out.makeupCards = 0
  if (typeof out.makeupUsed !== 'number') out.makeupUsed = 0
  if (typeof out.lastGrantStreak !== 'number') out.lastGrantStreak = 0
  if (!out.profile || typeof out.profile !== 'object') out.profile = { name: '', since: out.today || dateUtil.todayKey() }
  if (typeof out.profile.name !== 'string') out.profile.name = ''
  if (!out.profile.since) out.profile.since = out.today || dateUtil.todayKey()
  if (typeof out.profile.skipped !== 'boolean') out.profile.skipped = false
  if (!out.today) out.today = dateUtil.logicalKey(out.dayStartHour)

  // v2 的 achievements 是累加器，v3 起改成派生 + 解锁时间戳
  const oldAch = out.achievements || {}
  out.achievements = {
    startDate: oldAch.startDate || out.today,
    unlocked: oldAch.unlocked && typeof oldAch.unlocked === 'object' ? oldAch.unlocked : {}
  }

  // 老记录补齐新字段
  Object.keys(out.history).forEach(function (k) {
    const r = out.history[k]
    if (!r) return
    if (typeof r.rest !== 'boolean') {
      const h = holidays.find(k, out.customHolidays)
      r.rest = !!h
      r.restName = h ? h.name : ''
    }
    if (typeof r.makeup !== 'boolean') r.makeup = false
    if (typeof r.points !== 'number') r.points = 0
  })

  return out
}

function readRaw() {
  try {
    return wx.getStorageSync(STORAGE_KEY) || null
  } catch (e) {
    return null
  }
}

/**
 * 把存储里的原始内容整理成容器。
 * 没有可用数据时返回 null —— 这点很关键：如果这里直接造一个默认容器，
 * save() 时会因为 id 对不上而凭空多出一个账号。
 */
function buildContainer(raw) {
  if (raw && typeof raw === 'object' && Array.isArray(raw.accounts) && raw.accounts.length) {
    const accounts = raw.accounts.map(migrateAccount)
    const activeId = accounts.some(function (a) { return a.id === raw.activeId })
      ? raw.activeId
      : accounts[0].id
    return { version: 4, activeId: activeId, accounts: accounts }
  }

  // 老版本：整个对象就是一个账号
  if (raw && typeof raw === 'object' && (raw.tasks || raw.history)) {
    const acc = migrateAccount(raw)
    return { version: 4, activeId: acc.id, accounts: [acc] }
  }

  return null
}

function loadContainer() {
  return buildContainer(readRaw()) || defaultContainer()
}

function writeContainer(container) {
  try {
    wx.setStorageSync(STORAGE_KEY, container)
  } catch (e) {
    // 存储失败不阻塞界面
  }
}

/** 取当前账号的数据。页面代码只跟它打交道，不用关心多账号。 */
function load() {
  const c = loadContainer()
  return c.accounts.filter(function (a) { return a.id === c.activeId })[0] || c.accounts[0]
}

/** 把当前账号写回容器 */
function save(account) {
  const c = buildContainer(readRaw()) || { version: 4, activeId: account.id, accounts: [account] }
  let found = false
  c.accounts = c.accounts.map(function (a) {
    if (a.id === account.id) {
      found = true
      return account
    }
    return a
  })
  if (!found) c.accounts.push(account)
  c.activeId = account.id
  writeContainer(c)
}

/* ---------------- 账号 ---------------- */

const MAX_ACCOUNTS = 8

function listAccounts() {
  const c = loadContainer()
  return c.accounts.map(function (a) {
    const name = a.profile.name || ''
    return {
      id: a.id,
      name: name || '未命名',
      rawName: name,
      initial: name ? name.slice(0, 1) : '?',
      active: a.id === c.activeId,
      since: a.profile.since
    }
  })
}

function activeAccountId() {
  return loadContainer().activeId
}

function switchAccount(id) {
  const c = loadContainer()
  if (!c.accounts.some(function (a) { return a.id === id })) {
    return { ok: false, msg: '账号不存在' }
  }
  c.activeId = id
  writeContainer(c)
  return { ok: true }
}

function addAccount(name) {
  const c = loadContainer()
  if (c.accounts.length >= MAX_ACCOUNTS) {
    return { ok: false, msg: '最多 ' + MAX_ACCOUNTS + ' 个账号' }
  }
  const acc = emptyAccount(name)
  c.accounts.push(acc)
  c.activeId = acc.id
  writeContainer(c)
  return { ok: true, id: acc.id }
}

function removeAccount(id) {
  const c = loadContainer()
  if (c.accounts.length <= 1) {
    return { ok: false, msg: '至少要留一个账号' }
  }
  c.accounts = c.accounts.filter(function (a) { return a.id !== id })
  if (c.activeId === id) c.activeId = c.accounts[0].id
  writeContainer(c)
  return { ok: true }
}

function renameAccount(id, name) {
  const c = loadContainer()
  const acc = c.accounts.filter(function (a) { return a.id === id })[0]
  if (!acc) return { ok: false, msg: '账号不存在' }
  const n = String(name == null ? '' : name).trim().slice(0, 12)
  if (!n) return { ok: false, msg: '名字不能为空' }
  acc.profile.name = n
  // 已经有名字了，跳过标记就没意义了，复位掉
  acc.profile.skipped = false
  writeContainer(c)
  return { ok: true }
}

/** 结算补签卡：每连续 CARDS_PER 天发一张，断了就重置水位 */
function settleCards(data, key) {
  const st = streakEndingAt(data, key)
  if (st === 0) {
    data.lastGrantStreak = 0
  } else if (st % CARDS_PER === 0 && st > data.lastGrantStreak) {
    data.lastGrantStreak = st
    if (data.makeupCards < data.maxCards) data.makeupCards += 1
  }
}

/**
 * 跨天处理：
 * 1. 最后活跃那天归档（写了内容存内容，没写也留一条记录）
 * 2. 中间没打开的日子补记录（落在假期区间里的自动标成假期）
 * 3. 逐日结算补签卡
 * 4. 清空任务栏，补足 3 个空位
 */
function rollover(data) {
  const today = dateUtil.logicalKey(data.dayStartHour)

  if (data.today !== today) {
    const lastActive = data.today

    archive(data, lastActive, data.tasks)
    settleCards(data, lastActive)

    const floor = dateUtil.shiftKey(today, -MAX_GAP_DAYS)
    let cursor = dateUtil.shiftKey(lastActive, 1)
    if (cursor < floor) cursor = floor

    let guard = 0
    while (cursor < today && guard <= MAX_GAP_DAYS) {
      guard += 1
      if (!data.history[cursor]) {
        archive(data, cursor, [])
        settleCards(data, cursor)
      }
      cursor = dateUtil.shiftKey(cursor, 1)
    }

    data.today = today
    data.tasks = padToMin([], data.minTasks)
  }

  // 兜底：无论哪条路径进来，任务栏都必须至少有 minTasks 个位置
  data.tasks = padToMin(data.tasks, data.minTasks)
  refreshUnlocked(data)
  return data
}

function init() {
  const data = rollover(load())
  save(data)
  return data
}

/* ---------------- 假期 ---------------- */

function todayInfo(data) {
  const h = holidays.find(data.today, data.customHolidays)
  const filled = filledTasks(data.tasks)
  const total = filled.length
  const done = filled.filter(function (t) { return t.done }).length
  return {
    rest: !!h,
    restName: h ? h.name : '',
    builtIn: h ? h.builtIn : false,
    points: holidays.pointsFor(total, done, !!h),
    total: total,
    done: done
  }
}

function addHoliday(data, name, start, end) {
  if (!start || !end) return { ok: false, msg: '请选择起止日期' }
  if (start > end) return { ok: false, msg: '结束日期不能早于开始' }
  if (start < data.today) return { ok: false, msg: '只能标记今天及以后' }

  const item = {
    id: 'h' + newId(),
    name: (name || '').trim().slice(0, 8) || '假期',
    start: start,
    end: end,
    createdAt: Date.now()
  }
  data.customHolidays.push(item)
  data.customHolidays.sort(function (a, b) {
    return a.start < b.start ? -1 : 1
  })
  return { ok: true, item: item }
}

function removeHoliday(data, id) {
  data.customHolidays = data.customHolidays.filter(function (h) {
    return h.id !== id
  })
  return { ok: true }
}

function holidayDays(start, end) {
  const a = dateUtil.parseKey(start)
  const b = dateUtil.parseKey(end)
  return Math.round((b - a) / 86400000) + 1
}

/* ---------------- 补签 ---------------- */

function makeup(data, key) {
  if (data.makeupCards <= 0) return { ok: false, msg: '没有补签卡' }

  const rec = data.history[key]
  if (!rec) return { ok: false, msg: '这天没有记录' }
  if (rec.rest) return { ok: false, msg: '假期不用补签' }
  if (rec.makeup) return { ok: false, msg: '这天已经补过了' }
  if (isFull(rec)) return { ok: false, msg: '这天本来就是全勤' }

  const today = data.today
  const floor = dateUtil.shiftKey(today, -MAKEUP_WINDOW)
  if (key < floor || key > today) {
    return { ok: false, msg: '只能补最近 ' + MAKEUP_WINDOW + ' 天' }
  }

  rec.makeup = true
  rec.makeupAt = Date.now()
  data.makeupCards -= 1
  data.makeupUsed += 1

  refreshUnlocked(data)
  return { ok: true }
}

/**
 * 取某天的完整记录。
 * 今天还没归档，所以用当前任务实时算出来，其余日子直接读 history。
 * 没有记录返回 null。
 */
function dayRecord(data, key) {
  if (key === data.today) {
    const filled = filledTasks(data.tasks)
    const h = holidays.find(key, data.customHolidays)
    const total = filled.length
    const done = filled.filter(function (t) {
      return t.done
    }).length
    return {
      date: key,
      tasks: filled.map(function (t) {
        return { text: t.text.trim(), done: !!t.done }
      }),
      total: total,
      done: done,
      rest: !!h,
      restName: h ? h.name : '',
      makeup: false,
      points: holidays.pointsFor(total, done, !!h),
      live: true
    }
  }
  return data.history[key] || null
}

/** 最近 n 天里可以补签的日期（倒序） */
function makeupCandidates(data, n) {
  const out = []
  const limit = n || MAKEUP_WINDOW
  for (let i = 1; i <= limit; i++) {
    const key = dateUtil.shiftKey(data.today, -i)
    const r = data.history[key]
    if (!r || r.rest || r.makeup || isFull(r)) continue
    out.push(key)
  }
  return out
}

/* ---------------- 设置 ---------------- */

/** 取整并夹到 [min, max]；不是数字才用 fallback（注意 0 是合法值，不能用 || 兜底） */
function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (isNaN(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

/**
 * 改「每天几点算新的一天」。
 * 往后挪边界（比如 0 点 -> 4 点，而现在是凌晨 2 点）会让逻辑日期回退一天，
 * 这时候不能走归档逻辑，否则会把正在写的任务塞进"明天"。
 */
function setDayStartHour(data, hour) {
  data.dayStartHour = clampInt(hour, 0, 23, DEFAULTS.dayStartHour)

  const next = dateUtil.logicalKey(data.dayStartHour)
  if (next < data.today) {
    data.today = next
  }
  return data
}

function setMinTasks(data, n) {
  data.minTasks = clampInt(n, 1, 10, DEFAULTS.minTasks)
  data.tasks = padToMin(data.tasks, data.minTasks)
  return data
}

function setMaxCards(data, n) {
  data.maxCards = clampInt(n, 1, 10, DEFAULTS.maxCards)
  if (data.makeupCards > data.maxCards) data.makeupCards = data.maxCards
  return data
}

/** 只存一个名字，不做账号密码 */
function setProfileName(data, name) {
  const n = String(name == null ? '' : name).trim().slice(0, 12)
  if (!data.profile || typeof data.profile !== 'object') {
    data.profile = { name: '', since: data.today }
  }
  data.profile.name = n
  if (!data.profile.since) data.profile.since = data.today
  data.profile.skipped = false
  return data
}

/**
 * 跳过起名引导。
 * 首屏那个起名弹窗必须能被跳过 —— 审核员打开小程序时如果被弹窗挡住、进不去，
 * 有可能被判定"功能无法正常使用"。跳过后随时可以在设置里补名字。
 */
function skipProfileName(data) {
  if (!data.profile || typeof data.profile !== 'object') {
    data.profile = { name: '', since: data.today }
  }
  data.profile.skipped = true
  return data
}

/* ---------------- 统计 ---------------- */

function stats(data) {
  const d = derived(data)
  d.makeupCards = data.makeupCards
  d.makeupUsed = data.makeupUsed
  d.unlocked = data.achievements.unlocked
  d.startDate = data.achievements.startDate
  d.customHolidays = data.customHolidays
  d.dayStartHour = data.dayStartHour
  d.minTasks = data.minTasks
  d.maxCards = data.maxCards
  d.lateNight = dateUtil.isLateNight(data.dayStartHour)
  return d
}

function reset() {
  const c = defaultContainer()
  writeContainer(c)
  return c.accounts[0]
}

module.exports = {
  STORAGE_KEY,
  DEFAULTS,
  MIN_TASKS,
  MAX_GAP_DAYS,
  CARDS_PER,
  MAX_CARDS,
  MAKEUP_WINDOW,
  MAX_ACCOUNTS,
  MILESTONES,
  MILESTONE_LABEL,
  newId,
  blankTask,
  padToMin,
  filledTasks,
  isFull,
  archive,
  streakEndingAt,
  computeStreak,
  longestStreakOf,
  derived,
  refreshUnlocked,
  emptyAccount,
  loadContainer,
  load,
  save,
  init,
  rollover,
  todayInfo,
  dayRecord,
  addHoliday,
  removeHoliday,
  holidayDays,
  makeup,
  makeupCandidates,
  setDayStartHour,
  setMinTasks,
  setMaxCards,
  setProfileName,
  skipProfileName,
  listAccounts,
  activeAccountId,
  switchAccount,
  addAccount,
  removeAccount,
  renameAccount,
  stats,
  reset
}
