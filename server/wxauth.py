"""微信小程序鉴权 + 免费额度（积分）—— 框架无关，供 server/app.py 的 wx 路由复用.

参照 recastly-wx-gateway 的成熟做法：
  * 自实现 HMAC-SHA256 JWT（不引第三方依赖）；
  * SQLite 存用户与积分流水；新用户赠送额度，每日免费补足，分享奖励；
  * jscode2session 用 code 换 openid。

配置（环境变量）：
    FOODLABEL_WX_APPID      小程序 AppID（必填才启用 wx 功能）
    FOODLABEL_WX_SECRET     小程序 AppSecret
    FOODLABEL_WX_JWT_SECRET 签发 token 用的密钥（务必设成随机长串）
    FOODLABEL_WX_DB         SQLite 路径，默认 <仓>/data/wx.db
    FOODLABEL_WX_SIGNUP_CREDITS   新用户赠送次数，默认 5
    FOODLABEL_WX_DAILY_FREE       每日免费补足到的次数，默认 5
    FOODLABEL_WX_SHARE_REWARD     分享奖励次数，默认 2
    FOODLABEL_WX_COST_PER_CHECK   每次检查消耗次数，默认 1
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import sqlite3
import time
from datetime import datetime, timedelta, timezone

WX_APPID = os.getenv("FOODLABEL_WX_APPID", "")
WX_SECRET = os.getenv("FOODLABEL_WX_SECRET", "")
_JWT_SECRET = os.getenv("FOODLABEL_WX_JWT_SECRET", "").encode() or b"foodlabel-dev-secret-change-me"
_DB_PATH = os.getenv(
    "FOODLABEL_WX_DB",
    os.path.join(os.path.dirname(__file__), "..", "data", "wx.db"),
)
SIGNUP_CREDITS = int(os.getenv("FOODLABEL_WX_SIGNUP_CREDITS", "10"))
DAILY_FREE = int(os.getenv("FOODLABEL_WX_DAILY_FREE", "10"))
SHARE_REWARD = int(os.getenv("FOODLABEL_WX_SHARE_REWARD", "2"))
COST_PER_CHECK = int(os.getenv("FOODLABEL_WX_COST_PER_CHECK", "1"))
_TOKEN_TTL = 30 * 86400  # 30 天

_CN_TZ = timezone(timedelta(hours=8))


def wx_enabled() -> bool:
    """是否配齐了 wx 接入所需的 AppID/Secret。"""
    return bool(WX_APPID and WX_SECRET)


class WxError(Exception):
    """wx 鉴权/额度错误，携带 HTTP 状态码。"""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


# ── SQLite ──
def _db() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(_DB_PATH), exist_ok=True)
    c = sqlite3.connect(_DB_PATH, isolation_level=None, timeout=10.0)
    c.row_factory = sqlite3.Row
    return c


def init_db() -> None:
    """建表（幂等）。服务启动时调用。"""
    conn = _db()
    conn.execute(
        """CREATE TABLE IF NOT EXISTS users(
            openid TEXT PRIMARY KEY,
            unionid TEXT,
            credits INTEGER NOT NULL DEFAULT 0,
            daily_topup_date TEXT,
            share_date TEXT,
            created_at INTEGER,
            last_seen_at INTEGER
        )"""
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS credit_log(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            openid TEXT, delta INTEGER, reason TEXT, ts INTEGER
        )"""
    )
    # 小程序识别历史：图片与结果存服务器，用户可手动删除。seq 自增保证同秒内排序稳定。
    conn.execute(
        """CREATE TABLE IF NOT EXISTS history(
            id TEXT PRIMARY KEY,
            seq INTEGER,
            openid TEXT NOT NULL,
            created_at INTEGER,
            verdict TEXT,
            score INTEGER,
            food_name TEXT,
            images TEXT,
            result TEXT
        )"""
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_history_openid ON history(openid, seq DESC)"
    )
    conn.close()


def _today() -> str:
    return datetime.now(_CN_TZ).strftime("%Y-%m-%d")


# ── HMAC-JWT（无第三方依赖）──
def _b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _b64u_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def sign_token(openid: str) -> str:
    payload = {"openid": openid, "iat": int(time.time()), "exp": int(time.time()) + _TOKEN_TTL}
    body = _b64u(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode())
    sig = _b64u(hmac.new(_JWT_SECRET, body.encode(), hashlib.sha256).digest())
    return f"{body}.{sig}"


