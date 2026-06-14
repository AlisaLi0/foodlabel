"""框架无关的核心：食品标签 → OCR 识别 → 文本识读 → 适用规则 → 国标比对 → 规范化报告.

本模块不依赖任何 Web 框架，便于被 FastAPI 后端与 MCP server 共同复用：

  * FastAPI 后端（server/app.py）解析 multipart 后调用本模块。
  * MCP server 直接以 data URL / base64 调用本模块。

流程（analyze_steps 分步生成器）：
  1) DeepSeek-OCR 识别图片文字；
  2) Qwen3-8B 据 OCR 文本识读出结构化字段与营养成分表；
  3) Qwen3-8B 受限分类出食品类目 → 代码确定性映射各项适用/豁免；
  4) Qwen3-8B 基于适用规则逐条对照 GB 7718-2025 / GB 28050-2025，
     输出 checks 与 missing / problems / risks（缺失/问题/风险点）。

校验类错误统一抛 InputError（上层映射为 400）；模型/网络错误由 llm.LLMError
向上抛（上层映射为 502）。
"""
from __future__ import annotations

import json
import time

from . import doctext, llm
from .standards import (
    CHECKLIST,
    analyze_system,
    applicable_for,
    category_info,
    evaluate_checks,
    extract_system,
    rules_system,
)

# 允许的图片 MIME 类型。
ALLOWED_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif", "image/bmp"}
# 图片扩展名，用于浏览器/客户端未带 content-type 时按文件名兜底判定。
_IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp")
DEFAULT_MAX_IMAGES = 3
DEFAULT_MAX_DOCS = 4
DEFAULT_MAX_BYTES = 8 * 1024 * 1024

_CHECK_IDS = [c["id"] for c in CHECKLIST]
_ITEM_BY_ID = {c["id"]: c["item"] for c in CHECKLIST}
_BASIS_BY_ID = {c["id"]: c["basis"] for c in CHECKLIST}
_CAT_BY_ID = {c["id"]: c["category"] for c in CHECKLIST}

# 出现这些词通常可以确定是食品标签文本，避免模型把明显标签误判为 not_a_label。
_LABEL_KEYWORDS = (
    "配料", "营养成分", "营养", "净含量", "规格", "保质期", "生产日期", "贮存", "储存",
    "执行标准", "产品标准", "食品生产许可证", "SC", "致敏", "NRV",
)

# extract_system() 约定的结构化识读字段名。模型偶发把字段铺在顶层（缺 extracted 外层）
# 时，用这份名单把顶层字段归位，提升识读稳定性。
_EXTRACT_FIELDS = (
    "food_name", "ingredients", "additives", "net_content", "spec",
    "producer", "address", "contact", "production_date", "shelf_life",
    "expiry_date", "storage", "license_no", "standard_code", "quality_grade",
    "allergens", "claims", "nutrition_warning", "nutrition_table", "other_text",
)


def _coerce_extract_doc(doc: dict) -> dict:
    """兼容模型返回结构的抽风：把字段铺在顶层时归位到 extracted。

    Qwen3-8B 偶发不带 {is_food_label, label_type, extracted} 外层，
    而是把 food_name/ingredients 等直接放在顶层。这里统一成约定结构。
    """
    if not isinstance(doc, dict):
        return {}
    extracted = doc.get("extracted")
    if isinstance(extracted, dict) and _has_extracted_content(extracted):
        return doc
    # 顶层是否含已知识读字段 → 归位
    top = {k: doc[k] for k in _EXTRACT_FIELDS if k in doc}
    if top and _has_extracted_content(top):
        doc = dict(doc)
        doc["extracted"] = top
    return doc


async def _extract_once(extract_user: str, images: list[str] | None) -> dict:
    """调用识读模型一次并归一结构。

    若带图（视觉）调用失败——多见于模型/网关其实不支持图片——自动退回纯文本识读，
    保证识读不因开启视觉而整体失败。
    """
    try:
        return _coerce_extract_doc(
            await llm.reason_json(extract_system(), extract_user, images=images)
        )
    except llm.LLMError:
        if images:
            return _coerce_extract_doc(
                await llm.reason_json(extract_system(), extract_user)
            )
        raise


class InputError(ValueError):
    """用户输入问题（图片缺失 / 过大 / 格式不支持）。上层应映射为 HTTP 400。"""


def _has_extracted_content(extracted: dict) -> bool:
    """判断结构化识读结果是否包含有效内容。"""
    if not isinstance(extracted, dict):
        return False
    for v in extracted.values():
        if isinstance(v, str) and v.strip():
            return True
        if isinstance(v, list) and v:
            return True
        if isinstance(v, dict) and v:
            return True
    return False


