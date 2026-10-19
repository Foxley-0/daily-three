#!/usr/bin/env node
/**
 * 提交前检查
 *
 * 目标只有一个：**不让跑不通的代码进 main**。
 * 由 .githooks/pre-commit 调用，也可以手动跑：
 *   node scripts/check.js
 *
 * 检查项：
 *   1. 所有 .js 的语法
 *   2. WXML 里绑定的事件处理函数，在对应 JS 里是否存在
 *   3. WXML 用到的类名，在对应 WXSS 或 app.wxss 里是否定义
 *   4. 页面用到的 store.* API，是否在 store.js 里导出
 *   5. 有没有把密钥 / token 提交进来
 *   6. 小程序打包体积
 */

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const APP = path.join(ROOT, 'miniprogram')

let failed = 0
const problems = []

function fail(msg) {
  failed += 1
  problems.push(msg)
}

function walk(dir, ext, out) {
  out = out || []
  if (!fs.existsSync(dir)) return out
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') return
      walk(full, ext, out)
    } else if (e.name.endsWith(ext)) {
      out.push(full)
    }
  })
  return out
}

/* ---------- 1. 语法 ---------- */
walk(ROOT, '.js').forEach(function (f) {
  // scripts/ 自己是检查器，不用查
  if (f.indexOf(path.join(ROOT, 'scripts')) === 0) return
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' })
  } catch (e) {
    fail('语法错误: ' + path.relative(ROOT, f))
  }
})

/* ---------- 2~4. 小程序结构 ---------- */
const appJsonPath = path.join(APP, 'app.json')
if (!fs.existsSync(appJsonPath)) {
  fail('找不到 miniprogram/app.json')
} else {
  const app = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'))
  const pages = app.pages.concat(['custom-tab-bar/index'])

  // 事件处理函数
  const handlersOf = function (src) {
    const set = new Set()
    const re = /\b(?:bind|catch|capture-bind|capture-catch)[:a-zA-Z]*\s*=\s*"([^"{}]+)"/g
    let m
    while ((m = re.exec(src))) set.add(m[1].trim())
    return Array.from(set)
  }
  const methodsOf = function (src) {
    const set = new Set()
    const re = /^\s+([a-zA-Z_$][\w$]*)\s*\(/gm
    let m
    while ((m = re.exec(src))) set.add(m[1])
    return Array.from(set)
  }

  pages.forEach(function (p) {
    const wxmlPath = path.join(APP, p + '.wxml')
    const jsPath = path.join(APP, p + '.js')
    if (!fs.existsSync(wxmlPath) || !fs.existsSync(jsPath)) {
      fail('缺文件: ' + p)
      return
    }
    const methods = methodsOf(fs.readFileSync(jsPath, 'utf8'))
    handlersOf(fs.readFileSync(wxmlPath, 'utf8')).forEach(function (h) {
      if (methods.indexOf(h) < 0) fail(p + ' 绑定了不存在的方法: ' + h)
    })
  })

  // 类名
  const classesInWxml = function (src) {
    const set = new Set()
    const re = /(?:hover-)?class\s*=\s*"([^"]*)"/g
    let m
    while ((m = re.exec(src))) {
      const raw = m[1]
      raw.replace(/\{\{[\s\S]*?\}\}/g, ' ').split(/\s+/).forEach(function (t) {
        if (t && /^[a-zA-Z][\w-]*$/.test(t) && !/-$/.test(t)) set.add(t)
      })
      ;(raw.match(/\{\{[\s\S]*?\}\}/g) || []).forEach(function (expr) {
        ;(expr.match(/'([a-zA-Z][\w-]*)'/g) || []).forEach(function (q) {
          const v = q.replace(/'/g, '')
          if (!/-$/.test(v)) set.add(v)
        })
      })
    }
    return Array.from(set)
  }
  const classesInWxss = function (src) {
    const set = new Set()
    const re = /\.([a-zA-Z][\w-]*)/g
    let m
    while ((m = re.exec(src))) set.add(m[1])
    return set
  }

  const globalWxss = path.join(APP, 'app.wxss')
  const globalClasses = fs.existsSync(globalWxss) ? classesInWxss(fs.readFileSync(globalWxss, 'utf8')) : new Set()

  pages.forEach(function (p) {
    const wxmlPath = path.join(APP, p + '.wxml')
    const wxssPath = path.join(APP, p + '.wxss')
    if (!fs.existsSync(wxmlPath)) return
    const own = fs.existsSync(wxssPath) ? classesInWxss(fs.readFileSync(wxssPath, 'utf8')) : new Set()
    classesInWxml(fs.readFileSync(wxmlPath, 'utf8')).forEach(function (c) {
      if (!own.has(c) && !globalClasses.has(c)) fail(p + ' 用了没定义的类名: .' + c)
    })
  })

  // store API
  const storePath = path.join(APP, 'utils', 'store.js')
  if (fs.existsSync(storePath)) {
    const storeSrc = fs.readFileSync(storePath, 'utf8')
    const expBlock = storeSrc.slice(storeSrc.indexOf('module.exports'))
    const exported = new Set()
    expBlock.replace(/^\s*([A-Za-z_$][\w$]*)\s*[,:]/gm, function (_, n) {
      exported.add(n)
      return ''
    })
    const used = new Set()
    pages.concat(['app']).forEach(function (p) {
      const jsPath = path.join(APP, p + '.js')
      if (!fs.existsSync(jsPath)) return
      const re = /\bstore\.([A-Za-z_$][\w$]*)/g
      let m
      const src = fs.readFileSync(jsPath, 'utf8')
      while ((m = re.exec(src))) used.add(m[1])
    })
    used.forEach(function (u) {
      if (!exported.has(u)) fail('store 没有导出: ' + u)
    })
  }
}

