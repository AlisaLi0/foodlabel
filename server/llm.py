"""模型客户端：OCR 与识读/评价均走硅基流动（OpenAI 兼容）.

封装两类调用：

  * ocr_all(image)        并行跑 OCR 视觉模型（硅基流动 DeepSeek-OCR）识别标签文字
  * reason_json(...)      用识读/评价模型做返回 JSON 的调用（默认硅基流动 Qwen/Qwen3-8B）

配置（环境变量）：
    FOODLABEL_OCR_ENGINES 逗号分隔的 OCR 引擎，**全部并行执行**、结果都喂给识读步骤参考。
                       取值：rapidocr（本地 CPU 开源 PP-OCR）或远程模型 id（如 deepseek-ai/DeepSeek-OCR）。
                       默认 rapidocr,deepseek-ai/DeepSeek-OCR。想加更多模型一起识别，逗号追加即可。
    SF_BASE_URL        远程 OCR 网关，默认 https://api.siliconflow.cn/v1
    SF_API_KEY         远程 OCR 网关 key（用到远程 OCR 引擎时必填）
    SF_REASON_MODEL    识读/评价模型，默认 Qwen/Qwen3-8B
    SF_REASON_BASE_URL 识读/评价网关，默认 https://api.siliconflow.cn/v1
    SF_REASON_API_KEY  识读/评价网关 key；留空则回落用 SF_API_KEY/SF_BASE_URL
    SF_REASON_VISION   识读模型是否支持多模态：1/0 强制，留空则按模型名自动判断。
                       支持时识读阶段会把原始图片一并喂入做参考。
    SF_REASON_NO_THINK 关闭模型思考（Qwen3 等），默认 1（关）。关思考更快更稳。
    SF_TIMEOUT         秒，默认 120
"""
from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import re
import threading

import httpx

SF_BASE_URL = os.getenv("SF_BASE_URL", "https://api.siliconflow.cn/v1").rstrip("/")
SF_API_KEY = os.getenv("SF_API_KEY", "")
# 本地 RapidOCR 显示名（用于 /api/health 与结果归并）。
RAPIDOCR_NAME = "RapidOCR (PP-OCRv4 mobile)"
# RapidOCR 远程 HTTP 服务地址（4090 Docker，经 autossh 反向隧道）。
# 设了就走远程（卸载 tencent 弱机 CPU 压力）；留空则在本进程内直跑（需装 rapidocr）。
RAPIDOCR_URL = os.getenv("FOODLABEL_RAPIDOCR_URL", "").strip()
# OCR 引擎列表：逗号分隔，可混合本地与远程，**全部并行执行**、结果都喂给识读步骤做参考。
#   - "rapidocr"   → 本地 RapidOCR（CPU，开源 Apache-2.0，确定性、零成本）
#   - 其它模型 id（deepseek-ai/DeepSeek-OCR、Qwen/Qwen3-VL-8B-Instruct 等）→ 远程 VLM OCR
#     （走 SF_BASE_URL/SF_API_KEY 网关）。想加更多模型一起识别，逗号追加即可。
# 兼容旧变量 FOODLABEL_OCR_ENGINE（单数）。
_raw_ocr_engines = (
    os.getenv("FOODLABEL_OCR_ENGINES")
    or os.getenv("FOODLABEL_OCR_ENGINE")
    or "rapidocr,deepseek-ai/DeepSeek-OCR"
)
OCR_ENGINES = [e.strip() for e in _raw_ocr_engines.split(",") if e.strip()]
# 对外展示/结果归并用的模型名列表（与 OCR_ENGINES 顺序一致）。
OCR_MODELS = [(RAPIDOCR_NAME if e.lower() == "rapidocr" else e) for e in OCR_ENGINES]
# 识读 / 评价模型。默认硅基流动 Qwen/Qwen3-8B（免费、关思考约 90s、与 OCR 同网关）。
REASON_MODEL = os.getenv("SF_REASON_MODEL", "Qwen/Qwen3-8B")
# reason 网关；默认与 OCR 同走硅基流动。缺 key 时回落 OCR 网关 base/key。
REASON_BASE_URL = os.getenv("SF_REASON_BASE_URL", "https://api.siliconflow.cn/v1").rstrip("/")
REASON_API_KEY = os.getenv("SF_REASON_API_KEY", "")