def verify_token(token: str) -> str:
    try:
        body, sig = token.split(".", 1)
    except ValueError:
        raise WxError(401, "token 格式错误")
    expected = _b64u(hmac.new(_JWT_SECRET, body.encode(), hashlib.sha256).digest())
    if not hmac.compare_digest(expected, sig):
        raise WxError(401, "token 签名无效")
    payload = json.loads(_b64u_decode(body))
    if payload.get("exp", 0) < time.time():
        raise WxError(401, "token 已过期")
    return payload["openid"]


def auth_openid(authorization: str | None, x_wx_token: str | None) -> str:
    """从 Authorization: Bearer 或 X-WX-Token 头解析并校验 openid。"""
    tok = None
    if authorization and authorization.lower().startswith("bearer "):
        tok = authorization[7:].strip()
    elif x_wx_token:
        tok = x_wx_token.strip()
    if not tok:
        raise WxError(401, "缺少 token")
    return verify_token(tok)


# ── 用户与积分 ──
def ensure_user(openid: str, unionid: str | None = None) -> dict:
    """取用户；不存在则建（送注册额度），存在则按需做每日免费补足。"""
    now = int(time.time())
    today = _today()
    conn = _db()
    row = conn.execute("SELECT * FROM users WHERE openid=?", (openid,)).fetchone()
    if not row:
        conn.execute(
            "INSERT INTO users(openid, unionid, credits, daily_topup_date, created_at, last_seen_at)"
            " VALUES (?,?,?,?,?,?)",
            (openid, unionid, SIGNUP_CREDITS, today, now, now),
        )
        conn.execute(
            "INSERT INTO credit_log(openid, delta, reason, ts) VALUES (?,?,'signup',?)",
            (openid, SIGNUP_CREDITS, now),
        )
    else:
        if (row["daily_topup_date"] or "") != today:
            if row["credits"] < DAILY_FREE:
                delta = DAILY_FREE - row["credits"]
                conn.execute(
                    "UPDATE users SET credits=?, daily_topup_date=?, last_seen_at=? WHERE openid=?",
                    (DAILY_FREE, today, now, openid),
                )
                conn.execute(
                    "INSERT INTO credit_log(openid, delta, reason, ts) VALUES (?,?,'daily_topup',?)",
                    (openid, delta, now),
                )
            else:
                conn.execute(
                    "UPDATE users SET daily_topup_date=?, last_seen_at=? WHERE openid=?",
                    (today, now, openid),
                )
        else:
            conn.execute("UPDATE users SET last_seen_at=? WHERE openid=?", (now, openid))
    row = conn.execute("SELECT * FROM users WHERE openid=?", (openid,)).fetchone()
    user = dict(row)
    conn.close()
    return user


def deduct(openid: str, amount: int, reason: str) -> int | None:
    """扣减积分；不足返回 None。"""
    now = int(time.time())
    conn = _db()
    row = conn.execute("SELECT credits FROM users WHERE openid=?", (openid,)).fetchone()
    if not row or row["credits"] < amount:
        conn.close()
        return None
    new_balance = row["credits"] - amount
    conn.execute("UPDATE users SET credits=? WHERE openid=?", (new_balance, openid))
    conn.execute(
        "INSERT INTO credit_log(openid, delta, reason, ts) VALUES (?,?,?,?)",
        (openid, -amount, reason, now),
    )
    conn.close()
    return new_balance


def refund(openid: str, amount: int, reason: str) -> int:
    """退还积分（如检查失败）。"""
    now = int(time.time())
    conn = _db()
    conn.execute("UPDATE users SET credits=credits+? WHERE openid=?", (amount, openid))
    row = conn.execute("SELECT credits FROM users WHERE openid=?", (openid,)).fetchone()
    conn.execute(
        "INSERT INTO credit_log(openid, delta, reason, ts) VALUES (?,?,?,?)",
        (openid, amount, reason, now),
    )
    conn.close()
    return row["credits"]


def claim_share_reward(openid: str) -> dict:
    """分享奖励，每日 1 次。"""
    now = int(time.time())
    today = _today()
    conn = _db()
    row = conn.execute("SELECT * FROM users WHERE openid=?", (openid,)).fetchone()
    if not row:
        conn.close()
        raise WxError(404, "用户不存在")
    if (row["share_date"] or "") == today:
        conn.close()
        raise WxError(429, "今日已领取")
    new_credits = row["credits"] + SHARE_REWARD
    conn.execute(
        "UPDATE users SET credits=?, share_date=? WHERE openid=?", (new_credits, today, openid)
    )
    conn.execute(
        "INSERT INTO credit_log(openid, delta, reason, ts) VALUES (?,?,'share_reward',?)",
        (openid, SHARE_REWARD, now),
    )
    conn.close()
    return {"credits": new_credits, "share_claimed_today": True, "share_reward_amount": SHARE_REWARD}


