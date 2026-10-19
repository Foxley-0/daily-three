#!/usr/bin/env node
/**
 * 生成 app/www
 *
 * 原则：**网页代码只有一份来源** —— `webapp/preview/index.html`。
 * 这个脚本负责把它搬进 www，并加上 APK 专属的东西。不要手改 www/ 里的文件。
 *
 * 做的事：
 *   1. 复制 webapp/preview/index.html → www/index.html
 *   2. 注入一段 CSS，把只在开发时用的东西藏起来（预览说明、调试按钮）
 *   3. 把 miniprogram/utils/reminder.js 包成浏览器版 → www/lib/reminder.js
 *   4. 复制 app/src/notify.js → www/notify.js
 *   5. 在 index.html 里引这两个脚本
 */

const fs = require('fs')
const path = require('path')

const APP = path.resolve(__dirname, '..')
const ROOT = path.resolve(APP, '..')
const SRC_HTML = path.join(ROOT, 'webapp', 'preview', 'index.html')
const SRC_REMINDER = path.join(ROOT, 'miniprogram', 'utils', 'reminder.js')
const SRC_NOTIFY = path.join(APP, 'src', 'notify.js')
const WWW = path.join(APP, 'www')

function mustExist(p, what) {
  if (!fs.existsSync(p)) {
    console.error('✗ 找不到' + what + '：' + p)
    process.exit(1)
  }
}

mustExist(SRC_HTML, '网页版 index.html')
mustExist(SRC_REMINDER, 'reminder.js')
mustExist(SRC_NOTIFY, 'notify.js')

// 清空 www，避免残留旧文件
if (fs.existsSync(WWW)) {
  fs.rmSync(WWW, { recursive: true, force: true })
}
fs.mkdirSync(path.join(WWW, 'lib'), { recursive: true })

/* ---------- 1. index.html ---------- */
let html = fs.readFileSync(SRC_HTML, 'utf8')

// 藏掉只有开发时用的东西
const injectCss = `
<style>
  /* APK 里不显示：预览说明条、调试按钮组 */
  .banner, .debug { display: none !important; }
  /* 底部让出系统导航条的高度 */
  body { padding-bottom: env(safe-area-inset-bottom); }
</style>
`
if (html.indexOf('</head>') >= 0) {
  html = html.replace('</head>', injectCss + '</head>')
} else {
  console.warn('⚠ 没找到 </head>，CSS 没注入')
}

// 引脚本
const injectJs = `
<script src="lib/reminder.js"></script>
<script src="notify.js"></script>
`
if (html.indexOf('</body>') >= 0) {
  html = html.replace('</body>', injectJs + '</body>')
} else {
  console.warn('⚠ 没找到 </body>，脚本没注入')
}

fs.writeFileSync(path.join(WWW, 'index.html'), html)

/* ---------- 2. reminder.js 转浏览器版 ---------- */
// 原文件是 CommonJS（module.exports），这里用一个假的 module 包起来，
// 执行完把导出挂到 window.Reminder。**不改原文件一个字。**
const reminderSrc = fs.readFileSync(SRC_REMINDER, 'utf8')
const reminderBrowser = `/* 由 app/scripts/prepare-www.js 自动生成，不要手改。
   来源：miniprogram/utils/reminder.js */
(function () {
  var module = { exports: {} }
  var exports = module.exports
${reminderSrc}
  window.Reminder = module.exports
})()
`
fs.writeFileSync(path.join(WWW, 'lib', 'reminder.js'), reminderBrowser)

/* ---------- 3. notify.js ---------- */
fs.copyFileSync(SRC_NOTIFY, path.join(WWW, 'notify.js'))

/* ---------- 报告 ---------- */
const kb = (p) => (fs.statSync(p).size / 1024).toFixed(1) + ' KB'
console.log('✓ www 生成完毕')
console.log('  index.html        ' + kb(path.join(WWW, 'index.html')))
console.log('  lib/reminder.js   ' + kb(path.join(WWW, 'lib', 'reminder.js')))
console.log('  notify.js         ' + kb(path.join(WWW, 'notify.js')))
