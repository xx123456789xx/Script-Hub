'use strict'
/*
 * Script Hub Web Service
 * ----------------------
 * 把 Script Hub 的四个 Surge 脚本（script-hub.js 前端 / Rewrite-Parser.js /
 * rule-parser.js / script-converter.js）放进 Node 的 vm 里、以打桩的 Surge
 * 全局环境运行，对外提供真实 HTTP 服务。纯 Node 内置模块，零 npm 依赖。
 *
 * 适配方式（与上游自带 service.js 的思路一致，本实现不依赖 Koa/lodash）：
 *  - $request.url 永远重建为 http://script.hub<原始路径+查询>，脚本内部所有
 *    对 script.hub 的判断/解析逻辑与在 Surge 里完全一致；
 *  - 脚本返回的响应 body 中出现的 http(s)://script.hub/ 统一替换为本次请求
 *    的真实 base（PUBLIC_BASE_URL 环境变量 > x-forwarded-proto + Host >
 *    http + Host），于是前端页面里写死的 baseUrl（script-hub.js 中
 *    `baseUrl: 'http://script.hub/'`）生成的转换链接自动指向真实域名。
 *
 * fork 的四个脚本文件本身不做任何改动，更新时重新复制即可（见 README）。
 */

const http = require('http')
const https = require('https')
const vm = require('vm')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const PORT = Number(process.env.PORT || 8082)
const HOST = process.env.HOST || '0.0.0.0'
const SCRIPT_DIR = path.join(__dirname, 'scripts')
const SCRIPT_TIMEOUT_MS = 60_000 // 单次请求等待 $done 的总超时
const SYNC_TIMEOUT_MS = 30_000 // vm 顶层同步执行超时（防同步死循环卡死事件循环）
const FETCH_TIMEOUT_MS = 20_000 // $httpClient 单次抓取超时上限
const MAX_REDIRECTS = 5

const SCRIPTS = {
  hub: loadScript('script-hub.js'),
  rewrite: loadScript('Rewrite-Parser.js'),
  rule: loadScript('rule-parser.js'),
  convert: loadScript('script-converter.js'),
}

function loadScript(name) {
  const file = path.join(SCRIPT_DIR, name)
  return { name, source: fs.readFileSync(file, 'utf8') }
}

function log(...args) {
  console.log(new Date().toISOString(), ...args)
}

/* ---------------- $persistentStore：进程级共享内存 Map ---------------- */
/* 键冲突风险：四个脚本共用一个命名空间（与 Surge 里共用同一存储一致），可接受。 */
const persistentStore = new Map()

/* ---------------- $httpClient：真实 HTTP 抓取 ---------------- */
function resolveTimeoutMs(raw) {
  const t = Number(raw)
  if (!t || Number.isNaN(t)) return FETCH_TIMEOUT_MS
  const ms = t > 120 ? t : t * 1000 // >120 视为毫秒，否则视为秒
  return Math.max(1000, Math.min(ms, FETCH_TIMEOUT_MS))
}

function httpFetch(method, opts, cb) {
  const o = typeof opts === 'string' ? { url: opts } : { ...(opts || {}) }
  let called = false
  const done = (err, resp, body) => {
    if (!called) {
      called = true
      cb(err, resp, body)
    }
  }

  let startUrl
  try {
    startUrl = new URL(o.url)
  } catch (e) {
    return done(new Error(`invalid url: ${o.url}`))
  }

  const headers = { ...(o.headers || {}) }
  const hasHeader = name => Object.keys(headers).some(k => k.toLowerCase() === name)
  if (!hasHeader('user-agent')) {
    headers['User-Agent'] =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1'
  }
  if (!hasHeader('accept-encoding')) headers['Accept-Encoding'] = 'gzip, deflate'

  let bodyBuf = null
  if (method === 'POST' && o.body != null) {
    bodyBuf = Buffer.isBuffer(o.body) ? o.body : Buffer.from(String(o.body), 'utf8')
    if (!hasHeader('content-length')) headers['Content-Length'] = String(bodyBuf.length)
  }

  const attempt = (url, verb, payload, redirectsLeft) => {
    const lib = url.protocol === 'https:' ? https : http
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: verb,
        headers,
      },
      res => {
        const status = res.statusCode || 0
        const location = res.headers.location
        if ([301, 302, 303, 307, 308].includes(status) && location && redirectsLeft > 0) {
          res.resume()
          let next
          try {
            next = new URL(location, url)
          } catch (e) {
            return done(new Error(`bad redirect location: ${location}`))
          }
          const keepBody = status === 307 || status === 308
          return attempt(next, keepBody ? verb : 'GET', keepBody ? payload : null, redirectsLeft - 1)
        }
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => {
          let buf = Buffer.concat(chunks)
          const enc = String(res.headers['content-encoding'] || '').toLowerCase()
          try {
            if (enc === 'gzip') buf = zlib.gunzipSync(buf)
            else if (enc === 'deflate') buf = zlib.inflateSync(buf)
          } catch (e) {
            /* 解压失败就用原始字节 */
          }
          const text = buf.toString('utf8')
          const resp = { statusCode: status, status, headers: res.headers, body: text }
          done(null, resp, text)
        })
        res.on('error', err => done(err instanceof Error ? err : new Error(String(err))))
      }
    )
    req.setTimeout(resolveTimeoutMs(o.timeout), () => {
      req.destroy(new Error(`fetch timeout: ${url.href}`))
    })
    req.on('error', err => done(err instanceof Error ? err : new Error(String(err))))
    if (payload) req.write(payload)
    req.end()
  }

  attempt(startUrl, method, bodyBuf, MAX_REDIRECTS)
}