def _looks_like_food_label(ocr_text: str, extracted: dict) -> bool:
    """基于 OCR/结构化字段做确定性兜底，减少 false negative。"""
    text = (ocr_text or "")
    if any(k in text for k in _LABEL_KEYWORDS):
        return True
    if not isinstance(extracted, dict):
        return False
    if extracted.get("nutrition_table"):
        return True
    for key in (
        "food_name", "ingredients", "net_content", "production_date", "shelf_life",
        "license_no", "standard_code", "nutrition_warning",
    ):
        v = extracted.get(key)
        if isinstance(v, str) and v.strip():
            return True
    return False


async def check_inputs(
    items: list[tuple[bytes, str | None, str | None]],
    *,
    max_images: int = DEFAULT_MAX_IMAGES,
    max_docs: int = DEFAULT_MAX_DOCS,
    max_bytes: int = DEFAULT_MAX_BYTES,
) -> dict:
    """从原始上传（图片 和/或 文档）开始的完整检查，返回规范化报告（非流式）。"""
    data_urls, doc_text = prepare_inputs(items, max_images=max_images, max_docs=max_docs, max_bytes=max_bytes)
    return await analyze_data_urls(data_urls, doc_text)


async def check_image_bytes(
    items: list[tuple[bytes, str | None]],
    *,
    max_images: int = DEFAULT_MAX_IMAGES,
    max_bytes: int = DEFAULT_MAX_BYTES,
    allowed_types: set[str] | None = None,
) -> dict:
    """从原始图片字节开始的完整检查流程，返回规范化后的合规报告（非流式）。"""
    data_urls = prepare_items(items, max_images=max_images, max_bytes=max_bytes, allowed_types=allowed_types)
    return await analyze_data_urls(data_urls)


def prepare_inputs(
    items: list[tuple[bytes, str | None, str | None]],
    *,
    max_images: int = DEFAULT_MAX_IMAGES,
    max_docs: int = DEFAULT_MAX_DOCS,
    max_bytes: int = DEFAULT_MAX_BYTES,
    allowed_types: set[str] | None = None,
) -> tuple[list[str], str]:
    """按类型分流上传项：图片→data URL（走 OCR）；文档→提取文本（跳过 OCR）。

    返回 (data_urls, doc_text)。items 为 (字节, content_type, 文件名) 三元组。
    校验失败招 InputError（上层映射 400）。
    """
    allowed = allowed_types or ALLOWED_TYPES
    if not items:
        raise InputError("请至少上传一张标签图片，或一个标签文本文件（PDF/Word/TXT）。")
    data_urls: list[str] = []
    doc_parts: list[str] = []
    img_count = doc_count = 0
    for raw, ctype, fname in items:
        if not raw:
            continue
        if len(raw) > max_bytes:
            raise InputError(f"单个文件不能超过 {max_bytes // (1024 * 1024)} MB。")
        ct = (ctype or "").lower()
        name = (fname or "").lower()
        is_image = ct in allowed or ct.startswith("image/") or (not ct and name.endswith(_IMAGE_EXTS))
        if is_image:
            img_count += 1
            if img_count > max_images:
                raise InputError(f"最多一次上传 {max_images} 张图片。")
            ct_ok = ct if (ct and ct in allowed) else None
            data_urls.append(llm.prepare_image(raw, ct_ok))
        elif doctext.is_doc(ct, fname):
            doc_count += 1
            if doc_count > max_docs:
                raise InputError(f"最多一次上传 {max_docs} 个文档。")
            try:
                txt = doctext.extract_text(raw, ct or None, fname)
            except doctext.DocError as e:
                raise InputError(str(e)) from e
            if txt and txt.strip():
                doc_parts.append(f"【{fname or '文档'}】\n{txt.strip()}")
        else:
            raise InputError(f"不支持的文件类型：{fname or ct or '未知'}")
    doc_text = "\n\n".join(doc_parts)
    if not data_urls and not doc_text:
        raise InputError("未获得可分析的内容（图片为空或文档无文字）。")
    return data_urls, doc_text


