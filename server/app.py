"""biaoqianshibie 后端 API — 食品标签国标合规检查.

纯 JSON API（前后端分离，参照 JuriCodex）：
  POST /api/check          上传标签图片 → 一次性返回结构化合规报告（供 MCP/脚本）
  POST /api/check/start    启动后台检查 → 返回 job_id（处理脱离请求，切页/刷新不中断）
  GET  /api/check/stream   ?job_id=&from= 拉取分步事件流（SSE），可断线重连续接
  GET  /api/checklist      返回检查清单与标准依据
  GET  /api/health         健康检查
核心识读/判定逻辑在 server/core.py（框架无关，供 MCP server 复用）。

前端是独立的静态资源（web/），通过可配置的 API base 调用本 API；为方便起见，
本服务也可同源托管该静态前端（FOODLABEL_SERVE_WEB）。CORS 由 FOODLABEL_CORS_ORIGINS
控制，允许前端单独部署在其他源。

生产同源部署：nginx 反代到 https://docs-tools.online/biaoqianshibie/（Basic Auth 加锁）。
"""
from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from collections import deque

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
# request.form() 返回 starlette 的 UploadFile；fastapi.UploadFile 是其子类，
# isinstance 判定要用 starlette 的基类，否则恒为 False。
from starlette.datastructures import UploadFile

from . import core, llm, wxauth
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


# ── 后台任务存储：让检查脱离单次请求生命周期，切页/刷新/断线都不中断处理 ──
# 每个任务把分步事件**追加缓冲**到 events 列表（永不删除，索引稳定），
# SSE 消费端可从任意 from 索引回放 + 续接；多次重连/多个监听端都可以。
_JOBS: dict[str, dict] = {}
# 任务数量上限与保留时长（秒）：已完成任务多保留一会儿，供刷新后回放最终结果。
_JOBS_MAX = int(os.getenv("FOODLABEL_JOBS_MAX", "200"))
_JOB_TTL = int(os.getenv("FOODLABEL_JOB_TTL", "3600"))
_JOB_DONE_TTL = int(os.getenv("FOODLABEL_JOB_DONE_TTL", "1800"))


def _gc_jobs() -> None:
    """清理过期/超量任务：先按 TTL 删，再超量时优先删最老的已完成任务。"""
    now = time.time()
    for jid in [
        jid for jid, j in _JOBS.items()
        if now - j["created"] > _JOB_TTL
        or (j["done"] and now - j["updated"] > _JOB_DONE_TTL)
    ]:
        _JOBS.pop(jid, None)
    if len(_JOBS) > _JOBS_MAX:
        for jid, _ in sorted(_JOBS.items(), key=lambda kv: (not kv[1]["done"], kv[1]["created"])):
            if len(_JOBS) <= _JOBS_MAX:
                break
            _JOBS.pop(jid, None)


async def _run_job(job_id: str, data_urls: list[str], doc_text: str = "") -> None:
    """后台跑分步分析，把事件追加进任务缓冲；与请求连接解耦，断线不影响。"""
    job = _JOBS[job_id]
    cond: asyncio.Condition = job["cond"]

    async def emit(ev: dict) -> None:
        async with cond:
            job["events"].append(ev)
            job["updated"] = time.time()
            cond.notify_all()

    try:
        async for ev in core.analyze_steps(data_urls, doc_text):
            await emit(ev)
    except llm.LLMError as e:
        await emit({"stage": "error", "status": "error", "error": f"识别失败：{e}"})
    except Exception as e:  # noqa: BLE001 — 兜底，避免任务悬挂
        await emit({"stage": "error", "status": "error", "error": f"服务异常：{e}"})
    finally:
        async with cond:
            job["done"] = True
            job["updated"] = time.time()
            cond.notify_all()


