# biaoqianshibie · 食品标签国标合规检查

上传预包装食品的标签照片，用视觉大模型识读标签文字与营养成分表，再对照现行国家标准
逐项判断是否合规，输出结构化的合规报告与整改建议。

依据标准（均于 **2027-03-16** 实施）：

- **GB 7718-2025**《食品安全国家标准 预包装食品标签通则》
- **GB 28050-2025**《食品安全国家标准 预包装食品营养标签通则》

> 结果由 AI 识图后自动比对生成，仅供参考，不构成官方监管结论或法律意见。

## 功能

- 一次最多上传 4 张图片（正面 / 配料面 / 营养成分面等），合并识读同一件商品。
- 提取字段：食品名称、配料表、食品添加剂、净含量/规格、生产者信息、生产日期/保质期、
  贮存条件、生产许可证编号、产品标准代号、致敏物质、营养成分表、声称等。
- 强制项逐条判定（`pass/fail/warn/na/unknown`），每条标注标准条款依据。
- 营养标签按 GB 28050-2025「1+6」（能量、蛋白质、脂肪、饱和脂肪、碳水化合物、糖、钠 + NRV%）
  及「儿童青少年应避免过量摄入盐油糖」提示语检查；并识别营养标签豁免情形。

## 结构

```
foodlabel-check/
├── server/
│   ├── app.py          FastAPI：静态前端 + POST /api/check
│   ├── standards.py    GB7718/GB28050 强制项检查清单 + 视觉模型系统提示词
│   └── llm.py          视觉模型客户端（OpenAI 兼容，image_url，输出 JSON）
├── web/                前端（index.html / app.js / style.css）
├── deploy/             systemd / env 示例 / nginx 片段
├── requirements.txt
└── run.sh              本地开发启动
```

## 本地运行

```bash
cp deploy/foodlabel.env.example foodlabel.env   # 填 LLM_API_KEY
./run.sh                                          # http://127.0.0.1:8610
```

## 线上部署（tencent，docs-tools.online/biaoqianshibie/）

后端在 `127.0.0.1:8610`（loopback），nginx 在既有 `docs-tools.online` vhost 中加
`location /biaoqianshibie/` 反代并用 HTTP Basic Auth 加锁（用户 `admin`）。

1. 同步代码到 `/opt/foodlabel-check/`，建 venv、装依赖、写 `foodlabel.env`。
2. 装 systemd 服务 `deploy/foodlabel-check.service` 并 `enable --now`。
3. 按 `deploy/nginx-biaoqianshibie.conf` 注释创建口令文件、粘贴 location、`nginx -t && reload`。

LLM 走 tencent 本机 `http://127.0.0.1:17590/v1`（反向隧道 → AMD 网关），
默认模型 `gpt-4.1-mini`（实测可识读中文标签）。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/check` | multipart，字段 `images`（可多张）→ 返回合规报告 JSON |
| `GET` | `/api/checklist` | 检查清单与标准依据 |
| `GET` | `/api/health` | 健康检查（当前模型、依据标准） |