def prepare_items(
    items: list[tuple[bytes, str | None]],
    *,
    max_images: int = DEFAULT_MAX_IMAGES,
    max_bytes: int = DEFAULT_MAX_BYTES,
    allowed_types: set[str] | None = None,
) -> list[str]:
    """校验图片字节并转成 data URL 列表（校验失败抛 InputError）。"""
    allowed = allowed_types or ALLOWED_TYPES
    if not items:
        raise InputError("请至少上传一张标签图片。")
    if len(items) > max_images:
        raise InputError(f"最多一次上传 {max_images} 张图片。")
    data_urls: list[str] = []
    for raw, ctype, *_rest in items:
        if not raw:
            continue
        if len(raw) > max_bytes:
            raise InputError(f"单张图片不能超过 {max_bytes // (1024 * 1024)} MB。")
        ct = (ctype or "").lower()
        if ct and ct not in allowed:
            raise InputError(f"不支持的图片格式：{ct}")
        data_urls.append(llm.prepare_image(raw, ct or None))
    if not data_urls:
        raise InputError("上传的图片为空。")
    return data_urls


async def analyze_steps(data_urls: list[str], doc_text: str = ""):
    """分步异步生成器：逐步产出阶段事件，供 SSE 流式逐步返回。

    data_urls：需走 OCR 的图片；doc_text：用户直接上传的文档（PDF/Word/TXT）提取出的
    文本——已是文字，无需识图，直接当作识读材料。两者可单独或同时提供。

    依次 yield 形如 {"step": <编号>, "stage": <名>, "status": started|done, ...} 的事件：
      1 ocr      OCR 识别（DeepSeek-OCR）；纯文档输入时跳过识图、直接读文本
      2 extract  视觉识读字段 + 营养表（Qwen3.6 看图提取）
      3 analyze  对照国标合规分析（Qwen3.6 基于字段判定）
      4 done     汇总最终报告
    每个 done 事件携带该步的数据；前端据此点亮进度条并逐步渲染。
    """
    if not data_urls and not doc_text:
        raise InputError("没有可分析的内容。")

    t_total = time.perf_counter()
    doc_only = bool(doc_text) and not data_urls

    # ── 步骤 1：识图 OCR（仅图片） + 合并直传文档文本（跳过 OCR）──
    yield {
        "step": 1, "stage": "ocr", "status": "started",
        "label": "读取标签文本" if doc_only else "识别图片",
    }
    t0 = time.perf_counter()
    ocr_results: list[dict] = []
    if data_urls:
        per_image = [await llm.ocr_all(url) for url in data_urls]
        for model in llm.OCR_MODELS:
            texts, errs = [], []
            for img_res in per_image:
                r = next((x for x in img_res if x["model"] == model), None)
                if not r:
                    continue
                if r.get("error"):
                    errs.append(r["error"])
                if r.get("text"):
                    texts.append(r["text"])
            ocr_results.append({
                "model": model,
                "text": "\n\n---\n\n".join(texts),
                "error": "; ".join(errs) if errs and not texts else None,
            })
    # 用户直传的文档文本作为一个“来源”混入（未经 OCR），识读步一起参考。
    if doc_text:
        ocr_results.append({"model": "文档直接读取（未经 OCR）", "text": doc_text, "error": None})
    # 各来源结果都带上标签拼给识读步骤，便于交叉印证、纠错。
    ocr_draft = "\n\n".join(
        f"【{r['model']}】\n{r['text']}" for r in ocr_results if r["text"]
    )
    yield {
        "step": 1, "stage": "ocr", "status": "done",
        "ocr_results": ocr_results, "elapsed": round(time.perf_counter() - t0, 1),
    }

    # ── 步骤 2：基于文本（+ 多模态时附原图）识读字段 + 营养表 ──
    yield {"step": 2, "stage": "extract", "status": "started", "label": "识读内容"}
    t0 = time.perf_counter()
    if not ocr_draft:
        raise llm.LLMError("未获得任何标签文本，无法识读标签字段。")
    # 识读模型支持多模态且有图片时把原图一并喂入做参考；纯文本/纯文档则只给文本。
    extract_images = data_urls if (llm.REASON_VISION and data_urls) else None
    extract_user = (
        "以下是该食品标签的文本内容"
        + (
            "（由 OCR 识别和/或上传文件读取，可能有错漏、乱序、粘连，已附原始标签图片，请以图片为准、文本作辅助）"
            if extract_images
            else "（由 OCR 识别和/或用户上传的标签文件直接读取）"
        )
        + "，请综合整理出结构化字段 JSON：\n\n"
        + ocr_draft
    )
    # 结构化识读：多模态参考 + 结构兼容 + 一次重试，缓解模型 JSON 偶发抽风。
    extracted_doc = await _extract_once(extract_user, extract_images)
    extracted = extracted_doc.get("extracted") or {}
    if not _has_extracted_content(extracted) and ocr_draft.strip():
        # 第一次识读为空：很可能是模型随机性，原样重试一次。
        extracted_doc = await _extract_once(extract_user, extract_images)
        extracted = extracted_doc.get("extracted") or {}
    if not _has_extracted_content(extracted) and ocr_draft.strip():
        # 仍为空时，至少保留 OCR 草稿，避免前端“识读内容”空白。
        extracted = {"other_text": ocr_draft[:6000]}
    is_label = extracted_doc.get("is_food_label")
    if is_label is False and _looks_like_food_label(ocr_draft, extracted):
        # 明显包含食品标签特征时，覆盖模型 false，继续按食品标签流程处理。
        is_label = True
    label_type = extracted_doc.get("label_type", "")
    if is_label is False and ocr_draft.strip():
        # 线上实测会出现：OCR 有文本但模型误判 not_a_label。
        # 这里采用“宁可进入复核也不漏检”的策略：有文本就继续走食品标签流程。
        is_label = True
        if not label_type:
            label_type = "疑似食品标签（自动进入复核）"
    yield {
        "step": 2, "stage": "extract", "status": "done",
        "is_food_label": is_label, "label_type": label_type,
        "extracted": extracted, "ocr_results": ocr_results,
        "elapsed": round(time.perf_counter() - t0, 1),
    }

    # 明显不是食品标签：直接收尾，不做合规分析。
    if is_label is False:
        result = normalize({
            "is_food_label": False, "label_type": label_type,
            "extracted": extracted, "checks": [],
            "summary": {"verdict": "not_a_label", "score": 0},
        })
        result["ocr_results"] = ocr_results
        yield {
            "step": 5, "stage": "done", "status": "done", "result": result,
            "elapsed_total": round(time.perf_counter() - t_total, 1),
        }
        return

    # ── 步骤 3：判定适用规则（LLM 只做受限分类 → 代码确定性映射出适用条目）──
    yield {"step": 3, "stage": "rules", "status": "started", "label": "判定适用规则"}
    t0 = time.perf_counter()
    rules_user = "以下是某预包装食品标签已识读出的结构化字段（JSON）：\n\n" + json.dumps(
        {"label_type": label_type, "extracted": extracted}, ensure_ascii=False
    )
    rules_doc = await llm.reason_json(rules_system(), rules_user)
    category_id = rules_doc.get("category_id") or "general"
    is_import = bool(rules_doc.get("is_import"))
    scope = "import" if is_import else "domestic"
    # 适用条目由代码按固定映射确定性算出（非 LLM 自由判断）。
    applicable = applicable_for(category_id, scope)
    cat = category_info(category_id)
    rules_meta = {
        "category_id": category_id,
        "category_name": cat.get("name", ""),
        "category_basis": cat.get("basis", ""),
        "category_reason": rules_doc.get("category_reason", ""),
        "is_import": is_import,
        "applicable": [
            {"id": cid, "item": _ITEM_BY_ID[cid], "applicable": a["applicable"],
             "reason": a["reason"], "basis": a["basis"]}
            for cid, a in applicable.items()
        ],
    }
    yield {
        "step": 3, "stage": "rules", "status": "done", "rules": rules_meta,
        "elapsed": round(time.perf_counter() - t0, 1),
    }

    # ── 步骤 4：基于适用规则做确定性合规评价（规则引擎，不调 LLM）──
    # 法律合规判定要求确定性：同一识读结果永远得到同一结论，不受模型采样波动影响。
    yield {"step": 4, "stage": "analyze", "status": "started", "label": "合规评价"}
    t0 = time.perf_counter()
    checks = evaluate_checks(extracted, ocr_draft, applicable)
    missing, problems, risks = _findings_from_checks(checks)
    result = normalize(
        {
            "is_food_label": is_label,
            "label_type": label_type,
            "extracted": extracted,
            "checks": checks,
            "missing": missing,
            "problems": problems,
            "risks": risks,
        },
        applicable=applicable,
    )
    result["ocr_results"] = ocr_results
    result["rules"] = rules_meta
    yield {
        "step": 4, "stage": "analyze", "status": "done",
        "elapsed": round(time.perf_counter() - t0, 1),
    }

    # ── 步骤 5：汇总报告 ──
    yield {
        "step": 5, "stage": "done", "status": "done", "result": result,
        "elapsed_total": round(time.perf_counter() - t_total, 1),
    }


