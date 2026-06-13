# RapidOCR HTTP 服务镜像（CPU，PP-OCRv4 mobile via ONNXRuntime）
FROM python:3.12-slim

# RapidOCR 依赖 opencv，需要这些系统库
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

# 预下载 RapidOCR ONNX 模型，避免首启动联网拉模型（构建期联网一次即可）
RUN python -c "from rapidocr import RapidOCR; RapidOCR()" || true

ENV RAPIDOCR_HOST=0.0.0.0 RAPIDOCR_PORT=8512
EXPOSE 8512
CMD ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8512", "--log-level", "warning"]
