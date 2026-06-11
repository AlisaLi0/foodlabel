"""biaoqianshibie 后端 — 食品标签国标合规检查.

上传食品标签图片 → 视觉大模型识读 → 对照 GB 7718-2025 / GB 28050-2025
强制项逐条判定 → 返回结构化合规报告。

同源部署：本服务在 127.0.0.1:8610 上同时提供静态前端与 /api/* 接口。
线上经 nginx 反代到 https://docs-tools.online/biaoqianshibie/（HTTP Basic Auth 加锁）。
"""
from __future__ import annotations

import os
import time
from collections import deque

from fastapi import FastAPI, Request, UploadFile
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from . import llm
from .standards import CHECKLIST, STANDARDS, system_prompt

HOST = os.getenv("FOODLABEL_HOST", "127.0.0.1")
PORT = int(os.getenv("FOODLABEL_PORT", "8610"))
WEB_DIR = os.getenv(
    "FOODLABEL_WEB_DIR", os.path.join(os.path.dirname(__file__), "..", "web")
)
# 每次最多接受的图片数量与单图大小（字节）。
MAX_IMAGES = int(os.getenv("FOODLABEL_MAX_IMAGES", "4"))
MAX_IMAGE_BYTES = int(os.getenv("FOODLABEL_MAX_IMAGE_BYTES", str(8 * 1024 * 1024)))
# 每 IP 每小时检查次数上限，保护上游网关配额。0 关闭。
CHECK_MAX_PER_HOUR = int(os.getenv("FOODLABEL_MAX_PER_HOUR", "60"))
ALLOWED_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif", "image/bmp"}

app = FastAPI(title="biaoqianshibie", docs_url=None, redoc_url=None)

_hits: dict[str, deque] = {}
_CHECK_IDS = [c["id"] for c in CHECKLIST]


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
    return {"ok": True, "model": llm.LLM_MODEL, "standards": STANDARDS}


@app.get("/api/checklist")
async def checklist() -> dict:
    """返回检查清单，供前端展示标准依据。"""
    return {"standards": STANDARDS, "items": CHECKLIST}


@app.post("/api/check")
async def check(request: Request) -> JSONResponse:
    ip = request.headers.get("x-real-ip") or (request.client.host if request.client else "?")
    if _rate_limited(ip):
        return JSONResponse(
            {"error": "请求过于频繁，请稍后再试。"}, status_code=429
        )

    form = await request.form()
    uploads = [v for v in form.getlist("images") if isinstance(v, UploadFile)]
    if not uploads:
        single = form.get("image")
        if isinstance(single, UploadFile):
            uploads = [single]
    if not uploads:
        return JSONResponse({"error": "请至少上传一张标签图片。"}, status_code=400)
    if len(uploads) > MAX_IMAGES:
        return JSONResponse(
            {"error": f"最多一次上传 {MAX_IMAGES} 张图片。"}, status_code=400
        )

    data_urls: list[str] = []
    for up in uploads:
        raw = await up.read()
        if not raw:
            continue
        if len(raw) > MAX_IMAGE_BYTES:
            return JSONResponse(
                {"error": f"单张图片不能超过 {MAX_IMAGE_BYTES // (1024*1024)} MB。"},
                status_code=400,
            )
        ctype = (up.content_type or "").lower()
        if ctype and ctype not in ALLOWED_TYPES:
            return JSONResponse(
                {"error": f"不支持的图片格式：{ctype}"}, status_code=400
            )
        data_urls.append(llm.prepare_image(raw, ctype or None))

    if not data_urls:
        return JSONResponse({"error": "上传的图片为空。"}, status_code=400)

    try:
        result = await llm.analyze(data_urls, system_prompt())
    except llm.LLMError as e:
        return JSONResponse({"error": f"识别失败：{e}"}, status_code=502)

    return JSONResponse(_normalize(result))


def _normalize(result: dict) -> dict:
    """对模型输出做轻量校正：补全计数、保证字段存在，便于前端稳定渲染。"""
    if not isinstance(result, dict):
        return {"error": "模型返回格式异常。"}
    checks = result.get("checks") or []
    if not isinstance(checks, list):
        checks = []
    seen = {c.get("id") for c in checks if isinstance(c, dict)}
    by_id = {c["id"]: c["item"] for c in CHECKLIST}
    basis_by_id = {c["id"]: c["basis"] for c in CHECKLIST}
    cat_by_id = {c["id"]: c["category"] for c in CHECKLIST}
    # 模型漏判的检查项补成 unknown，保证清单完整。
    for cid in _CHECK_IDS:
        if cid not in seen:
            checks.append(
                {
                    "id": cid,
                    "category": cat_by_id[cid],
                    "item": by_id[cid],
                    "status": "unknown",
                    "finding": "模型未给出该项判定。",
                    "basis": basis_by_id[cid],
                }
            )
    counts = {"pass": 0, "fail": 0, "warn": 0, "na": 0, "unknown": 0}
    for c in checks:
        st = str(c.get("status", "unknown")).lower()
        if st not in counts:
            st = "unknown"
            c["status"] = "unknown"
        counts[st] += 1
    result["checks"] = checks
    summary = result.get("summary") or {}
    if not isinstance(summary, dict):
        summary = {}
    summary.setdefault("pass", counts["pass"])
    summary.setdefault("fail", counts["fail"])
    summary.setdefault("warn", counts["warn"])
    # verdict 缺失时按计数推断。
    if not summary.get("verdict"):
        if result.get("is_food_label") is False:
            summary["verdict"] = "not_a_label"
        elif counts["fail"]:
            summary["verdict"] = "non_compliant"
        elif counts["warn"]:
            summary["verdict"] = "issues"
        else:
            summary["verdict"] = "compliant"
    result["summary"] = summary
    result.setdefault("extracted", {})
    result.setdefault("suggestions", [])
    return result


# 静态前端挂在最后，避免吞掉 /api/*。
app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
