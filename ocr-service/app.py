"""RapidOCR HTTP 服务 — 把 PP-OCRv4 mobile (ONNXRuntime CPU) 包成 HTTP 接口.

部署在 4090（144 核/1T），与 texify 同机，Docker 限 16 核。
foodlabel 后端经 autossh 反向隧道远程调用，卸载 tencent 弱机的 OCR CPU 压力。

接口：
  GET  /health → {"ok": true, "model": "..."}
  POST /ocr    → 接受图片（multipart 字段 image 或 raw body），返回 {"text", "elapsed_ms"}
"""
from __future__ import annotations

import os
import threading
import time

from fastapi import FastAPI, File, Request, UploadFile
from fastapi.responses import JSONResponse

MODEL_NAME = "RapidOCR (PP-OCRv4 mobile)"

app = FastAPI(title="rapidocr-http", docs_url=None, redoc_url=None)

_engine = None
_lock = threading.Lock()


def _get_engine():
    """懒加载 RapidOCR 单例（首次约 1.3s 初始化）。"""
    global _engine
    if _engine is None:
        with _lock:
            if _engine is None:
                from rapidocr import RapidOCR

                _engine = RapidOCR()
    return _engine


def _recognize(image_bytes: bytes) -> str:
    res = _get_engine()(image_bytes)
    txts = getattr(res, "txts", None)
    if not txts:
        return ""
    return "\n".join(t for t in txts if t)


@app.on_event("startup")
async def _warmup() -> None:
    # 启动即加载模型，避免首个请求慢。
    try:
        _get_engine()
    except Exception:  # noqa: BLE001 — 加载失败留给请求时再报
        pass


@app.get("/health")
async def health() -> dict:
    return {"ok": True, "model": MODEL_NAME}


@app.post("/ocr")
async def ocr(request: Request, image: UploadFile | None = File(default=None)) -> JSONResponse:
    """识别图片文字。优先取 multipart 的 image 字段；否则读取 raw body。"""
    if image is not None:
        raw = await image.read()
    else:
        raw = await request.body()
    if not raw:
        return JSONResponse({"error": "未收到图片数据"}, status_code=400)
    t0 = time.perf_counter()
    try:
        import asyncio

        text = await asyncio.to_thread(_recognize, raw)
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": f"OCR 失败: {e}"}, status_code=500)
    return JSONResponse({"text": text, "elapsed_ms": round((time.perf_counter() - t0) * 1000)})


if __name__ == "__main__":
    import uvicorn

    host = os.getenv("RAPIDOCR_HOST", "0.0.0.0")
    port = int(os.getenv("RAPIDOCR_PORT", "8512"))
    uvicorn.run(app, host=host, port=port, log_level="warning")
