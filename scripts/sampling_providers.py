"""Official web-search sampling adapters for non-Doubao providers.

This module only translates provider HTTP contracts into the sampling result
shape already consumed by ``backend_server.py``.  It does not own task state,
retry policy, concurrency, persistence, or metric calculations.
"""

from __future__ import annotations

import json
import re
from typing import Any, Callable
from urllib import error as urllib_error
from urllib import request as urllib_request


RETRYABLE_HTTP_STATUS = {408, 429}
URL_PATTERN = re.compile(r"https?://[^\s<>\]）)\"']+")


class ProviderRequestError(RuntimeError):
    """Sanitized transport failure that can be mapped to the existing retry type."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int = 0,
        error_code: str = "",
        retry_after_seconds: int = 0,
        retryable: bool = False,
    ) -> None:
        super().__init__(message)
        self.status_code = int(status_code or 0)
        self.error_code = str(error_code or "")
        self.retry_after_seconds = max(0, int(retry_after_seconds or 0))
        self.retryable = bool(retryable)


def _truncate(value: Any, maximum: int = 500) -> str:
    text = str(value or "").strip()
    if len(text) <= maximum:
        return text
    return text[: max(0, maximum - 8)].rstrip() + "...[截断]"


def _sanitize(value: Any) -> str:
    text = str(value or "")
    text = re.sub(r"Bearer\s+[A-Za-z0-9._\-]+", "Bearer ***MASKED***", text)
    text = re.sub(r"\bsk-[A-Za-z0-9_-]{8,}\b", "sk-***MASKED***", text)
    text = re.sub(
        r'(?i)(api[_-]?key["\']?\s*[:=]\s*["\']?)[^,\s"\']+',
        r"\1***MASKED***",
        text,
    )
    return text


def _retry_after_seconds(headers: Any) -> int:
    if headers is None:
        return 0
    try:
        value = headers.get("Retry-After", "")
        return max(0, int(float(value or 0)))
    except (AttributeError, TypeError, ValueError):
        return 0


def _error_code(raw: str) -> str:
    try:
        payload = json.loads(raw or "{}")
    except (TypeError, json.JSONDecodeError):
        return ""
    if not isinstance(payload, dict):
        return ""
    error = payload.get("error")
    if isinstance(error, dict):
        return str(error.get("code") or error.get("type") or "")
    return str(payload.get("code") or "")


def _http_json(
    method: str,
    url: str,
    *,
    headers: dict[str, str],
    body: dict[str, Any] | None,
    timeout_seconds: int,
    provider_label: str,
    urlopen_fn: Callable[..., Any],
) -> dict[str, Any]:
    encoded = (
        json.dumps(body, ensure_ascii=False).encode("utf-8")
        if body is not None
        else None
    )
    request = urllib_request.Request(
        url,
        data=encoded,
        headers=headers,
        method=method.upper(),
    )
    try:
        with urlopen_fn(request, timeout=timeout_seconds) as response:
            raw = response.read().decode("utf-8", errors="replace")
    except urllib_error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        detail = _truncate(_sanitize(raw), 500)
        raise ProviderRequestError(
            f"{provider_label} API 返回 {exc.code}：{detail}",
            status_code=exc.code,
            error_code=_error_code(raw),
            retry_after_seconds=_retry_after_seconds(exc.headers),
            retryable=(
                exc.code in RETRYABLE_HTTP_STATUS
                or 500 <= int(exc.code or 0) <= 599
            ),
        ) from exc
    except urllib_error.URLError as exc:
        raise ProviderRequestError(
            f"{provider_label} API 请求失败：{_sanitize(exc.reason)}",
            retryable=True,
        ) from exc
    except TimeoutError as exc:
        raise ProviderRequestError(
            f"{provider_label} API 请求超时",
            retryable=True,
        ) from exc

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ProviderRequestError(
            f"{provider_label} API 返回非 JSON 内容：{_truncate(_sanitize(raw), 500)}"
        ) from exc
    if not isinstance(payload, dict):
        raise ProviderRequestError(f"{provider_label} API 返回结构无效")
    return payload


def _content_text(content: Any) -> str:
    if isinstance(content, str):
        return content.strip()
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for item in content:
        if not isinstance(item, dict):
            continue
        if str(item.get("type") or "") not in {"", "text", "output_text"}:
            continue
        text = item.get("text")
        if isinstance(text, str) and text.strip():
            parts.append(text.strip())
    return "\n\n".join(parts).strip()


def _answer_text(payload: dict[str, Any]) -> str:
    content = payload.get("content")
    text = _content_text(content)
    if text:
        return text
    choices = payload.get("choices")
    if isinstance(choices, list):
        texts: list[str] = []
        for choice in choices:
            if not isinstance(choice, dict):
                continue
            message = choice.get("message")
            if isinstance(message, dict):
                candidate = _content_text(message.get("content"))
                if candidate:
                    texts.append(candidate)
            candidate = choice.get("text")
            if isinstance(candidate, str) and candidate.strip():
                texts.append(candidate.strip())
        if texts:
            return "\n\n".join(dict.fromkeys(texts)).strip()
    output = payload.get("output")
    if isinstance(output, dict):
        choices = output.get("choices")
        if isinstance(choices, list) and choices:
            message = choices[0].get("message") if isinstance(choices[0], dict) else {}
            if isinstance(message, dict):
                return _content_text(message.get("content"))
    return ""


def _collect_citations(*values: Any, answer: str = "") -> list[dict[str, str]]:
    citations: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()

    def add(item: dict[str, Any]) -> None:
        url = str(item.get("url") or item.get("uri") or item.get("link") or "").strip()
        title = str(
            item.get("title")
            or item.get("name")
            or item.get("site_name")
            or ""
        ).strip()
        snippet_value = (
            item.get("snippet")
            or item.get("summary")
            or item.get("description")
            or ""
        )
        snippet = (
            str(snippet_value).strip()
            if isinstance(snippet_value, (str, int, float))
            else ""
        )
        if not url and not title:
            return
        key = (url, title)
        if key in seen:
            return
        seen.add(key)
        citations.append(
            {
                "title": title,
                "url": url,
                "snippet": _truncate(snippet, 240) if snippet else "",
            }
        )

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            if any(key in node for key in ("url", "uri", "link")):
                add(node)
            for child in node.values():
                if isinstance(child, (dict, list)):
                    walk(child)
        elif isinstance(node, list):
            for child in node:
                walk(child)

    for value in values:
        walk(value)
    for url in URL_PATTERN.findall(answer or ""):
        add({"url": url.rstrip(".,，。；;"), "title": ""})
    return citations[:20]


def _required_config(config: dict[str, Any], provider_label: str) -> tuple[str, str, str]:
    api_key = str(config.get("api_key") or "").strip()
    endpoint = str(config.get("endpoint") or "").strip().rstrip("/")
    model = str(config.get("model") or "").strip()
    if not api_key:
        raise ValueError(f"{provider_label} API Key 未配置，请先在系统设置中保存。")
    if not endpoint:
        raise ValueError(f"{provider_label}接口地址未配置。")
    if not model:
        raise ValueError(f"{provider_label}模型未配置。")
    return api_key, endpoint, model


def call_deepseek_websearch(
    question: str,
    config: dict[str, Any],
    *,
    urlopen_fn: Callable[..., Any] = urllib_request.urlopen,
) -> dict[str, Any]:
    """Call DeepSeek's Anthropic-compatible server-side web-search tool."""

    api_key, endpoint, model = _required_config(config, "DeepSeek")
    timeout_seconds = max(10, min(180, int(config.get("timeout_seconds") or 90)))
    messages: list[dict[str, Any]] = [
        {"role": "user", "content": [{"type": "text", "text": str(question)}]}
    ]
    responses: list[dict[str, Any]] = []
    headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
    }
    for _round in range(4):
        body: dict[str, Any] = {
            "model": model,
            "max_tokens": max(512, min(8192, int(config.get("max_tokens") or 4096))),
            "system": (
                "请像普通用户在 DeepSeek 中提问后得到的联网回答一样作答。"
                "优先依据公开可检索信息；无法确认的信息不要编造。"
            ),
            "messages": messages,
            "temperature": max(0.0, min(2.0, float(config.get("temperature") or 0.2))),
        }
        if config.get("web_search", True):
            body["tools"] = [
                {
                    "type": "web_search_20250305",
                    "name": "web_search",
                    "max_uses": max(1, min(10, int(config.get("max_search_uses") or 5))),
                }
            ]
        payload = _http_json(
            "POST",
            endpoint,
            headers=headers,
            body=body,
            timeout_seconds=timeout_seconds,
            provider_label="DeepSeek",
            urlopen_fn=urlopen_fn,
        )
        responses.append(payload)
        if str(payload.get("stop_reason") or "") == "pause_turn":
            content = payload.get("content")
            if not isinstance(content, list) or not content:
                raise ProviderRequestError("DeepSeek 联网搜索暂停后未返回可继续的内容")
            messages.append({"role": "assistant", "content": content})
            continue
        answer = _answer_text(payload)
        if not answer:
            raise ProviderRequestError("DeepSeek API 未返回可保存的回答正文")
        return {
            "answer": answer,
            "raw_response": {
                "provider": "deepseek",
                "responses": responses,
            },
            "citations": _collect_citations(responses, answer=answer),
        }
    raise ProviderRequestError("DeepSeek 联网搜索超过最大继续轮次，未得到最终回答")


