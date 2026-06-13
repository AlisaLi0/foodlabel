# RapidOCR HTTP 服务（4090 Docker，CPU）

把 RapidOCR（PP-OCRv4 mobile, ONNXRuntime CPU）做成独立 HTTP 服务，从 tencent 弱机
（4 核/3.6G）卸载到 4090（144 核/1T），与 texify 同机、同样限 16 核。

foodlabel 后端通过 `FOODLABEL_RAPIDOCR_URL` 指向本服务的 `/ocr`，远程识别。

## 接口

- `GET  /health` → `{"ok": true}`
- `POST /ocr`（multipart，字段名 `image`）→ `{"text": "...", "elapsed_ms": 123}`
- `POST /ocr`（body=raw bytes，Content-Type: image/*）→ 同上

## 部署（4090，照搬 texify 模板）

```bash
# 1) 构建镜像
cd ocr-service
docker build -t rapidocr-http:cpu .

# 2) systemd 跑容器（限 16 核 8G，监听 127.0.0.1:8512）
#    见 deploy/rapidocr-onnx-4090.service

# 3) autossh 反向隧道到 tencent loopback:8515
#    见 deploy/autossh-rapidocr-4090.service
```

tencent 侧 `foodlabel.env` 设 `FOODLABEL_RAPIDOCR_URL=http://127.0.0.1:8515/ocr` 即走远程。