async def analyze_data_urls(data_urls: list[str], doc_text: str = "") -> dict:
    """非流式封装：跑完分步流程，返回最终报告（供 MCP / 一次性调用）。"""
    if not data_urls and not doc_text:
        raise InputError("没有可分析的内容。")
    final: dict | None = None
    async for ev in analyze_steps(data_urls, doc_text):
        if ev.get("stage") == "done":
            final = ev.get("result")
    if final is None:
        raise llm.LLMError("分析未产出结果。")
    return final


def applicable_list(applicable: dict[str, dict]) -> list[dict]:
    """把 applicable_for 的 dict 转成保持 CHECKLIST 顺序的列表。"""
    return [{"id": c["id"], **applicable[c["id"]]} for c in CHECKLIST if c["id"] in applicable]


def _findings_from_checks(checks: list[dict]) -> tuple[list, list, list]:
    """从确定性判定的 checks 派生 缺失/问题/风险 三类清单（供前端展示）。

    miss → 缺失点；fail → 问题点；warn → 风险点。保持 CHECKLIST 顺序。
    """
    missing, problems, risks = [], [], []
    for c in checks:
        st = c.get("status")
        entry = {
            "item": c.get("item", ""),
            "detail": c.get("finding", ""),
            "basis": c.get("basis", ""),
            "suggestion": c.get("suggestion", ""),
        }
        if st == "miss":
            missing.append(entry)
        elif st == "fail":
            problems.append(entry)
        elif st == "warn":
            risks.append({**entry, "level": "medium"})
    return missing, problems, risks