def call_kimi_websearch(
    question: str,
    config: dict[str, Any],
    *,
    urlopen_fn: Callable[..., Any] = urllib_request.urlopen,
) -> dict[str, Any]:
    """Call Kimi K3 through the official Web Search Formula workflow."""

    api_key, endpoint, model = _required_config(config, "Kimi")
    timeout_seconds = max(10, min(180, int(config.get("timeout_seconds") or 120)))
    formula_uri = str(
        config.get("formula_uri") or "moonshot/web-search:latest"
    ).strip()
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    tools_payload = _http_json(
        "GET",
        f"{endpoint}/formulas/{formula_uri}/tools",
        headers=headers,
        body=None,
        timeout_seconds=timeout_seconds,
        provider_label="Kimi",
        urlopen_fn=urlopen_fn,
    )
    tools = tools_payload.get("tools")
    if not isinstance(tools, list) or not tools:
        raise ProviderRequestError("Kimi Web Search Formula 未返回工具声明")

    messages: list[dict[str, Any]] = [
        {
            "role": "system",
            "content": (
                "请像普通用户在 Kimi 中提问后得到的联网回答一样作答。"
                "优先依据公开可检索信息；无法确认的信息不要编造。"
            ),
        },
        {"role": "user", "content": str(question)},
    ]
    chat_responses: list[dict[str, Any]] = []
    fiber_audit: list[dict[str, Any]] = []
    fiber_payloads_for_citations: list[dict[str, Any]] = []
    for _round in range(4):
        chat_body: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "tools": tools,
        }
        reasoning_effort = str(config.get("reasoning_effort") or "high").strip()
        if reasoning_effort in {"low", "high", "max"}:
            chat_body["reasoning_effort"] = reasoning_effort
        chat_payload = _http_json(
            "POST",
            f"{endpoint}/chat/completions",
            headers=headers,
            body=chat_body,
            timeout_seconds=timeout_seconds,
            provider_label="Kimi",
            urlopen_fn=urlopen_fn,
        )
        chat_responses.append(chat_payload)
        choices = chat_payload.get("choices")
        message = (
            choices[0].get("message")
            if isinstance(choices, list)
            and choices
            and isinstance(choices[0], dict)
            else None
        )
        if not isinstance(message, dict):
            raise ProviderRequestError("Kimi API 未返回有效消息")
        tool_calls = message.get("tool_calls") or []
        if not tool_calls:
            answer = _content_text(message.get("content"))
            if not answer:
                raise ProviderRequestError("Kimi API 未返回可保存的回答正文")
            return {
                "answer": answer,
                "raw_response": {
                    "provider": "moonshot",
                    "formula_uri": formula_uri,
                    "tool_round_count": len(fiber_audit),
                    "chat_responses": chat_responses,
                    "fibers": fiber_audit,
                },
                "citations": _collect_citations(
                    chat_responses,
                    fiber_payloads_for_citations,
                    answer=answer,
                ),
            }
        if not isinstance(tool_calls, list):
            raise ProviderRequestError("Kimi API 返回的 tool_calls 结构无效")
        messages.append(
            {
                key: message.get(key)
                for key in ("role", "content", "tool_calls")
                if key in message
            }
        )
        for tool_call in tool_calls:
            if not isinstance(tool_call, dict):
                raise ProviderRequestError("Kimi API 返回了无效工具调用")
            function = tool_call.get("function")
            if not isinstance(function, dict):
                raise ProviderRequestError("Kimi API 工具调用缺少 function")
            fiber_payload = _http_json(
                "POST",
                f"{endpoint}/formulas/{formula_uri}/fibers",
                headers=headers,
                body={
                    "name": function.get("name"),
                    "arguments": function.get("arguments"),
                },
                timeout_seconds=timeout_seconds,
                provider_label="Kimi",
                urlopen_fn=urlopen_fn,
            )
            context = (
                fiber_payload.get("context")
                if isinstance(fiber_payload.get("context"), dict)
                else {}
            )
            result = context.get("output") or context.get("encrypted_output") or ""
            if not isinstance(result, str) or not result:
                raise ProviderRequestError("Kimi Web Search Formula 未返回工具结果")
            if context.get("output"):
                fiber_payloads_for_citations.append(fiber_payload)
            fiber_audit.append(
                {
                    "id": fiber_payload.get("id") or "",
                    "status": fiber_payload.get("status") or "",
                    "formula": fiber_payload.get("formula") or formula_uri,
                    "tool_call_id": tool_call.get("id") or "",
                    "encrypted_output": bool(context.get("encrypted_output")),
                }
            )
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": tool_call.get("id"),
                    "content": result,
                }
            )
    raise ProviderRequestError("Kimi 联网搜索超过最大工具轮次，未得到最终回答")


