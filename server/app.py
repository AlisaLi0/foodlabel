"""biaoqianshibie 后端 API — 食品标签国标合规检查.

纯 JSON API（前后端分离，参照 JuriCodex）：
  POST /api/check      上传标签图片 → 返回结构化合规报告
  GET  /api/checklist  返回检查清单与标准依据
  GET  /api/health     健康检查
核心识读/判定逻辑在 server/core.py（框架无关，供 MCP server 复用）。

前端是独立的静态资源（web/），通过可配置的 API base 调用本 API；为方便起见，
本服务也可同源托管该静态前端（FOODLABEL_SERVE_WEB）。CORS 由 FOODLABEL_CORS_ORIGINS
控制，允许前端单独部署在其他源。

生产同源部署：nginx 反代到 https://docs-tools.online/biaoqianshibie/（Basic Auth 加锁）。
"""
from __future__ import annotations

import os
import time
from collections import deque

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
# request.form() 返回 starlette 的 UploadFile；fastapi.UploadFile 是其子类，
# isinstance 判定要用 starlette 的基类，否则恒为 False。
from starlette.datastructures import UploadFile

from . import core, llm
from .standards import CHECKLIST, STANDARDS

HOST = os.getenv("FOODLABEL_HOST", "127.0.0.1")
PORT = int(os.getenv("FOODLABEL_PORT", "8610"))
WEB_DIR = os.getenv(
    "FOODLABEL_WEB_DIR", os.path.join(os.path.dirname(__file__), "..", "web")
)
# 是否同源托管静态前端（前后端分离时可设 0，仅跑纯 API）。
SERVE_WEB = os.getenv("FOODLABEL_SERVE_WEB", "1") != "0"
# 跨源前端允许的来源（逗号分隔；"*" 放行任意源）。默认 "*"：API 由 nginx Basic Auth 保护。
CORS_ORIGINS = os.getenv("FOODLABEL_CORS_ORIGINS", "*")
MAX_IMAGES = int(os.getenv("FOODLABEL_MAX_IMAGES", str(core.DEFAULT_MAX_IMAGES)))
MAX_IMAGE_BYTES = int(os.getenv("FOODLABEL_MAX_IMAGE_BYTES", str(core.DEFAULT_MAX_BYTES)))
# 每 IP 每小时检查次数上限，保护上游网关配额。0 关闭。
CHECK_MAX_PER_HOUR = int(os.getenv("FOODLABEL_MAX_PER_HOUR", "60"))

app = FastAPI(title="biaoqianshibie", docs_url=None, redoc_url=None)

_cors_origins = [o.strip() for o in CORS_ORIGINS.split(",") if o.strip()]
if _cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_origins,
        allow_credentials=_cors_origins != ["*"],
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type", "Authorization"],
    )

_hits: dict[str, deque] = {}


def _rate_limited(ip: str) -> bool:
    if CHECK_MAX_PER_HOUR <= 0:
        return False
    now = time.time()
    dq = _hits.setdefault(ip, deque())
    while dq and now - dq[0] > 3600:
        dq.popleft()
    if len(dq) >= CHECK_MAX_PER_HOUR:
        return True
    dq.append(now)
    return False


@app.get("/api/health")
async def health() -> dict:
    return {
        "ok": True,
        "ocr_models": llm.OCR_MODELS,
        "reason_model": llm.REASON_MODEL,
        "standards": STANDARDS,
    }


@app.get("/api/checklist")
async def checklist() -> dict:
    """返回检查清单，供前端展示标准依据。"""
    return {"standards": STANDARDS, "items": CHECKLIST}


@app.post("/api/check")
async def check(request: Request) -> JSONResponse:
    ip = request.headers.get("x-real-ip") or (request.client.host if request.client else "?")
    if _rate_limited(ip):
        return JSONResponse({"error": "请求过于频繁，请稍后再试。"}, status_code=429)

    form = await request.form()
    uploads = [v for v in form.getlist("images") if isinstance(v, UploadFile)]
    if not uploads:
        single = form.get("image")
        if isinstance(single, UploadFile):
            uploads = [single]

    items: list[tuple[bytes, str | None]] = []
    for up in uploads:
        raw = await up.read()
        items.append((raw, (up.content_type or "").lower() or None))

    try:
        result = await core.check_image_bytes(
            items, max_images=MAX_IMAGES, max_bytes=MAX_IMAGE_BYTES
        )
    except core.InputError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    except llm.LLMError as e:
        return JSONResponse({"error": f"识别失败：{e}"}, status_code=502)

    return JSONResponse(result)


# 同源托管静态前端（挂在最后，避免吞掉 /api/*）。前后端分离纯 API 部署可设 FOODLABEL_SERVE_WEB=0。
if SERVE_WEB and os.path.isdir(WEB_DIR):
    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