def _compute_score(counts: dict) -> int:
    """按各状态计数确定性算合规评分（0-100）：fail/miss 各扣 8，warn 扣 3，unknown 扣 2。"""
    total = counts["pass"] + counts["miss"] + counts["fail"] + counts["warn"] + counts["unknown"]
    if total <= 0:
        return 0
    deduct = counts["fail"] * 8 + counts["miss"] * 8 + counts["warn"] * 3 + counts["unknown"] * 2
    return max(0, 100 - deduct)


def normalize(result: dict, applicable: dict[str, dict] | None = None) -> dict:
    """对模型输出做轻量校正：补全检查项与计数，保证字段存在，便于稳定渲染。

    若给出 applicable（适用规则映射），则**确定性地**把不适用项强制判为 na，
    覆盖 LLM 的判定，保证适用范围严格符合国标条款。
    """
    if not isinstance(result, dict):
        return {"error": "模型返回格式异常。"}
    checks = result.get("checks") or []
    if not isinstance(checks, list):
        checks = []
    seen = {c.get("id") for c in checks if isinstance(c, dict)}
    # 模型只列出有问题/不适用的项；未列出的视为合规（pass）。
    # 但若整图不是食品标签，则补成 unknown（无从判定）。
    fill_status = "unknown" if result.get("is_food_label") is False else "pass"
    # 合规(pass)项不写多余说明（留空）；非食品标签时标注无法判定。
    fill_finding = "" if fill_status == "pass" else "非食品标签，无法判定。"
    for cid in _CHECK_IDS:
        if cid not in seen:
            checks.append(
                {
                    "id": cid,
                    "category": _CAT_BY_ID[cid],
                    "item": _ITEM_BY_ID[cid],
                    "status": fill_status,
                    "finding": fill_finding,
                    "basis": _BASIS_BY_ID[cid],
                }
            )
    # 确定性应用适用规则：不适用项强制 na（覆盖 LLM）。
    if applicable:
        for c in checks:
            rule = applicable.get(c.get("id"))
            if rule and not rule.get("applicable", True):
                c["status"] = "na"
                c["finding"] = rule.get("reason", "该项对本商品不适用")
    counts = {"pass": 0, "miss": 0, "fail": 0, "warn": 0, "na": 0, "unknown": 0}
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
    summary.setdefault("miss", counts["miss"])
    summary.setdefault("fail", counts["fail"])
    summary.setdefault("warn", counts["warn"])
    summary.setdefault("score", _compute_score(counts))
    if not summary.get("verdict"):
        if result.get("is_food_label") is False:
            summary["verdict"] = "not_a_label"
        elif counts["miss"] or counts["fail"]:
            summary["verdict"] = "non_compliant"
        elif counts["warn"]:
            summary["verdict"] = "issues"
        else:
            summary["verdict"] = "compliant"
    result["summary"] = summary
    result.setdefault("extracted", {})
    # 三类问题点：缺失 / 问题 / 风险。保证为列表，便于前端稳定渲染。
    for key in ("missing", "problems", "risks"):
        v = result.get(key)
        result[key] = v if isinstance(v, list) else []
    result.setdefault("suggestions", [])
    return result
