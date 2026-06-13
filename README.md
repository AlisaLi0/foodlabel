# biaoqianshibie · 食品标签国标合规检查

上传预包装食品的标签照片（或直传标签文档），多引擎识读标签文字与营养成分表，
先按国标判定适用规则，再用**确定性规则引擎**逐条对照判断是否合规，
输出结构化的缺失点 / 问题点 / 风险点报告。

依据标准（均于 **2027-03-16** 实施）：

- **GB 7718-2025**《食品安全国家标准 预包装食品标签通则》
- **GB 28050-2025**《食品安全国家标准 预包装食品营养标签通则》

> 结果由 AI 识图 + 规则引擎自动比对生成，仅供参考，不构成官方监管结论或法律意见。

## 五步流程

后台任务（`asyncio.create_task`）逐步产出事件，Web 用 SSE 续推、小程序用轮询；
处理脱离请求生命周期，**切页 / 刷新 / 断线都不中断**。

| 步 | 阶段 | 引擎 / 动作 | 实测耗时 |
|---|---|---|---|
| 1 | 识别图片 | **多引擎并行**：RapidOCR(PP-OCRv4 mobile, 本地/远程) + DeepSeek-OCR(SiliconFlow)；直传文档则跳过 OCR | ~1.5 s |
| 2 | 识读内容 | 天枢 **Qwen3.6-35B-A3B**（多模态，喂 OCR 文本 + 原图）识读结构化字段 + 营养表 | ~18 s |
| 3 | 判定适用规则 | Qwen3.6 受限分类（食品类目 + 是否进口）→ 代码 `applicable_for()` 确定性映射适用/豁免 | ~8 s |
| 4 | 合规评价 | **确定性规则引擎 `evaluate_checks()`（不调 LLM）**，逐条判 pass/miss/fail/warn | <0.1 s |
| 5 | 生成报告 | 汇总缺失/问题/风险 + 评分 | — |

**全流程约 28 s。**

### 关键设计

1. **合规判定确定性**：第 4 步用纯代码规则引擎，不靠 LLM —— 法律合规结论**同一识读结果永远同结论**，不受模型采样波动影响（托管 MoE 推理即便 temp=0 也会因专家路由/浮点累加波动）。
2. **多 OCR 交叉印证**：多引擎结果都带模型标签喂给识读步互相纠错；识读模型支持多模态时把原图一并喂入。
3. **反漏检 / 反幻觉**：明显标签即便模型误判 not_a_label 也强制进复核；不虚构未出现的营养素（0g 是合法值非识别错误）；OCR 原文喂判定层做事实依据。
4. **第 3 步受限分类**：LLM 只从严格对应国标条款的固定类目（`FOOD_CATEGORIES`）二选一，适用项由代码按 GB 28050-2025 §7 / GB 7718-2025 §10/§8 确定性算。

## 功能

- 一次最多 4 张图（正面/配料面/营养面），合并识读同一件商品；支持拖拽、剪贴板粘贴。
- 提取字段：食品名称、配料、添加剂、净含量/规格、生产者信息、生产日期/保质期、贮存条件、生产许可证编号、产品标准代号、致敏物质、营养成分表、声称等。
- 强制项逐条判定（`pass/miss/fail/warn/na/unknown`），每条标注标准条款依据。
- 三类问题：**缺失点**（应标未标）/ **问题点**（标了但不规范）/ **风险点**（监管或误导隐患）。
- 营养标签按「1+6」（能量、蛋白质、脂肪、饱和脂肪酸、碳水化合物、糖、钠 + NRV%）+ 盐油糖提示语检查；按固定类目识别营养豁免情形。
- 微信小程序：wx 登录 + 免费额度（新户送 5 / 每日补 5 / 分享 +2 / 每次扣 1）。

## 模型与网关

- **OCR**：`FOODLABEL_OCR_ENGINES`（逗号分隔，全部并行）。默认 `rapidocr,deepseek-ai/DeepSeek-OCR`。
  - `rapidocr` = RapidOCR（PP-OCRv4 mobile, ONNXRuntime CPU, 开源 Apache-2.0, 确定性零成本）。设 `FOODLABEL_RAPIDOCR_URL` 则调远程 HTTP 服务（见 `ocr-service/`），留空则本进程内直跑。
  - 其它 id（`deepseek-ai/DeepSeek-OCR` 等）= 远程 VLM OCR，走 `SF_BASE_URL`/`SF_API_KEY`。