/* ---------- 5. 密钥泄漏 ---------- */
const SECRET_PATTERNS = [
  { re: /appsecret\s*[:=]\s*["'][0-9a-f]{32}["']/i, name: 'AppSecret 明文' },
  { re: /gh[pousr]_[A-Za-z0-9]{36,}/, name: 'GitHub Token' },
  { re: /sk-[A-Za-z0-9]{20,}/, name: 'API Key（sk- 开头）' },
  { re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, name: '私钥' }
]
walk(ROOT, '.js').forEach(function (f) {
  if (f.indexOf(path.join(ROOT, 'scripts')) === 0) return
  const src = fs.readFileSync(f, 'utf8')
  SECRET_PATTERNS.forEach(function (p) {
    if (p.re.test(src)) fail('疑似' + p.name + '泄漏: ' + path.relative(ROOT, f))
  })
})

/* ---------- 6. 打包体积 ---------- */
function dirSize(dir) {
  let total = 0
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()
    if (!fs.existsSync(d)) continue
    fs.readdirSync(d, { withFileTypes: true }).forEach(function (e) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git') return
        // preview 已在 packOptions.ignore 里，不算进包体
        if (e.name === 'preview') return
        stack.push(full)
      } else {
        total += fs.statSync(full).size
      }
    })
  }
  return total
}
const size = dirSize(APP)
if (size > 2 * 1024 * 1024) {
  fail('小程序包超过 2MB（当前 ' + (size / 1024).toFixed(0) + ' KB）')
}

/* ---------- 输出 ---------- */
if (failed) {
  console.log('')
  console.log('✗ 检查没通过（' + failed + ' 项）：')
  problems.forEach(function (p) {
    console.log('   · ' + p)
  })
  console.log('')
  console.log('  修完再提交。确实要跳过：git commit --no-verify')
  console.log('')
  process.exit(1)
}

console.log('✓ 检查通过（包体 ' + (size / 1024).toFixed(0) + ' KB）')