def call_qwen_websearch(
    question: str,
    config: dict[str, Any],
    *,
    urlopen_fn: Callable[..., Any] = urllib_request.urlopen,
) -> dict[str, Any]:
    """Call Alibaba Cloud Model Studio's native Generation web search."""

    api_key, endpoint, model = _required_config(config, "千问百炼")
    timeout_seconds = max(10, min(180, int(config.get("timeout_seconds") or 90)))
    body = {
        "model": model,
        "input": {
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "请像普通用户在千问中提问后得到的联网回答一样作答。"
                        "优先依据公开可检索信息；无法确认的信息不要编造。"
                    ),
                },
                {"role": "user", "content": str(question)},
            ]
        },
        "parameters": {
            "enable_search": bool(config.get("web_search", True)),
            "search_options": {
                "forced_search": bool(config.get("forced_search", True)),
                "enable_source": True,
                "search_strategy": str(config.get("search_strategy") or "turbo"),
            },
            "result_format": "message",
            "temperature": max(
                0.0,
                min(2.0, float(config.get("temperature") or 0.2)),
            ),
        },
    }
    payload = _http_json(
        "POST",
        endpoint,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        body=body,
        timeout_seconds=timeout_seconds,
        provider_label="千问百炼",
        urlopen_fn=urlopen_fn,
    )
    answer = _answer_text(payload)
    if not answer:
        raise ProviderRequestError("千问百炼 API 未返回可保存的回答正文")
    return {
        "answer": answer,
        "raw_response": payload,
        "citations": _collect_citations(payload, answer=answer),
    }


__all__ = [
    "ProviderRequestError",
    "call_deepseek_websearch",
    "call_kimi_websearch",
    "call_qwen_websearch",
]
