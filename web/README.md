# Script Hub Web Service

把 Script Hub 的四个 Surge 脚本搬到 Node.js 里独立运行的 HTTP 服务。部署到任意有真实网址的机器后，用浏览器打开首页即可完成「Surge 模块 / Loon 插件 / QX 重写 → Ring 插件 / Surge 模块 / Egern 模块等」的转换，不再依赖 Surge 里的 script.hub 假域名。

## 架构

```
浏览器 ──HTTP──> server.js ──vm 沙箱(打桩 Surge 全局量)──> scripts/*.js
                     │
                     └─ $httpClient ──真实 HTTPS──> 源文件(GitHub 等)
```

- `server.js`：纯 Node 内置模块（http/https/vm/zlib），**零 npm 依赖**。每个请求新建一个 vm context 运行对应脚本，互不干扰；`$persistentStore` 用进程级共享 Map（四个脚本共用一个命名空间，与 Surge 里共用同一存储的行为一致，键冲突风险可接受）。
- `scripts/`：从 fork 仓库**原样复制**的四个脚本，未做任何改动：
  - `script-hub.js`（前端页面）
  - `Rewrite-Parser.js`（重写/模块转换，含 fork 新增的 `target=ring-plugin`）
  - `rule-parser.js`（规则集转换）
  - `script-converter.js`（脚本转换）
- 打桩环境与 `tests-local/harness.cjs` 同款：`$environment={'surge-version':'5.20.0'}`（让脚本内的 Env 判定为 Surge）、`$request`、`$httpClient`（真实抓取：跟随重定向 ≤5 次、自动解 gzip/deflate、超时上限 20s、无 UA 时补 iPhone Safari UA）、`$notification`（只记日志）、`$httpAPI`（不支持，回调报错）、`$done`（捕获后映射为 HTTP 响应）。单请求总超时 60s，超时返回 504；脚本抛错返回 500。

## 适配方案（script.hub → 真实域名）

前端查证结论：`script-hub.js` 里页面生成转换链接用的是**写死**的 `baseUrl: 'http://script.hub/'`（源码中基于 `location` 的写法已被注释掉），所有链接形如 `baseUrl + 'file/_start_/' + 源链接 + '/_end_/' + 文件名 + '?' + 参数`。

因此采用与上游自带 `service.js` 相同的两段式适配（本服务不改脚本文件）：

1. **入站**：无论真实 Host 是什么，喂给脚本的 `$request.url` 一律重建为 `http://script.hub<原始路径+查询>`，脚本内部所有解析逻辑与在 Surge 里完全一致；
2. **出站**：响应 body 中出现的 `http(s)://script.hub/` 统一替换为真实 base。真实 base 的确定顺序：环境变量 `PUBLIC_BASE_URL` > 请求头 `x-forwarded-proto` + `Host` > `http` + `Host`。

副作用说明：转换产物里若包含指回 Script Hub 的链接（如某些模块的脚本要经过 `/convert/` 再转换），在 Web 服务下会指向本服务的真实域名——这正是上游 service.js 的既定行为；产物在 Surge 里使用时同理指向 script.hub。

## 路由表

与 `Script-Hub-Ring.sgmodule` 的 `[Script]` pattern 对齐（按重建后的 script.hub URL 匹配）：

| 真实请求路径 | 脚本 | 说明 |
|---|---|---|
| `GET /`、`/edit/...`、`/reload` | script-hub.js | 前端页面 |
| `GET /file/_start_/<源链接>/_end_/<文件名>?type=rule-set&target=surge-rule-set 等` | rule-parser.js | 规则集转换（target 须为 `*-rule-set` / `*-domain-set` 家族，传 `surge-module` 会得到空 body，是上游既定行为） |
| `GET /file/_start_/...?type=surge-module\|loon-plugin\|qx-rewrite\|...&target=ring-plugin 等` | Rewrite-Parser.js | 重写/模块转换 |
| `GET /convert/_start_/<脚本链接>/_end_/<文件名>?type=...&target-app=...` | script-converter.js | 脚本转换 |
| 其它 | — | 404 |

## 运行

```sh
# 本地/服务器直接跑（默认端口 8082）
PORT=8082 node server.js

# 后台启动（幂等，重复执行不会多起一份）
./start.sh          # 或 PORT=8082 ./start.sh
# 日志在 server.log，pid 在 server.pid；停止：kill $(cat server.pid)
```

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8082` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `PUBLIC_BASE_URL` | 自动（请求头推导） | 对外公开网址，如 `https://8082-xxxx.instabox.tech`。经反代/隧道发布时建议显式设置，保证页面生成的链接正确 |

Node 版本：开发与验证环境为 v24.22.1；所用 API 均为长期稳定接口，Node ≥ 18 即可（InstaBox 上先 `node --version` 确认；其 Node 位于 `~/` 下的用户环境）。

## 部署到 InstaBox（备忘）

1. 把整个 `script-hub-web/` 目录传到机器上；
2. `PORT=8082 ./start.sh` 启动；
3. 在 InstaBox 面板 Ports 页发布 8082 端口（得到 `https://8082-<随机串>.instabox.tech/` 公开网址）；
4. 建议启动时带上 `PUBLIC_BASE_URL=https://8082-<随机串>.instabox.tech`，避免依赖请求头推导；
5. 注意免费机器的闲置暂停/单次运行时长规则：首次打开等唤醒属正常。

## 更新脚本

fork 那边脚本有更新时，只需重新复制四个文件覆盖 `scripts/`，重启服务即可：

```sh
cp <fork-work>/script-hub.js <fork-work>/Rewrite-Parser.js \
   <fork-work>/rule-parser.js <fork-work>/script-converter.js scripts/
kill $(cat server.pid) 2>/dev/null; ./start.sh
```

**不要直接改 `scripts/` 里的文件**——保持与 fork 仓库一致，改动应在 fork 侧完成（例如今早的引号转义修复与 `Rewrite-Parser.js?v=8e298ef6` 缓存绕过都是 fork 侧的事）。

## 已知边界

- 无账号/鉴权：靠 InstaBox 公开网址的随机子域名做隐蔽，仅限自用，勿公开传播链接。
- `$argument` 未注入（与本地 harness 基准一致）：模块里 `Notify=开启通知` 这类参数不影响转换产物本身，通知改为写服务日志。
- `/reload` 在 Surge 里是触发宿主重载的动作，Web 服务下只会返回脚本自带的提示页，无实际重载效果。
- 转换产物中的耗时行（`⏱ 请求耗时` 等）在 Surge 里走通知/日志，在本服务里进 `server.log`，不进响应 body（与 harness 把 stdout 混入文件不同，diff 时以 `# =====` 标记后正文为准）。