@app.get("/api/health")
async def health() -> dict:
    return {
        "ok": True,
        "ocr_models": llm.OCR_MODELS,
        "reason_model": llm.REASON_MODEL,
        "reason_vision": llm.REASON_VISION,
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

    items = await _read_uploads(request)
    try:
        result = await core.check_inputs(
            items, max_images=MAX_IMAGES, max_bytes=MAX_IMAGE_BYTES
        )
    except core.InputError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    except llm.LLMError as e:
        return JSONResponse({"error": f"识别失败：{e}"}, status_code=502)

    return JSONResponse(result)


async def _read_uploads(request: Request) -> list[tuple[bytes, str | None, str | None]]:
    form = await request.form()
    # 图片走 images 字段、文档（PDF/Word/TXT）走 docs 字段；两者合并后由 core 按类型分流。
    uploads = [v for v in form.getlist("images") if isinstance(v, UploadFile)]
    uploads += [v for v in form.getlist("docs") if isinstance(v, UploadFile)]
    if not uploads:
        single = form.get("image")
        if isinstance(single, UploadFile):
            uploads = [single]
    items: list[tuple[bytes, str | None, str | None]] = []
    for up in uploads:
        raw = await up.read()
        items.append((raw, (up.content_type or "").lower() or None, up.filename or None))
    return items


@app.post("/api/check/start")
async def check_start(request: Request) -> JSONResponse:
    """启动一次后台检查，立即返回 job_id。处理脱离本请求，切页/刷新不会中断。

    前端拿 job_id 后用 GET /api/check/stream?job_id=&from= 拉取分步事件，可随时重连续接。
    """
    ip = request.headers.get("x-real-ip") or (request.client.host if request.client else "?")
    if _rate_limited(ip):
        return JSONResponse({"error": "请求过于频繁，请稍后再试。"}, status_code=429)

    items = await _read_uploads(request)
    try:
        data_urls, doc_text = core.prepare_inputs(items, max_images=MAX_IMAGES, max_bytes=MAX_IMAGE_BYTES)
    except core.InputError as e:
        return JSONResponse({"error": str(e)}, status_code=400)

    _gc_jobs()
    job_id = uuid.uuid4().hex
    _JOBS[job_id] = {
        "events": [], "done": False,
        "created": time.time(), "updated": time.time(),
        "cond": asyncio.Condition(),
    }
    # 后台任务：与请求解耦，客户端断开也照常跑完。
    asyncio.create_task(_run_job(job_id, data_urls, doc_text))
    return JSONResponse({"job_id": job_id})


@app.get("/api/check/stream")
async def check_stream(request: Request):
    """按 job_id 拉取分步事件流（SSE）。先回放 from 起的已缓冲事件，再续推实时事件。

    可被多次重连：刷新/切页/断线后带上已收到的事件数作为 from，即可无缝续接、不丢步骤。
    """
    job_id = request.query_params.get("job_id", "")
    try:
        from_ = max(0, int(request.query_params.get("from", "0") or 0))
    except ValueError:
        from_ = 0

    job = _JOBS.get(job_id)
    if job is None:
        return JSONResponse({"error": "任务不存在或已过期，请重新上传检查。"}, status_code=404)

    cond: asyncio.Condition = job["cond"]

    async def gen():
        def sse(obj: dict, idx: int) -> bytes:
            return (
                f"id: {idx}\n"
                + "data: " + json.dumps(obj, ensure_ascii=False) + "\n\n"
            ).encode("utf-8")

        idx = from_
        while True:
            batch: list[tuple[int, dict]] = []
            async with cond:
                while idx >= len(job["events"]) and not job["done"]:
                    try:
                        await asyncio.wait_for(cond.wait(), timeout=15)
                    except asyncio.TimeoutError:
                        break  # 退出锁去发一个心跳，避免连接被中间层判空闲掐断
                while idx < len(job["events"]):
                    batch.append((idx, job["events"][idx]))
                    idx += 1
                finished = job["done"] and idx >= len(job["events"])
            if batch:
                for i, ev in batch:
                    yield sse(ev, i)
            else:
                yield b": keep-alive\n\n"  # SSE 注释行，仅保活，不触发前端事件
            if finished:
                break

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ───────────────────────────── 微信小程序接口 ─────────────────────────────
# 复用上面的后台任务（_JOBS/_run_job），小程序无法用 SSE，改用 上传起任务 + 轮询结果。
wxauth.init_db()


def _wx_guard(request: Request):
    """未配 AppID/Secret 时统一 503；wx 鉴权错误转对应状态码。返回 (openid|None, error_response|None)。"""
    if not wxauth.wx_enabled():
        return None, JSONResponse({"error": "小程序后端未配置。"}, status_code=503)
    try:
        openid = wxauth.auth_openid(
            request.headers.get("authorization"), request.headers.get("x-wx-token")
        )
        return openid, None
    except wxauth.WxError as e:
        return None, JSONResponse({"error": e.message}, status_code=e.status)


@app.get("/api/wx/health")
async def wx_health() -> dict:
    return {"ok": True, "wx_enabled": wxauth.wx_enabled()}


@app.post("/api/wx/login")
async def wx_login(request: Request) -> JSONResponse:
    if not wxauth.wx_enabled():
        return JSONResponse({"error": "小程序后端未配置。"}, status_code=503)
    data = await request.json()
    code = (data or {}).get("code")
    if not code:
        return JSONResponse({"error": "缺少 code"}, status_code=400)
    try:
        sess = await wxauth.jscode2session(code)
    except wxauth.WxError as e:
        return JSONResponse({"error": e.message}, status_code=e.status)
    openid = sess["openid"]
    user = wxauth.ensure_user(openid, sess.get("unionid"))
    return JSONResponse(
        {"token": wxauth.sign_token(openid), "credits": user["credits"], "openid_short": openid[:8]}
    )


@app.get("/api/wx/me")
async def wx_me(request: Request) -> JSONResponse:
    openid, err = _wx_guard(request)
    if err:
        return err
    user = wxauth.ensure_user(openid)
    return JSONResponse(
        {
            "credits": user["credits"],
            "share_claimed_today": (user.get("share_date") or "") == wxauth._today(),
            "share_reward_amount": wxauth.SHARE_REWARD,
            "cost_per_check": wxauth.COST_PER_CHECK,
        }
    )


@app.post("/api/wx/share-reward")
async def wx_share_reward(request: Request) -> JSONResponse:
    openid, err = _wx_guard(request)
    if err:
        return err
    try:
        return JSONResponse(wxauth.claim_share_reward(openid))
    except wxauth.WxError as e:
        return JSONResponse({"error": e.message}, status_code=e.status)


@app.post("/api/wx/check")
async def wx_check(request: Request) -> JSONResponse:
    """小程序上传图片起检查任务：扣额度 → 起后台任务 → 返回 job_id。结果走 /api/wx/result 轮询。"""
    openid, err = _wx_guard(request)
    if err:
        return err
    wxauth.ensure_user(openid)

    items = await _read_uploads(request)
    try:
        data_urls = core.prepare_items(items, max_images=MAX_IMAGES, max_bytes=MAX_IMAGE_BYTES)
    except core.InputError as e:
        return JSONResponse({"error": str(e)}, status_code=400)

    balance = wxauth.deduct(openid, wxauth.COST_PER_CHECK, "check")
    if balance is None:
        return JSONResponse(
            {"error": "免费次数已用完，请明天再来或分享获取。", "credits": 0}, status_code=402
        )

    _gc_jobs()
    job_id = uuid.uuid4().hex
    _JOBS[job_id] = {
        "events": [], "done": False, "owner": openid,
        "created": time.time(), "updated": time.time(),
        "cond": asyncio.Condition(),
    }
    asyncio.create_task(_run_job(job_id, data_urls))
    return JSONResponse({"job_id": job_id, "credits": balance})


@app.get("/api/wx/result")
async def wx_result(request: Request) -> JSONResponse:
    """轮询任务进度与结果：返回当前步数 + 识读/规则/最终报告，便于小程序逐步渲染。"""
    openid, err = _wx_guard(request)
    if err:
        return err
    job_id = request.query_params.get("job_id", "")
    job = _JOBS.get(job_id)
    if job is None:
        return JSONResponse({"error": "任务不存在或已过期。"}, status_code=404)
    if job.get("owner") and job["owner"] != openid:
        return JSONResponse({"error": "无权访问该任务。"}, status_code=403)

    events = list(job["events"])
    extract = rules = result = error = None
    for e in events:
        st, status = e.get("stage"), e.get("status")
        if st == "error":
            error = e.get("error")
        elif st == "extract" and status == "done":
            extract = {
                "is_food_label": e.get("is_food_label"),
                "label_type": e.get("label_type"),
                "extracted": e.get("extracted"),
            }
        elif st == "rules" and status == "done":
            rules = e.get("rules")
        elif st == "done" and status == "done":
            result = e.get("result")

    # 检查整体失败：退还本次扣费（仅退一次）。
    if error and not job.get("refunded"):
        job["refunded"] = True
        wxauth.refund(openid, wxauth.COST_PER_CHECK, "check_failed")

    step = max([e.get("step", 0) for e in events if e.get("status") == "done"], default=0)
    return JSONResponse(
        {"done": bool(job["done"]), "step": step, "extract": extract,
         "rules": rules, "result": result, "error": error}
    )


# 同源托管静态前端（挂在最后，避免吞掉 /api/*）。前后端分离纯 API 部署可设 FOODLABEL_SERVE_WEB=0。
if SERVE_WEB and os.path.isdir(WEB_DIR):
    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