def _looks_multimodal(model: str) -> bool:
    """按模型名粗判是否多模态（视觉）。仅作默认值，可被 SF_REASON_VISION 覆盖。"""
    m = (model or "").lower()
    return any(k in m for k in (
        "vl", "vision", "qwen3.6", "qwen2.5-vl", "qwen2-vl",
        "gpt-4o", "gpt-4.1", "gpt-5", "gemini", "claude-3", "claude-4",
        "claude-opus", "claude-sonnet", "internvl", "minicpm-v", "llava", "pixtral", "multimodal",
    ))


# 识读模型是否支持多模态：识读阶段支持时会把原始图片一并喂入做参考。
# SF_REASON_VISION=1/0 强制开关；留空则按模型名自动判断。
_vision_env = os.getenv("SF_REASON_VISION", "").strip().lower()
if _vision_env in ("1", "true", "yes", "on"):
    REASON_VISION = True
elif _vision_env in ("0", "false", "no", "off"):
    REASON_VISION = False
else:
    REASON_VISION = _looks_multimodal(REASON_MODEL)
# 关闭模型思考（硅基流动 Qwen3 等支持 chat_template_kwargs.enable_thinking=false）。
# 关思考更快更稳；不支持的网关会忽略此参数，加了无害。
_REASON_NO_THINK = os.getenv("SF_REASON_NO_THINK", "1") == "1"
# 结构化输出调用的采样温度。法律合规判定要求确定性，默认 0（贪心解码）。
_REASON_TEMPERATURE = float(os.getenv("SF_REASON_TEMPERATURE", "0"))
# 固定随机种子，进一步保证同输入同输出（服务端支持时生效）。
_REASON_SEED = int(os.getenv("SF_REASON_SEED", "42"))
_TIMEOUT = float(os.getenv("SF_TIMEOUT", "120"))
# 5xx / 超时重试次数与退避（秒）。
_RETRIES = int(os.getenv("SF_RETRIES", "2"))
_RETRY_BACKOFF = float(os.getenv("SF_RETRY_BACKOFF", "2"))
# 图片送模型前的长边上限（像素），控制 token 成本；0 关闭缩放。
_MAX_EDGE = int(os.getenv("SF_IMAGE_MAX_EDGE", "1600"))

# PaddleOCR-VL 等模型会在输出里夹带 <|LOC_123|> 之类坐标 token，清洗掉。
_LOC_TOKEN = re.compile(r"<\|[A-Za-z]+_\d+\|>")


class LLMError(RuntimeError):
    """硅基流动调用失败（网络、鉴权、上游错误等）。"""


def _headers(api_key: str = SF_API_KEY) -> dict:
    h = {"Content-Type": "application/json"}
    if api_key:
        h["Authorization"] = f"Bearer {api_key}"
    return h


def prepare_image(raw: bytes, content_type: str | None = None) -> str:
    """把图片字节转成 data URL。可用 Pillow 时顺带缩放/转 JPEG 以省 token。"""
    mime = content_type or "image/jpeg"
    data = raw
    try:
        from PIL import Image  # 可选依赖

        img = Image.open(io.BytesIO(raw)).convert("RGB")
        if _MAX_EDGE and max(img.size) > _MAX_EDGE:
            scale = _MAX_EDGE / max(img.size)
            img = img.resize((round(img.width * scale), round(img.height * scale)))
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=88)
        data = buf.getvalue()
        mime = "image/jpeg"
    except Exception:
        # Pillow 缺失或解码失败：原样发送原始字节。
        pass
    return f"data:{mime};base64,{base64.b64encode(data).decode()}"