async def jscode2session(code: str) -> dict:
    """用 wx.login 的 code 换 openid/session。"""
    import httpx

    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.get(
            "https://api.weixin.qq.com/sns/jscode2session",
            params={
                "appid": WX_APPID,
                "secret": WX_SECRET,
                "js_code": code,
                "grant_type": "authorization_code",
            },
        )
    j = r.json()
    if "openid" not in j:
        raise WxError(400, j.get("errmsg") or "微信登录失败")
    return j


# ── 识别历史（图片+结果存服务器，用户可删除）──
import json as _json
import uuid as _uuid

# 每用户保留的历史条数上限，超出删最旧（同时其图片文件由上层清理）。
HISTORY_MAX = int(os.getenv("FOODLABEL_WX_HISTORY_MAX", "50"))


def add_history(openid: str, images: list[str], result: dict) -> str:
    """新增一条识别历史，返回 id。images 为公网图片 URL 列表。"""
    hid = _uuid.uuid4().hex
    now = int(time.time())
    summary = (result or {}).get("summary") or {}
    extracted = (result or {}).get("extracted") or {}
    food_name = extracted.get("food_name") if isinstance(extracted.get("food_name"), str) else ""
    conn = _db()
    # seq 用全表当前最大值 +1，保证严格递增（同秒内排序稳定）。
    row = conn.execute("SELECT COALESCE(MAX(seq), 0) AS m FROM history").fetchone()
    seq = int(row["m"]) + 1
    conn.execute(
        "INSERT INTO history(id, seq, openid, created_at, verdict, score, food_name, images, result)"
        " VALUES (?,?,?,?,?,?,?,?,?)",
        (
            hid, seq, openid, now,
            summary.get("verdict") or "issues",
            int(summary.get("score") or 0),
            food_name or "",
            _json.dumps(images or [], ensure_ascii=False),
            _json.dumps(result or {}, ensure_ascii=False),
        ),
    )
    conn.close()
    return hid


def list_history(openid: str, limit: int = HISTORY_MAX) -> list[dict]:
    """列出某用户的历史（不含完整 result，仅摘要 + 首图缩略）。按时间倒序。"""
    conn = _db()
    rows = conn.execute(
        "SELECT id, created_at, verdict, score, food_name, images FROM history"
        " WHERE openid=? ORDER BY seq DESC LIMIT ?",
        (openid, limit),
    ).fetchall()
    conn.close()
    out: list[dict] = []
    for r in rows:
        try:
            imgs = _json.loads(r["images"] or "[]")
        except (ValueError, TypeError):
            imgs = []
        out.append({
            "id": r["id"], "ts": r["created_at"], "verdict": r["verdict"],
            "score": r["score"], "food_name": r["food_name"],
            "thumb": imgs[0] if imgs else "",
        })
    return out


def get_history(openid: str, hid: str) -> dict | None:
    """取某条历史完整内容（result + images），仅本人可取。"""
    conn = _db()
    r = conn.execute(
        "SELECT id, created_at, images, result FROM history WHERE id=? AND openid=?",
        (hid, openid),
    ).fetchone()
    conn.close()
    if not r:
        return None
    try:
        result = _json.loads(r["result"] or "{}")
    except (ValueError, TypeError):
        result = {}
    try:
        images = _json.loads(r["images"] or "[]")
    except (ValueError, TypeError):
        images = []
    return {"id": r["id"], "ts": r["created_at"], "result": result, "images": images}


def delete_history(openid: str, hid: str) -> list[str]:
    """删除某条历史（仅本人）。返回被删记录的图片 URL 列表，供上层删文件。"""
    conn = _db()
    r = conn.execute(
        "SELECT images FROM history WHERE id=? AND openid=?", (hid, openid)
    ).fetchone()
    if not r:
        conn.close()
        return []
    conn.execute("DELETE FROM history WHERE id=? AND openid=?", (hid, openid))
    conn.close()
    try:
        return _json.loads(r["images"] or "[]")
    except (ValueError, TypeError):
        return []


def trim_history(openid: str, keep: int = HISTORY_MAX) -> list[str]:
    """超出上限时删除最旧历史。返回被删记录的所有图片 URL，供上层删文件。"""
    conn = _db()
    rows = conn.execute(
        "SELECT id, images FROM history WHERE openid=? ORDER BY seq DESC", (openid,)
    ).fetchall()
    extra = rows[keep:]
    removed: list[str] = []
    for r in extra:
        conn.execute("DELETE FROM history WHERE id=?", (r["id"],))
        try:
            removed += _json.loads(r["images"] or "[]")
        except (ValueError, TypeError):
            pass
    conn.close()
    return removed