- **识读 / 分类（reason）**：`SF_REASON_MODEL`，默认天枢 `Qwen/Qwen3.6-35B-A3B`（`SF_REASON_BASE_URL=https://tianshu-gateway.cloud/v1`）。
  - ⚠️ 天枢上发模型 id 必须 `Qwen/Qwen3.6-35B-A3B`；发 `qwen36-awq` 会被 fallback 到 gpt-5.5。
  - `SF_REASON_VISION` 控制是否多模态（留空按模型名自动判断），支持时识读阶段喂原图。
  - `SF_REASON_TEMPERATURE=0` + `SF_REASON_SEED` 贪心解码（识读尽量稳）。
- **合规评价**：纯代码 `standards.evaluate_checks()`，不调任何模型。

## 结构

```
foodlabel-check/
├── server/
│   ├── app.py          FastAPI：静态前端 + /api/check* + /api/wx/*（小程序）；后台任务 _JOBS + 可重连 SSE
│   ├── core.py         框架无关核心：analyze_steps 分步生成器 + 派生 findings + normalize
│   ├── standards.py    GB7718/GB28050 清单 + 固定类目 + applicable_for + evaluate_checks 规则引擎
│   ├── llm.py          OCR(本地/远程 RapidOCR + 远程 VLM) + reason 客户端
│   └── wxauth.py       微信小程序登录 + 积分（HMAC-JWT + SQLite，无第三方依赖）
├── web/                Web 前端（index.html / app.js / style.css）
├── wx/miniprogram/     微信小程序工程（4 页 + utils/api.js + tabBar 图标 + assets/头像）
├── ocr-service/        RapidOCR HTTP 服务（4090 Docker，限 16 核，与 texify 同机；含 Dockerfile + systemd）
├── deploy/             systemd / env 示例 / nginx 片段
├── requirements.txt
└── run.sh
```

## 部署

### 后端（tencent · docs-tools.online/biaoqianshibie/）
- systemd `foodlabel-check`：uvicorn `127.0.0.1:8610`，`EnvironmentFile=/opt/foodlabel-check/foodlabel.env`。
- nginx：`docs-tools.online` vhost 加 `location ^~ /biaoqianshibie/` 反代到 :8610（已公网放开，每 IP 60 次/小时限流）；
  `location ^~ /biaoqianshibie/api/wx/` 单独免 Basic Auth（小程序鉴权由后端 wx token 负责）。
  SSE 需 `proxy_buffering off` + `proxy_read_timeout ≥ 200s`。
  > 注意 `sites-enabled` 是独立副本非软链，改 nginx 要 available + enabled 两处都改。

### OCR 服务（4090 · 卸载弱机 CPU 压力）
RapidOCR 跑在 4090 Docker（144 核机限 16 核，与 texify 同模板），经 autossh 反向隧道供 tencent 调用：
```
4090: docker rapidocr-onnx-4090 (rapidocr-http:cpu) 127.0.0.1:8512  [systemd rapidocr-onnx-4090.service, --cpus=16]
    → autossh-rapidocr-4090.service -R 127.0.0.1:8515:127.0.0.1:8512 tunnel@tencent
tencent: foodlabel.env  FOODLABEL_RAPIDOCR_URL=http://127.0.0.1:8515/ocr
```
构建/部署见 `ocr-service/README.md`。

### 微信小程序
- AppID `wx91405e13f18e721f`；开发者工具根目录指 `wx/miniprogram`。
- 小程序后台「request/uploadFile 合法域名」加 `https://docs-tools.online`。
- 后端需配 `FOODLABEL_WX_APPID/SECRET/JWT_SECRET`，`/api/wx/health` 返回 `wx_enabled:true`。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/check/start` | multipart `images`（可多张）→ 起后台任务返 `job_id` |
| `GET` | `/api/check/stream?job_id=&from=` | SSE 续推分步事件（可断线重连） |
| `POST` | `/api/check` | 一次性返回完整报告 JSON（供 MCP / 脚本） |
| `POST` | `/api/wx/login` | 小程序 wx.login code 换 token |
| `GET` | `/api/wx/me` | 用户积分 / 分享状态 |
| `POST` | `/api/wx/check` · `GET /api/wx/result` | 小程序传图起任务 / 轮询结果 |
| `GET` | `/api/checklist` · `/api/health` · `/api/wx/health` | 清单 / 健康检查 |

## 本地运行

```bash
cp deploy/foodlabel.env.example foodlabel.env   # 填 SF_* / SF_REASON_* / 可选 FOODLABEL_RAPIDOCR_URL
./run.sh                                          # http://127.0.0.1:8610
```