/* ---------------- 在 vm 里运行一个脚本，等待 $done ---------------- */
function runScript(script, scriptUrl, req) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn, val) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        fn(val)
      }
    }
    const timer = setTimeout(
      () => finish(reject, new Error(`script ${script.name} did not call $done within ${SCRIPT_TIMEOUT_MS / 1000}s`)),
      SCRIPT_TIMEOUT_MS
    )

    const tag = `[${script.name}]`
    const scriptConsole = {
      log: (...a) => log(tag, ...a),
      info: (...a) => log(tag, ...a),
      warn: (...a) => log(tag, 'WARN', ...a),
      error: (...a) => log(tag, 'ERROR', ...a),
    }

    const sandbox = {
      console: scriptConsole,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      $environment: { 'surge-version': '5.20.0' },
      $request: { url: scriptUrl, method: req.method, headers: req.headers },
      $persistentStore: {
        read: key => (persistentStore.has(key) ? persistentStore.get(key) : null),
        write: (value, key) => {
          persistentStore.set(key, value)
          return true
        },
      },
      $notification: {
        post: (...a) =>
          log('[notification]', ...a.map(x => (typeof x === 'string' ? x : JSON.stringify(x)))),
      },
      $httpClient: {
        get: (opts, cb) => httpFetch('GET', opts, cb),
        post: (opts, cb) => httpFetch('POST', opts, cb),
      },
      // script-hub.js 的个别路径会调 $httpAPI（Surge 内部 API），Web 服务里不支持，回调报错即可
      $httpAPI: (method, p, body, cb) => {
        log('[httpAPI unsupported]', method, p)
        if (typeof cb === 'function') cb({ error: 'not supported in script-hub-web' })
      },
      $done: result => finish(resolve, result ?? {}),
    }

    vm.createContext(sandbox)
    try {
      vm.runInContext(script.source, sandbox, { filename: script.name, timeout: SYNC_TIMEOUT_MS })
    } catch (e) {
      finish(reject, e)
    }
  })
}

/* ---------------- $done 结果 -> HTTP 响应 ---------------- */
function toHttpResponse(result) {
  if (result && typeof result === 'object') {
    const r = result.response && typeof result.response === 'object' ? result.response : result
    if (r && typeof r === 'object' && ('body' in r || 'status' in r || 'headers' in r)) {
      return { status: Number(r.status) || 200, headers: r.headers || {}, body: r.body ?? '' }
    }
  }
  if (typeof result === 'string') return { status: 200, headers: {}, body: result }
  return { status: 200, headers: {}, body: '' }
}

function realBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '')
  const proto = req.headers['x-forwarded-proto'] || 'http'
  const host = req.headers.host || `127.0.0.1:${PORT}`
  return `${proto}://${host}`
}

/* ---------------- 路由：与 Script-Hub-Ring.sgmodule 的 [Script] pattern 对齐 ---------------- */
const RE_FRONTEND = /^https?:\/\/script\.hub\/($|edit\/|reload)/
const RE_CONVERT = /^https?:\/\/script\.hub\/convert\//
const RE_FILE = /^https?:\/\/script\.hub\/file\/_start_\//

function pickScript(scriptUrl) {
  if (RE_FRONTEND.test(scriptUrl)) return SCRIPTS.hub
  if (RE_CONVERT.test(scriptUrl)) return SCRIPTS.convert
  if (RE_FILE.test(scriptUrl)) {
    return /[?&]type=rule-set(?:&|$)/.test(scriptUrl) ? SCRIPTS.rule : SCRIPTS.rewrite
  }
  return null
}

const server = http.createServer(async (req, res) => {
  const rawUrl = req.url || '/'
  if (rawUrl === '/favicon.ico') {
    res.writeHead(204)
    return res.end()
  }
  const scriptUrl = `http://script.hub${rawUrl}`
  const script = pickScript(scriptUrl)
  if (!script) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    return res.end('Not Found: no Script Hub route for ' + rawUrl)
  }

  const started = Date.now()
  try {
    const result = await runScript(script, scriptUrl, req)
    let { status, headers, body } = toHttpResponse(result)

    if (Buffer.isBuffer(body)) {
      // 透传二进制
    } else if (typeof body !== 'string') {
      body = body == null ? '' : JSON.stringify(body)
    }
    if (typeof body === 'string') {
      body = body.replace(/https?:\/\/script\.hub\//g, realBaseUrl(req) + '/')
    }

    const outHeaders = {}
    for (const [k, v] of Object.entries(headers || {})) {
      const lk = k.toLowerCase()
      if (lk === 'content-length' || lk === 'content-encoding' || lk === 'transfer-encoding') continue
      outHeaders[k] = v
    }
    if (!Object.keys(outHeaders).some(k => k.toLowerCase() === 'content-type')) {
      outHeaders['Content-Type'] = 'text/plain; charset=utf-8'
    }
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
    outHeaders['Content-Length'] = String(payload.length)
    res.writeHead(status, outHeaders)
    res.end(payload)
    log(`${req.method} ${rawUrl} -> ${script.name} ${status} (${Date.now() - started}ms)`)
  } catch (e) {
    const timeout = /did not call \$done/.test(e.message)
    log(`ERROR ${req.method} ${rawUrl} -> ${script.name}: ${e.stack || e}`)
    res.writeHead(timeout ? 504 : 500, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(`Script Hub web service error: ${e.message}`)
  }
})

server.listen(PORT, HOST, () => {
  log(`script-hub-web listening on http://${HOST}:${PORT} (PUBLIC_BASE_URL=${process.env.PUBLIC_BASE_URL || '(auto from Host header)'})`)
})
