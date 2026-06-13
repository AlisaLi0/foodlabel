"""微信内容安全（内容审核）—— access_token 缓存 + 文本同步检测 + 图片异步送检.

依据微信官方接口（2023 起 v1 imgSecCheck/msgSecCheck 已升级为以下版本）：
  * 凭证：GET https://api.weixin.qq.com/cgi-bin/stable_token  （稳定版 access_token，
          与普通 token 隔离、可重复获取同一个，有效期 7200s）
  * 文本：POST /wxa/msg_sec_check?access_token=  body={version:2, openid, scene, content}
          同步返回 result.suggest ∈ pass|review|risky
  * 图片：POST /wxa/media_check_async?access_token=  body={media_url|media_type, openid, scene}
          异步——仅"提交送检"成功返回 trace_id，违规结果由微信消息推送回调下发。

设计原则（fail-open）：内容安全是"附加防线"，上游接口异常/超时**不应**阻断用户正常使用，
仅在明确判定 risky（违规）时拦截。配置缺失（无 AppID/Secret）时全部直接放行。

配置（环境变量，复用 wxauth 的 AppID/Secret）：
    FOODLABEL_WX_APPID / FOODLABEL_WX_SECRET
    FOODLABEL_SECCHECK_ENABLE   1 开启（默认）/ 0 关闭整套内容安全
"""
from __future__ import annotations

import hashlib
import os
import time

import httpx

from . import wxauth

_API = "https://api.weixin.qq.com"
_ENABLE = os.getenv("FOODLABEL_SECCHECK_ENABLE", "1") != "0"
# 消息推送（接收 media_check_async 异步结果）配置：在小程序后台「开发设置→消息推送」填同样的 Token。
CALLBACK_TOKEN = os.getenv("FOODLABEL_WX_CALLBACK_TOKEN", "")
# 公网基址，用于把落盘图片拼成微信可访问的 media_url（默认线上站点子路径）。
PUBLIC_BASE = os.getenv("FOODLABEL_PUBLIC_BASE", "https://docs-tools.online/biaoqianshibie").rstrip("/")

# access_token 进程内缓存：{token, exp}。stable_token 有效期 7200s，提前 5min 过期刷新。
_token_cache: dict = {"token": "", "exp": 0.0}

# 异步图片送检的 trace_id → {openid, ts} 映射，回调时据此定位用户/任务（进程内，TTL 1h）。
_traces: dict[str, dict] = {}
# 被判违规的图片公网 url 集合（回调写入），供任务侧/人工侧查询。进程内即可。
flagged_urls: set[str] = set()


def enabled() -> bool:
    """是否启用内容安全（需配齐 AppID/Secret 且未显式关闭）。"""
    return _ENABLE and wxauth.wx_enabled()


async def _get_access_token() -> str:
    """取（带缓存的）stable_token。失败抛 httpx/RuntimeError，由调用方按 fail-open 兜底。"""
    now = time.time()
    if _token_cache["token"] and now < _token_cache["exp"]:
        return _token_cache["token"]
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.post(
            f"{_API}/cgi-bin/stable_token",
            json={
                "grant_type": "client_credential",
                "appid": wxauth.WX_APPID,
                "secret": wxauth.WX_SECRET,
            },
        )
    j = r.json()
    tok = j.get("access_token")
    if not tok:
        raise RuntimeError(f"获取 access_token 失败：{j.get('errmsg') or j}")
    _token_cache["token"] = tok
    _token_cache["exp"] = now + int(j.get("expires_in", 7200)) - 300
    return tok


async def check_text(content: str, openid: str, scene: int = 2) -> tuple[bool, str]:
    """文本内容安全（同步）。返回 (allowed, label)。

    scene：1 资料 / 2 评论 / 3 论坛 / 4 社交日志。标签上传内容按"评论"(2)。
    判 risky → (False, 'risky')；pass/review/接口异常 → (True, ...) 放行（fail-open）。
    """
    if not enabled():
        return True, "disabled"
    text = (content or "").strip()
    if not text:
        return True, "empty"
    # 接口单次上限约 2500 字（UTF-8 计），超出截断送检。
    text = text[:2500]
    try:
        token = await _get_access_token()
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.post(
                f"{_API}/wxa/msg_sec_check?access_token={token}",
                json={"version": 2, "openid": openid, "scene": scene, "content": text},
            )
        j = r.json()
    except Exception:  # noqa: BLE001 — fail-open：上游异常不阻断业务
        return True, "error"
    if j.get("errcode", 0) != 0:
        # 87014=内容含违规 → 明确拦截；其它错误码（token/限频等）放行。
        if j.get("errcode") == 87014:
            return False, "risky"
        return True, f"errcode:{j.get('errcode')}"
    suggest = ((j.get("result") or {}).get("suggest")) or "pass"
    return (suggest != "risky"), suggest


async def submit_image(media_url: str, openid: str, scene: int = 2) -> tuple[bool, str]:
    """图片内容安全（异步提交送检）。返回 (submitted, trace_id_or_reason)。

    media_check_async 仅"提交"是同步的；违规结果由微信消息推送异步回调下发（见 handle_callback）。
    送检成功后记录 trace_id→openid 映射，供回调定位。fail-open：异常不阻断业务。
    """
    if not enabled() or not media_url:
        return True, "disabled"
    try:
        token = await _get_access_token()
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.post(
                f"{_API}/wxa/media_check_async?access_token={token}",
                json={"media_type": 2, "media_url": media_url, "version": 2,
                      "openid": openid, "scene": scene},
            )
        j = r.json()
    except Exception:  # noqa: BLE001 — fail-open
        return True, "error"
    if j.get("errcode", 0) != 0:
        return True, f"errcode:{j.get('errcode')}"
    trace_id = j.get("trace_id") or ""
    if trace_id:
        _gc_traces()
        _traces[trace_id] = {"openid": openid, "url": media_url, "ts": time.time()}
    return True, (trace_id or "submitted")


def _gc_traces() -> None:
    """清理过期 trace 映射（TTL 1h）。"""
    now = time.time()
    for tid in [t for t, v in _traces.items() if now - v.get("ts", 0) > 3600]:
        _traces.pop(tid, None)


def verify_signature(token: str, signature: str, timestamp: str, nonce: str) -> bool:
    """微信消息推送 URL 校验：sha1(sort(token,timestamp,nonce)) == signature。"""
    arr = sorted([token or "", timestamp or "", nonce or ""])
    sha = hashlib.sha1("".join(arr).encode("utf-8")).hexdigest()
    return sha == (signature or "")


def handle_callback(data: dict) -> None:
    """处理 media_check_async 异步回调结果。违规图片记入 flagged_urls，并按 openid 标记。

    微信推送的事件结构（明文模式）大致：
      {"Event":"wxa_media_check","trace_id":...,"result":{"suggest":"risky|pass",...},...}
    suggest=risky 视为违规。fail-safe：解析异常忽略，不抛。
    """
    try:
        trace_id = data.get("trace_id") or ""
        result = data.get("result") or {}
        suggest = result.get("suggest") or data.get("suggest")
        info = _traces.pop(trace_id, None)
        if suggest == "risky":
            url = (info or {}).get("url")
            if url:
                flagged_urls.add(url)
    except Exception:  # noqa: BLE001 — 回调容错，绝不抛
        pass

