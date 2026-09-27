# Repository Audit — 2026-09-27

审计对象：`a25fb5e0bfa1ceba2051aa69d4d6f82684dc4e24`。审计开始时工作区干净。

初次审计结论：发现 **1 项 P1、5 项 P2**。当时自动化检查通过，但未覆盖下列故障场景。审计阶段仅新增报告，未修改应用代码，也未执行生产部署、远程 D1 操作、真实监控探测或通知。

**后续修复状态：R1–R6 已在工作区修复，19 个测试文件、253 项测试及类型检查通过。** 以下发现保留审计时证据；修复详情及兼容性限制见末尾。

## 发现

### R1 · P1 · HTTP 探测的跨域重定向泄露 Cookie 和自定义凭据头

- 位置：`src/monitor.ts:386–390`，相关公共请求路径 `src/probe.ts:116–119`。
- 条件：监控配置带有 `Cookie`、`X-Api-Key` 等敏感头，目标响应把请求重定向到其他域名。现有三个监控未配置这些请求头，不能据此断言当前生产凭据已泄露。
- 原因：HTTP 探测直接使用配置中的 headers，未指定重定向策略，也未在跨域跳转时剥离敏感头。`worker://` 探测最终复用同一实现。
- 实测：在本地 Miniflare/workerd、项目 compatibility date `2026-05-22` 下，用全虚构凭据访问 `origin.example`，返回 302 到 `sink.example`。第二个请求仍含 `Cookie: audit=dummy` 和 `X-Api-Key: audit-key`，探测结果为 UP。此运行时移除了 `Authorization`，因此本报告不把 Authorization 泄露列为已复现事实。所有出站请求由本地服务截获。
- 影响：开放重定向、目标被入侵或配置错误时，凭据会被发送到未经授权的目标。
- 建议：使用 `redirect: 'manual'`；显式限制跳转次数和目标，跨 origin 时移除凭据，或对带凭据探测拒绝跨域跳转。为同域、跨域和 HTTPS 降级添加运行时回归测试。同类策略也应检查 webhook 请求。
- 平台依据：[Cloudflare Request 的重定向说明](https://developers.cloudflare.com/workers/runtime-apis/request/#properties)。以本次运行时实测区分具体头部行为，不直接照搬文档中的全部头部结论。

### R2 · P2 · TCP 443 被解析为端口 0

- 位置：`src/monitor.ts:341–342`；Globalping TCP 构造也使用相同解析方式，见 `src/monitor.ts:201–207`。
- 条件：`method: 'TCP_PING'`、`target: 'service.example:443'`。
- 原因：`new URL('https://service.example:443').port` 返回空字符串，`Number('')` 为 0。
- 实测：调用真实 `getStatus()`，仅注入记录参数的 socket connector，实际参数为 `{ hostname: 'service.example', port: 0 }`，而非 443。
- 影响：本地与 `worker://` 的 TCP 443 监控连接到错误端口，产生误报；Globalping 分支还会得到空端口字符串。实际生产是否受影响取决于秘密绑定中的端口，本次未读取这些值。
- 建议：采用保留显式端口的 TCP 地址解析器，校验端口范围并处理 IPv6；覆盖 22、80、443、非标准端口和缺失端口。现有 TCP 测试虽使用 443，但未断言传给 connector 的地址。

### R3 · P2 · failureThreshold 在摘要、徽章与事件中含义不一致

- 位置：`src/api.ts:195–199`、`src/api.ts:323–324`、`src/run-monitoring.ts:348–360`。
- 条件：`failureThreshold > 1`。当前 HomeLab 已配置为 2。
- 原因：仅 `/api/data` 的 monitor summary 统计连续失败样本；状态机第一次失败即创建 incident，徽章仅查看 incident 是否未结束，通知仅受 gracePeriod 等策略约束。
- 实测：一次失败、阈值 2 时，数据接口显示 `up: true`，同一状态的徽章显示 `DOWN`，故障历史已有开放 incident。另一个省略 gracePeriod 的合法配置中，首次失败也产生 DOWN outbox event。当前配置有 5 分钟 gracePeriod，因此不能把后一种即时通知现象直接归于当前生产配置。
- 影响：同一服务在不同界面呈现相反状态；如果阈值用于抑制短暂抖动，故障历史、可用率统计和通知没有一致遵循它。
- 建议：明确并统一“原始探测结果”和“确认服务状态”的规则，复用同一状态判定；在同一序列中验证页面、徽章、历史和通知。如果产品只希望阈值影响摘要，必须明确命名和文档，并说明其他入口的差异。

### R4 · P2 · 合法的 Globalping TCP 小数延迟被当作连接失败

- 位置：`src/monitor.ts:162–166`、`src/monitor.ts:286–287`，整数校验来自 `src/probe.ts` 的 `isProbePing()`。
- 条件：使用 Globalping TCP，完成结果 `stats.avg` 为小数，例如 1.5 ms。当前三个监控未启用 Globalping。
- 原因：上游 RTT 是 number，但解析层直接应用 Uint16 存储的整数限制。
- 实测：上游模拟返回 `status: 'finished'` 和 `stats.avg: 1.5` 时，函数返回 `up: false` / `Connection failed`。
- 影响：成功的 TCP 探测被误报宕机。现有测试还把 1.5 与越界值 65536 放在同一组拒绝用例中，固定了错误假设。
- 建议：先验证有限、非负 RTT，再以明确的舍入策略转换为存储整数；继续拒绝非法和超范围值。
- 契约依据：[Globalping 官方 schema](https://github.com/jsdelivr/globalping/blob/master/public/v1/components/schemas.yaml) 的 `StatsRttAvgNullable` / `NullableNumber`。HTTP total 的 schema 为 integer，此发现针对 TCP RTT。

### R5 · P2 · Globalping 忽略 truncated，内容检查可能误判健康

- 位置：`src/monitor.ts:292–299`，`GlobalPingResult` 类型也没有声明 `truncated`。
- 条件：Globalping HTTP 配置了关键词检查，上游只返回截断的响应前缀。当前配置未启用此功能。
- 原因：代码只检查本地 `rawBody` 是否超过 65536 字节，却忽略上游已经截断的事实。Globalping 的 `rawBody` 只保留前 10 KB，并用 `truncated` 标记。
- 实测：模拟成功响应、`truncated: true`、`rawBody: 'safe prefix'`、禁用关键词 `error`，返回 `OK`，而非 `Content check inconclusive`。关键词可能存在于未返回部分，当前结果无法证明它不存在。
- 影响：禁用关键词检查可能漏报；必需关键词位于截断部分时则可能误报缺失。
- 建议：解析并使用 `truncated`。只在已返回前缀足以证明结果时作确定判断，其余返回 inconclusive，复用本地大响应检查的语义。
- 契约依据：[Globalping 官方 schema](https://github.com/jsdelivr/globalping/blob/master/public/v1/components/schemas.yaml) 的 `FinishedHttpTestResult.rawBody` / `truncated`。

### R6 · P2 · 全部状态存于单个 D1 值，时间保留策略不能保证可写

- 位置：`src/run-monitoring.ts:422–427`；90 天清理条件见 `src/run-monitoring.ts:270–280`。
- 条件：监控反复抖动、错误详情持续变化，或监控数量增加，累计状态超过单值上限。
- 原因：所有监控的 incident 和 latency 都序列化到 `uptimeflare['state']`；没有字节容量边界或分片。已结束 incident 只在超过 90 天后清理，开放 incident 的 changes 也没有数量界限。
- 验证：使用真实 `CompactedMonitorStateWrapper` 写入 13,100 个有效的已解决 incident，序列化结果为 **2,004,579 字节**，即使不计 latency 和通知事件键也已超限。单个监控每分钟 UP/DOWN 交替，约 18.2 天便可形成这组数据，尚未达到清理期限。这是构造数据实验，未向生产 D1 写入大对象。
- 影响：状态更新及同批 outbox 写入失败；由于共享一个 state，单个抖动监控可使全部监控停止更新，直至数据减少或人工修复。
- 建议：把 incident、变更和采样按记录或时间分片存储，让当前状态维持有界大小；增加接近容量边界的测试与监控，避免通过静默删除待发送事件“解决”容量问题。
- 平台依据：[D1 官方限制](https://developers.cloudflare.com/d1/platform/limits/)：单个字符串、BLOB 或表行上限为 **2,000,000 bytes**。

## 验证记录

| 检查 | 结果 |
| --- | --- |
| 项目已有依赖下 `npm run check` | 17 个测试文件、209 项测试通过；TypeScript 通过 |
| 从 HEAD 导出至临时目录后 `npm ci` | 成功，未改动项目 node_modules 或 lockfile |
| 锁定依赖下 `npm run check` | 17 个测试文件、209 项测试通过；TypeScript 通过 |
| 锁定依赖下 `npm run deploy:dry-run` | 成功，19 个静态文件、四个预期绑定；未部署 |
| `npm audit --json`，包含开发依赖 | 0 个已报告漏洞 |
| 新增隔离复现用例 | 5 个预期行为断言均失败，复现 R2–R5；R3 两个用例 |
| 本地 Workers 重定向实验 | 复现 R1 的 Cookie / X-Api-Key 跨域转发 |
| 真实状态编码器容量实验 | 复现 R6 的超过 2,000,000 字节条件 |
| 审计前 `git diff --check` | 通过 |

锁定依赖验证环境：Node.js 26.10.0、npm 11.19.1、Vitest 4.1.11、Wrangler 4.136.2。CI 使用 Node 22，本次未另行运行 Node 22 矩阵。原工作区依赖版本与锁文件不完全一致，因此以临时目录的干净安装结果作为构建结论。初次原目录 dry-run 出现日志目录权限提示；临时验证通过设置 `WRANGLER_LOG_PATH` 到 `/private/tmp` 消除了该提示。

复现目录：`/private/tmp/uptime-audit.1MkI7w`。其中 `tests/audit.regression.test.ts`、`audit-runtime.mjs`、`audit-size.mjs` 是本次实验；测试输出另存于 `/private/tmp/uptime-audit-regressions.log`。这些是临时审计证据，未纳入项目测试套件，系统清理临时目录后可能不再存在。

## 其他观察与范围限制

- 已覆盖入口鉴权、静态资源保护、公开数据投影、探测与代理、状态转换、D1 编码和迁移、通知 outbox、调度、前端呈现、工作流与依赖。未发现可确认的入口鉴权绕过；这不等于对所有安全属性的保证。
- 项目具备 outbox 原子落库、通知幂等键、超时与响应体限制、公开错误分类、状态过期处理以及 Workers 运行时集成测试。这些措施有效，但需要补充上面列出的真实契约和跨组件用例。
- `docs/operations.md` 的发布候选段仍绑定 2026-07-22 的特定提交标题和 201 项测试，与当前 HEAD 和 209 项测试不符；还描述了已由迁移 0004 移除的 run metadata 持久化。建议更新为可重复执行、对应当前代码的操作说明。未将文档陈旧重复计为核心缺陷。
- 未读取生产 secrets，未验证生产部署版本、账户套餐、远程 D1 内容或线上运行状态。因此以上发现均是代码、隔离复现和官方契约层面的结论，不能用于推断生产中已发生的事故。

建议优先处理 R1；随后统一当前已启用的 failureThreshold 行为并修复 TCP 443；在启用 Globalping 前修复 R4/R5；为长期运行补上 R6 的存储边界。

## 修复与最终验证 — 2026-09-27

| 编号 | 实施结果 | 回归证据 |
| --- | --- | --- |
| R1 | 探测逐跳检查重定向；带私有头或 body 时拒绝跨 origin，拒绝 HTTPS 降级，最多五次跳转；webhook 使用 manual 并拒绝 3xx | `tests/redirect-runtime.test.ts` 在真实 workerd 中验证 Cookie、自定义凭据头、Authorization、POST body、同域跳转、公开跨域跳转、循环、webhook 成功及拒绝 |
| R2 | 统一 TCP 地址解析，保留显式 443 并验证端口、IPv6 | `tests/audit-regressions.test.ts` 验证实际传给 connector 的地址及 Globalping 请求中的端口 |
| R3 | 持久化未确认失败计数；达到阈值才创建 incident，摘要、徽章、历史、回调和通知共用确认状态 | 连续运行序列覆盖首次失败、恢复清零、第二次确认、持续故障、恢复通知及再次失败 |
| R4 | Globalping TCP 接受合法小数并四舍五入到整数毫秒；仍拒绝非法或越界数据 | 覆盖 0、0.49、1.5、65534.9、65535 和非法类型/范围 |
| R5 | 读取 truncated；仅在响应前缀足以确定结果时返回确定判断，其余返回 inconclusive | 覆盖必需词、禁用词、组合条件、已找到禁用词以及无内容检查 |
| R6 | 大状态无损分块存储；读取同一 SQL 快照；所有状态写入路径与 outbox 保持原子事务 | 真实 D1 集成覆盖超过 2 MB 的历史及开放 incident 变更、Unicode、完整读回、确认失败重试、事务回滚、缺块 503、缩小后清理；另测读取期间并发更新 |

最终命令结果：

- `npm ci`：成功，使用锁文件对齐依赖。
- `npm run check`：19 个测试文件、253 项测试通过，`tsc --noEmit` 通过。
- `npm run deploy:dry-run`：成功；19 个静态文件，四个预期绑定；未上传或部署。
- `npm audit --json`：包括开发依赖在内报告 0 个已知漏洞。
- `git diff --check`：通过。

修复验证环境为 Node.js 24.20.0、npm 12.0.2、Vitest 4.1.11、Wrangler 4.136.2。测试直接使用的 esbuild / Miniflare 已显式列为开发依赖，版本与既有锁文件一致。本次没有另外运行 Node 22 矩阵，也没有生产变更。

行为约定：故障和 gracePeriod 从**达到阈值的确认检查**开始计时；升级前已存在的 incident 不改写。状态分块不需要 SQL 迁移，但一旦生成分块 manifest，回滚版本也必须支持分块。分块解决单行容量上限，不意味着总 CPU、内存、响应体或数据库容量无限；运维说明已记录这些边界及备份要求。旧的固定发布标题、过时测试数和 run metadata 持久化描述也已更新。