async def _chat(payload: dict, *, base_url: str = SF_BASE_URL, api_key: str = SF_API_KEY) -> dict:
    """带重试的 chat/completions 调用，返回 message 字典。可指定网关 base/key。"""
    last: Exception | None = None
    for attempt in range(_RETRIES + 1):
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                resp = await client.post(
                    f"{base_url}/chat/completions", headers=_headers(api_key), json=payload
                )
                resp.raise_for_status()
                return resp.json()["choices"][0]["message"]
        except httpx.HTTPStatusError as e:
            code = e.response.status_code if e.response is not None else 0
            body = e.response.text[:200] if e.response is not None else ""
            last = LLMError(f"{payload.get('model')} 返回 {code}: {body}")
            if code not in (429, 500, 502, 503, 504, 524):
                raise last from e
        except (httpx.HTTPError, KeyError, IndexError) as e:
            last = LLMError(f"{payload.get('model')} 调用失败: {e}")
        if attempt < _RETRIES:
            await asyncio.sleep(_RETRY_BACKOFF * (attempt + 1))
    raise last or LLMError("调用失败")


def _msg_text(msg: dict) -> str:
    """取 message 正文；推理模型可能把答案放在 reasoning_content。"""
    return (msg.get("content") or msg.get("reasoning_content") or "").strip()


async def _chat_stream(payload: dict, *, base_url: str, api_key: str) -> str:
    """流式 chat/completions，返回拼接后的正文 content。

    推理型模型（Qwen3.6）思考 + 正文可能耗时 ~2 分钟，非流式会因代理/CF 空闲
    超时被掐断（RemoteDisconnected / 524）。流式边生成边收，连接不空闲，稳定得多。
    只累计 content（正文），思考过程 reasoning 丢弃。
    """
    payload = {**payload, "stream": True}
    last: Exception | None = None
    for attempt in range(_RETRIES + 1):
        content_parts: list[str] = []
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                async with client.stream(
                    "POST", f"{base_url}/chat/completions",
                    headers=_headers(api_key), json=payload,
                ) as resp:
                    resp.raise_for_status()
                    async for line in resp.aiter_lines():
                        line = line.strip()
                        if not line.startswith("data:"):
                            continue
                        data = line[5:].strip()
                        if data == "[DONE]":
                            break
                        try:
                            delta = json.loads(data)["choices"][0]["delta"]
                        except (json.JSONDecodeError, KeyError, IndexError):
                            continue
                        if delta.get("content"):
                            content_parts.append(delta["content"])
            text = "".join(content_parts).strip()
            if text:
                return text
            last = LLMError("流式响应未返回正文 content")
        except httpx.HTTPStatusError as e:
            code = e.response.status_code if e.response is not None else 0
            last = LLMError(f"{payload.get('model')} 返回 {code}")
            if code not in (429, 500, 502, 503, 504, 524):
                raise last from e
        except (httpx.HTTPError, KeyError, IndexError) as e:
            last = LLMError(f"{payload.get('model')} 流式调用失败: {e}")
        if attempt < _RETRIES:
            await asyncio.sleep(_RETRY_BACKOFF * (attempt + 1))
    raise last or LLMError("流式调用失败")


async def ocr(model: str, image_data_url: str, *, max_tokens: int = 3000) -> str:
    """对单张图片做 OCR，返回纯文本（清洗坐标 token）。"""
    content = [
        {
            "type": "text",
            "text": "请识别图片中的所有文字，按版面顺序逐行原样输出，保留数字、单位与标点，"
            "不要翻译、不要解释、不要输出坐标或任何额外标记。",
        },
        {"type": "image_url", "image_url": {"url": image_data_url}},
    ]
    msg = await _chat(
        {
            "model": model,
            "messages": [{"role": "user", "content": content}],
            "max_tokens": max_tokens,
        }
    )
    return _LOC_TOKEN.sub("", _msg_text(msg)).strip()


# ── 本地 RapidOCR 引擎（开源 PP-OCR，ONNXRuntime CPU；懒加载单例）──
_rapidocr_engine = None
_rapidocr_init_lock = threading.Lock()


def _get_rapidocr():
    """懒加载 RapidOCR 单例。首次约 1.3s 初始化，常驻内存 ~50MB。"""
    global _rapidocr_engine
    if _rapidocr_engine is None:
        with _rapidocr_init_lock:
            if _rapidocr_engine is None:
                from rapidocr import RapidOCR

                _rapidocr_engine = RapidOCR()
    return _rapidocr_engine


def _data_url_to_bytes(data_url: str) -> bytes:
    """data:image/...;base64,xxx → 原始字节。"""
    b64 = data_url.split(",", 1)[1] if "," in data_url else data_url
    return base64.b64decode(b64)


