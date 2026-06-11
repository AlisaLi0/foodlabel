# biaoqianshibie · 食品标签国标合规检查

上传预包装食品的标签照片，分步识读标签文字与营养成分表，先按国标判定适用规则，
再逐条对照判断是否合规，输出结构化的缺失点 / 问题点 / 风险点报告。

依据标准（均于 **2027-03-16** 实施）：

- **GB 7718-2025**《食品安全国家标准 预包装食品标签通则》
- **GB 28050-2025**《食品安全国家标准 预包装食品营养标签通则》

> 结果由 AI 识图后自动比对生成，仅供参考，不构成官方监管结论或法律意见。

## 分步流程（SSE 流式，逐步返回）

后端 `POST /api/check/stream` 以 Server-Sent Events 逐步推送，前端进度条逐步点亮、逐步渲染：

| 步 | 阶段 | 模型 / 动作 | 实测耗时 | 完成即返回 |
|---|---|---|---|---|
| 1 | 识别图片 | DeepSeek-OCR（硅基流动） | ~1–3 s | OCR 文本草稿 |
| 2 | 识读内容 | Qwen3.6-35B-A3B 视觉（以图为准，OCR 为辅） | ~15–19 s | **识读字段 + 营养成分表** |
| 3 | 判定适用规则 | Qwen3.6 受限分类 → 代码确定性映射 | ~19 s | **食品类目 + 各项适用/豁免** |
| 4 | 合规评价 | Qwen3.6 基于适用规则逐条对照国标 | ~110–130 s | **缺失/问题/风险点** |
| 5 | 生成报告 | 汇总 | <1 s | 完整报告 |

**提高准确度的关键设计**：第 3 步不让模型自由发挥——LLM 只从**严格对应国标条款的固定食品
类目**（见 `FOOD_CATEGORIES`）中二选一并判断是否进口，**各检查项是否适用由代码
`applicable_for()` 确定性映射**（依 GB 28050-2025 §7 营养豁免、GB 7718-2025 §10/§8 等），
不适用项在汇总时强制判 `na`，从而约束输出范围、稳定适用边界。

## 功能

- 一次最多上传 4 张图片（正面 / 配料面 / 营养成分面等），合并识读同一件商品；支持拖拽、剪贴板粘贴。
- 提取字段：食品名称、配料表、食品添加剂、净含量/规格、生产者信息、生产日期/保质期、
  贮存条件、生产许可证编号、产品标准代号、致敏物质、营养成分表、声称等。
- 强制项逐条判定（`pass/fail/warn/na/unknown`），每条标注标准条款依据。
- 三类问题：**缺失点**（应标未标）/ **问题点**（标了但不规范）/ **风险点**（监管或误导隐患，分高/中/低）。
- 营养标签按 GB 28050-2025「1+6」（能量、蛋白质、脂肪、饱和脂肪、碳水化合物、糖、钠 + NRV%）
  及「儿童青少年应避免过量摄入盐油糖」提示语检查；并按固定类目识别营养标签豁免情形。

## 模型与网关

- **OCR（识图）**：硅基流动 `deepseek-ai/DeepSeek-OCR`（`SF_*` 配置）。
- **识读 / 分类 / 合规评价（reason）**：4090 AMD 网关上的 `Qwen3.6-35B-A3B`，经 tencent 反向隧道
  `http://127.0.0.1:17590/v1`（`SF_REASON_*` 配置）。Qwen3.6 为推理 + 视觉模型，思考无法关闭，
  故 reason 调用走**流式** + 大 `max_tokens`，避免长响应被代理/CF 空闲超时掐断。

## 结构

```
foodlabel-check/
├── server/
│   ├── app.py          FastAPI：静态前端 + POST /api/check（一次性）/ /api/check/stream（SSE 分步）
│   ├── core.py         框架无关核心：analyze_steps 分步生成器（OCR→识读→适用规则→评价）
│   ├── standards.py    GB7718/GB28050 检查清单 + 固定食品类目 + 各步系统提示词
│   └── llm.py          硅基流动 OCR + reason 网关客户端（流式、视觉、输出 JSON）
├── web/                前端（index.html / app.js / style.css，步骤进度条 + 逐步渲染）
├── deploy/             systemd / env 示例 / nginx 片段
├── requirements.txt
└── run.sh              本地开发启动
```

## 本地运行

```bash
cp deploy/foodlabel.env.example foodlabel.env   # 填 SF_API_KEY / SF_REASON_*
./run.sh                                          # http://127.0.0.1:8610
```

## 线上部署（tencent，docs-tools.online/biaoqianshibie/）

后端在 `127.0.0.1:8610`（loopback），nginx 在既有 `docs-tools.online` vhost 中加
`location /biaoqianshibie/` 反代并用 HTTP Basic Auth 加锁（用户 `admin`）。
SSE 需要该 location 关闭 `proxy_buffering` 且 `proxy_read_timeout` ≥ 300s。

1. 同步代码到 `/opt/foodlabel-check/`，建 venv、装依赖、写 `foodlabel.env`。
2. 装 systemd 服务 `deploy/foodlabel-check.service` 并 `enable --now`。
3. 按 `deploy/nginx-biaoqianshibie.conf` 注释创建口令文件、粘贴 location、`nginx -t && reload`。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/check/stream` | multipart，字段 `images`（可多张）→ **SSE 分步**逐步返回各阶段事件 |
| `POST` | `/api/check` | 同上，一次性返回完整合规报告 JSON（供 MCP / 脚本调用） |
| `GET` | `/api/checklist` | 检查清单与标准依据 |
| `GET` | `/api/health` | 健康检查（OCR / reason 模型、依据标准） |
| `GET` | `/api/health` | 健康检查（当前模型、依据标准） |
