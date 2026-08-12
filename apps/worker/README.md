# MathNotes Standalone Gateway Worker

生产形态、本地可测的 Cloudflare Worker 包：在同一个 HTTPS origin 上同时托管
`apps/pwa/dist` 静态产物，并暴露手机独立识别网关合同（`/v1/capabilities`、
`/v1/recognitions`）。本仓库不自动部署、不开通账号、不写秘密；部署由人工按
下方关卡执行。

## 端点（架构已冻结）

- `GET /v1/capabilities`：无鉴权能力探针，PWA 同源自动发现网关时使用。
- `OPTIONS /v1/recognitions`：精确同源 CORS 预检。
- `POST /v1/recognitions`：Bearer 鉴权、幂等键格式校验、请求体/图片上限、no-store；
  经 OpenAI-compatible vision chat completions 调用 Provider，返回
  `{ taskId, status: "succeeded", markdown }`。
- 其余请求一律转发 `env.ASSETS.fetch(request)`。

请求/响应与 `apps/pwa/src/standaloneGatewayClient.ts` 和
发布包会生成不依赖内部项目文档的 `网关接口合同.md`；其接口与本 README 保持兼容。

## 绑定（无秘密）

| 绑定 | 类型 | 说明 |
|---|---|---|
| `ASSETS` | 静态资产绑定 | `wrangler.jsonc` 的 `assets` 声明，目录为 `../pwa/dist` |
| `MATHNOTES_PROVIDER_BASE_URL` | 普通变量 | OpenAI-compatible 基础地址，如 `https://api.example.com/v1` |
| `MATHNOTES_PROVIDER_MODEL` | 普通变量 | 视觉模型名 |
| `MATHNOTES_RATE_LIMITER` | 可选 ratelimit 绑定 | `wrangler.jsonc` 中默认注释；启用需 Wrangler >= 4.36，并选用账号内唯一的整数 `namespace_id` |

## 秘密（只进 Worker secret，不落 Git）

```powershell
npx wrangler secret put MATHNOTES_GATEWAY_TOKEN
npx wrangler secret put MATHNOTES_PROVIDER_API_KEY
```

本地 `wrangler dev` 可用 `.dev.vars`（已被 `.gitignore` 忽略）注入同名值。
仓库、文档、测试与打包产物不得包含真实密钥或形似密钥的占位符。

## 本地验证与打包（不部署）

```powershell
npm run test:standalone-worker
npm run package:standalone-worker
npm run test:standalone-worker-package
```

`package:standalone-worker` 会先执行 `npm run build:pwa`，再把
`apps/pwa/dist` 与 Worker 源码、Wrangler 配置、说明文档、清单和 SHA-256
汇总到 `output/test-packages/standalone-worker-<commit>/ready/`，并生成 ZIP。
打包脚本允许 dirty working tree 做提交前冒烟，并在 manifest 中如实标记
`dirty`；正式发布前应在干净提交上重新打包。

## 人工部署关卡（本切片不执行）

1. 选定正式域名与 Cloudflare 账号、费用与回滚策略；
2. 在干净提交上运行 `npm run package:standalone-worker`；
3. 进入 `ready/`，核对 `部署说明.md` 与 `artifact-manifest.json`；
4. 补持久幂等/去重策略；当前只验证请求键，网络重试仍可能重复调用 Provider；
5. 先以缺少秘密时 fail-closed 的状态创建 Worker，再用 `wrangler secret put` 写入两个秘密并发布最终版本；
6. `npx wrangler@4.36+ deploy`（启用限流绑定时需要新版 Wrangler）；
7. 真实 Provider、正式域名与任何收费资源仍须单独窄范围批准。