def _rapidocr_recognize(image_bytes: bytes) -> str:
    """同步跑 RapidOCR，按行拼接识别文本。在线程池里调用以免阻塞事件循环。"""
    engine = _get_rapidocr()
    res = engine(image_bytes)
    txts = getattr(res, "txts", None)
    if not txts:
        return ""
    return "\n".join(t for t in txts if t)


async def _rapidocr_remote(image_bytes: bytes) -> str:
    """调远程 RapidOCR HTTP 服务（4090 Docker）识别，返回文本。"""
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        resp = await client.post(
            RAPIDOCR_URL,
            files={"image": ("label.jpg", image_bytes, "image/jpeg")},
        )
        resp.raise_for_status()
        data = resp.json()
    if data.get("error"):
        raise LLMError(data["error"])
    return data.get("text", "")


async def _rapidocr_text(image_data_url: str) -> str:
    """RapidOCR 识别：设了 RAPIDOCR_URL 走远程 4090，否则本进程内直跑。"""
    raw = _data_url_to_bytes(image_data_url)
    if RAPIDOCR_URL:
        return await _rapidocr_remote(raw)
    return await asyncio.to_thread(_rapidocr_recognize, raw)


async def ocr_all(image_data_url: str) -> list[dict]:
    """并行跑所有配置的 OCR 引擎（本地 RapidOCR + 远程 VLM 等），所有结果都返回。

    返回 [{model, text, error}]，顺序与 OCR_ENGINES 一致；任一引擎失败只记 error，不影响其它。
    """
    async def one(engine: str) -> dict:
        name = RAPIDOCR_NAME if engine.lower() == "rapidocr" else engine
        try:
            if engine.lower() == "rapidocr":
                text = await _rapidocr_text(image_data_url)
            else:
                text = await ocr(engine, image_data_url)
            return {"model": name, "text": text, "error": None}
        except Exception as e:  # noqa: BLE001 — 单引擎失败降级为错误项，不中断整体
            return {"model": name, "text": "", "error": f"{name} 失败: {e}"}

    return list(await asyncio.gather(*(one(e) for e in OCR_ENGINES)))


async def reason_json(
    system: str, user: str, *, images: list[str] | None = None, max_tokens: int = 16000
) -> dict:
    """用识读/评价模型做一次返回 JSON 的调用（流式，走 reason 网关，默认硅基流动 Qwen3-8B）。

    用流式避免长响应被代理/CF 空闲超时掐断。默认关思考（_REASON_NO_THINK），
    输出更快更稳；max_tokens 上限给足以容纳较长的 JSON 报告（及可能的思考预算）。
    images（data URL 列表）仅在 reason 模型支持视觉时有效；纯文本模型（如 Qwen3-8B）请勿传。
    """
    # reason 网关未单独配 key 时回落到 OCR 网关（硅基流动）的 base/key。
    base = REASON_BASE_URL if REASON_API_KEY else SF_BASE_URL
    key = REASON_API_KEY or SF_API_KEY
    if images:
        user_content: list[dict] = [{"type": "text", "text": user}]
        for url in images:
            user_content.append({"type": "image_url", "image_url": {"url": url}})
    else:
        user_content = user  # 纯文本
    payload = {
        "model": REASON_MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user_content},
        ],
        "max_tokens": max_tokens,
        "temperature": _REASON_TEMPERATURE,
        "top_p": 1,
        "seed": _REASON_SEED,
        "response_format": {"type": "json_object"},
    }
    if _REASON_NO_THINK:
        payload["chat_template_kwargs"] = {"enable_thinking": False}
    text = await _chat_stream(payload, base_url=base, api_key=key)
    return _parse_json(text)


def _parse_json(text: str) -> dict:
    """尽力从模型输出中解析出 JSON 对象。"""
    try:
        return json.loads(text)
    except (json.JSONDecodeError, TypeError):
        start, end = text.find("{"), text.rfind("}")
        if start != -1 and end > start:
            try:
                return json.loads(text[start : end + 1])
            except json.JSONDecodeError:
                pass
    raise LLMError("模型未返回有效 JSON")
