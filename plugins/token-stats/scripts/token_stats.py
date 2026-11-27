#!/usr/bin/env python3
"""Antigravity PostInvocation hook for end-of-turn token, cache & latency stats.

Silent on intermediate tool-calling steps; injects 1 concise summary at the end
of each turn (when the latest PLANNER_RESPONSE has no tool_calls).
Automatically discovers and recursively aggregates subagent (invoke_subagent /
swarm) transcripts spawned by the current conversation.

CLI usage:
    python scripts/token_stats.py --file <path/to/transcript.jsonl>
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime
from typing import Any

INVISIBLE_MARKER = "\u2063"
CREATED_RE = re.compile(r"Created At:\s*([0-9T:\-\.\+Z]+)")
COMPLETED_RE = re.compile(r"Completed At:\s*([0-9T:\-\.\+Z]+)")
ID_RE = re.compile(r"^[0-9a-f-]{8,}$", re.IGNORECASE)
SUBAGENT_CREATED_RE = re.compile(r"Created the following subagent:\s*(\{[\s\S]*?\n\})")
CONV_ID_FIELD_RE = re.compile(r'"conversation(?:Id|_id)"\s*:\s*"([0-9a-f-]{8,})"', re.IGNORECASE)

MAX_SUBAGENT_DEPTH = 6
MAX_SUBAGENT_COUNT = 64


def fmt_num(n: int | float) -> str:
    n = int(round(n))
    if n >= 1_000_000:
        return f"{n / 1_000_000:.2f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}k"
    return str(n)


def fmt_pct(num: float, den: float) -> str:
    if den <= 0:
        return "0.0%"
    return f"{(num / den) * 100.0:.1f}%"


def fmt_duration(ms: float) -> str:
    sec = max(0.0, ms / 1000.0)
    if sec < 0.05:
        return "0s"
    if sec < 60:
        return f"{sec:.1f}s" if sec < 10 else f"{int(round(sec))}s"
    mins = int(sec // 60)
    rem = int(round(sec % 60))
    if rem == 60:
        mins += 1
        rem = 0
    return f"{mins}分{rem}秒"


def fmt_model(raw: str | None) -> str:
    if not raw:
        return "Unknown"
    cleaned = raw.strip()
    if not cleaned:
        return "Unknown"
    if " " in cleaned:
        return cleaned
    parts = cleaned.split("-")
    # 例如 gemini-4-neon-high -> Gemini 4 Neon (High)
    tier_words = {"high", "medium", "low", "fast", "thinking", "xhigh"}
    if len(parts) >= 2 and parts[-1].lower() in tier_words:
        base = " ".join(p.capitalize() if not p.isdigit() else p for p in parts[:-1])
        return f"{base} ({parts[-1].capitalize()})"
    return " ".join(p.capitalize() if not p.isdigit() else p for p in parts)


def unquote_arg(val: Any) -> str:
    """清洗 tool_calls.args 中被额外 JSON 编码包裹双引号的字符串参数。"""
    if val is None:
        return ""
    s = str(val).strip()
    if len(s) >= 2 and s.startswith('"') and s.endswith('"'):
        try:
            parsed = json.loads(s)
            if isinstance(parsed, str):
                return parsed.strip()
        except json.JSONDecodeError:
            return s[1:-1].strip()
    return s


def parse_iso_ms(ts: str | None) -> float | None:
    if not ts or not isinstance(ts, str):
        return None
    s = ts.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(s).timestamp() * 1000.0
    except ValueError:
        return None


def merge_intervals_ms(intervals: list[tuple[float, float]]) -> float:
    valid = [(s, e) for s, e in intervals if e > s and (e - s) < 3_600_000]
    if not valid:
        return 0.0
    valid.sort()
    merged = [valid[0]]
    for s, e in valid[1:]:
        ps, pe = merged[-1]
        if s <= pe:
            merged[-1] = (ps, max(pe, e))
        else:
            merged.append((s, e))
    return sum(e - s for s, e in merged)


def load_transcript(path: str) -> list[dict[str, Any]]:
    steps: list[dict[str, Any]] = []
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                if isinstance(obj, dict):
                    steps.append(obj)
            except json.JSONDecodeError:
                continue
    return steps


def infer_brain_and_conv_id(transcript_path: str) -> tuple[str | None, str | None]:
    """从 transcript.jsonl 路径反推 brain 根目录与当前 conversationId。"""
    abs_path = os.path.abspath(transcript_path)
    # 标准路径：<brain_dir>/<conv_id>/.system_generated/logs/transcript.jsonl
    logs_dir = os.path.dirname(abs_path)
    sys_dir = os.path.dirname(logs_dir)
    conv_dir = os.path.dirname(sys_dir)
    brain_dir = os.path.dirname(conv_dir)
    conv_id = os.path.basename(conv_dir)
    if ID_RE.match(conv_id) and os.path.isdir(brain_dir):
        return brain_dir, conv_id
    return None, None


def strip_generic_timestamp_headers(content: str) -> str:
    """剥离 GENERIC 步骤顶部连续的 Created At / Completed At 行，返回正文起始内容。"""
    lines = content.splitlines()
    idx = 0
    while idx < len(lines):
        trimmed = lines[idx].strip()
        if not trimmed or trimmed.startswith("Created At:") or trimmed.startswith("Completed At:"):
            idx += 1
            continue
        break
    return "\n".join(lines[idx:]).lstrip()


def extract_subagent_refs_from_step(
    tool_calls: list[dict[str, Any]],
    generic_steps: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """从单步 PLANNER_RESPONSE 与紧随的 GENERIC 输出中提取子智能体派发信息。"""
    refs: list[dict[str, Any]] = []
    invoke_calls: list[dict[str, str]] = []
    swarm_add_count = 0
    for tc in tool_calls:
        if not isinstance(tc, dict):
            continue
        tname = tc.get("name")
        args = tc.get("args") or tc.get("arguments") or {}
        if not isinstance(args, dict):
            args = {}
        if tname == "invoke_subagent":
            invoke_calls.append(
                {
                    "type_name": unquote_arg(args.get("TypeName")),
                    "role": unquote_arg(args.get("Role")),
                    "model": unquote_arg(args.get("Model")),
                }
            )
        elif tname == "swarm" and unquote_arg(args.get("action")).lower() == "add":
            swarm_add_count += 1

    # 当前步骤未调用 invoke_subagent 或 swarm add 时直接返回，避免误匹配命令输出
    if not invoke_calls and swarm_add_count == 0:
        return refs

    invoke_cursor = 0
    for g_step in generic_steps:
        content = str(g_step.get("content") or "")
        if not content:
            continue
        body = strip_generic_timestamp_headers(content)
        if not body:
            continue

        # 1. 严格匹配以 "Created the following subagent:" 开头的 invoke_subagent 返回
        if invoke_cursor < len(invoke_calls) and body.startswith("Created the following subagent:"):
            conv_id = ""
            m = SUBAGENT_CREATED_RE.search(body)
            if m:
                try:
                    parsed = json.loads(m.group(1))
                    if isinstance(parsed, dict) and isinstance(parsed.get("conversationId"), str):
                        conv_id = parsed["conversationId"].strip()
                except json.JSONDecodeError:
                    pass
            if not conv_id:
                idm = CONV_ID_FIELD_RE.search(body)
                if idm:
                    conv_id = idm.group(1)
            if conv_id and ID_RE.match(conv_id):
                meta = invoke_calls[invoke_cursor] if invoke_cursor < len(invoke_calls) else {}
                invoke_cursor += 1
                refs.append(
                    {
                        "conversation_id": conv_id,
                        "kind": "subagent",
                        "type_name": meta.get("type_name", ""),
                        "role": meta.get("role", ""),
                        "model": meta.get("model", ""),
                    }
                )
            continue

        # 2. 严格匹配以 JSON 对象开头的 swarm add 返回
        if (
            swarm_add_count > 0
            and body.startswith("{")
            and '"status"' in body
            and '"added"' in body
            and "conversation_id" in body
        ):
            candidate = body.strip()
            items: list[dict[str, Any]] = []
            try:
                parsed = json.loads(candidate)
                if isinstance(parsed, dict):
                    if isinstance(parsed.get("conversation_id"), str):
                        items.append(parsed)
                    elif isinstance(parsed.get("added"), list):
                        items.extend(x for x in parsed["added"] if isinstance(x, dict))
                    elif isinstance(parsed.get("members"), list):
                        items.extend(x for x in parsed["members"] if isinstance(x, dict))
            except json.JSONDecodeError:
                pass
            if items:
                for item in items:
                    cid = str(item.get("conversation_id") or "").strip()
                    if not cid or not ID_RE.match(cid):
                        continue
                    refs.append(
                        {
                            "conversation_id": cid,
                            "kind": "swarm",
                            "type_name": "swarm",
                            "role": str(item.get("name") or "").strip(),
                            "model": str(item.get("model_display_name") or item.get("model") or "").strip(),
                        }
                    )
            else:
                idm = CONV_ID_FIELD_RE.search(candidate)
                if idm and ID_RE.match(idm.group(1)):
                    refs.append(
                        {
                            "conversation_id": idm.group(1),
                            "kind": "swarm",
                            "type_name": "swarm",
                            "role": "",
                            "model": "",
                        }
                    )

    return refs


def read_swarm_members_fallback(brain_dir: str, conv_id: str) -> list[dict[str, Any]]:
    """读取可选的 swarm/members.json，兜底补全可能漏掉的 worker 对话。"""
    members_path = os.path.join(brain_dir, conv_id, ".system_generated", "swarm", "members.json")
    if not os.path.isfile(members_path):
        return []
    try:
        with open(members_path, "r", encoding="utf-8", errors="replace") as f:
            raw = json.load(f)
    except (OSError, json.JSONDecodeError):
        return []
    members = raw.get("members") if isinstance(raw, dict) else None
    if not isinstance(members, dict):
        return []
    refs: list[dict[str, Any]] = []
    for name, info in members.items():
        if not isinstance(info, dict):
            continue
        cid = str(info.get("conversation_id") or "").strip()
        if not cid or not ID_RE.match(cid) or cid == conv_id:
            continue
        refs.append(
            {
                "conversation_id": cid,
                "kind": "swarm",
                "type_name": "swarm",
                "role": str(name),
                "model": str(info.get("applied_model") or info.get("model") or info.get("desired_model") or "").strip(),
            }
        )
    return refs


def analyze_steps(
    steps: list[dict[str, Any]], now_ms: float | None = None
) -> dict[str, Any] | None:
    """解析单个对话的步骤序列，统计各轮/各步用量并提取派发的子智能体引用。"""
    turns: list[list[dict[str, Any]]] = []
    current_turn: list[dict[str, Any]] = []
    all_invocations: list[dict[str, Any]] = []
    subagent_refs: list[dict[str, Any]] = []
    seen_sub_ids: set[str] = set()

    i = 0
    n = len(steps)
    while i < n:
        step = steps[i]
        stype = step.get("type")

        if stype == "USER_INPUT":
            if current_turn:
                turns.append(current_turn)
                current_turn = []
            i += 1
            continue

        if stype == "PLANNER_RESPONSE" and (
            "input_tokens" in step
            or "output_tokens" in step
            or "cache_read_tokens" in step
        ):
            inp = int(step.get("input_tokens") or 0)
            cache = int(step.get("cache_read_tokens") or 0)
            out = int(step.get("output_tokens") or 0)
            total_in = inp + cache
            tool_calls = step.get("tool_calls") or []
            start_ms = parse_iso_ms(step.get("created_at"))

            # 扫描当前 PLANNER_RESPONSE 之后、下一个模型/用户输入之前的所有步骤
            tool_intervals: list[tuple[float, float]] = []
            following_generics: list[dict[str, Any]] = []
            first_tool_ms: float | None = None
            first_sys_ms: float | None = None
            j = i + 1
            while j < n and steps[j].get("type") not in (
                "PLANNER_RESPONSE",
                "USER_INPUT",
            ):
                nxt = steps[j]
                ntype = nxt.get("type")
                nts = parse_iso_ms(nxt.get("created_at"))
                if ntype == "GENERIC":
                    following_generics.append(nxt)
                    content = str(nxt.get("content") or "")
                    head = content[:300]
                    cm = CREATED_RE.search(head)
                    dm = COMPLETED_RE.search(head)
                    t_c = parse_iso_ms(cm.group(1)) if cm else nts
                    t_d = parse_iso_ms(dm.group(1)) if dm else None
                    if t_c is not None and (first_tool_ms is None or t_c < first_tool_ms):
                        first_tool_ms = t_c
                    if t_c is not None and t_d is not None and t_d >= t_c:
                        tool_intervals.append((t_c, t_d))
                elif ntype == "SYSTEM_MESSAGE" and first_sys_ms is None and nts is not None:
                    first_sys_ms = nts
                j += 1

            for ref in extract_subagent_refs_from_step(tool_calls, following_generics):
                cid = ref["conversation_id"]
                if cid not in seen_sub_ids:
                    seen_sub_ids.add(cid)
                    subagent_refs.append(ref)

            tool_ms = merge_intervals_ms(tool_intervals)

            model_ms = 0.0
            if start_ms is not None:
                end_ms: float | None = None
                if first_tool_ms is not None:
                    end_ms = first_tool_ms
                elif first_sys_ms is not None:
                    end_ms = first_sys_ms
                elif j == n and now_ms is not None:
                    # 实时 PostInvocation 触发时，以当前时间作为最后一步回复结束时刻
                    end_ms = now_ms
                if end_ms is not None and 0 <= (end_ms - start_ms) <= 600_000:
                    model_ms = end_ms - start_ms

            inv = {
                "seq": len(all_invocations) + 1,
                "step_index": step.get("step_index"),
                "model": step.get("model") or "",
                "input_tokens": inp,
                "cache_read_tokens": cache,
                "total_in": total_in,
                "output_tokens": out,
                "total_tokens": total_in + out,
                "has_tools": len(tool_calls) > 0,
                "model_ms": model_ms,
                "tool_ms": tool_ms,
                "raw_end_idx": j - 1,
            }
            all_invocations.append(inv)
            current_turn.append(inv)
            i = j
            continue

        i += 1

    if current_turn:
        turns.append(current_turn)

    if not all_invocations:
        return None

    return {
        "turns": turns,
        "current_turn": turns[-1],
        "all_invocations": all_invocations,
        "last": all_invocations[-1],
        "subagent_refs": subagent_refs,
    }


def collect_subagents_recursive(
    transcript_path: str,
    root_refs: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """递归加载当前主对话派发的所有子孙智能体 transcript 并汇总其用量。"""
    brain_dir, root_conv_id = infer_brain_and_conv_id(transcript_path)
    if not brain_dir or not root_conv_id:
        return []

    visited: set[str] = {root_conv_id}
    collected: list[dict[str, Any]] = []

    def walk(parent_id: str, direct_refs: list[dict[str, Any]], depth: int) -> None:
        if depth > MAX_SUBAGENT_DEPTH or len(collected) >= MAX_SUBAGENT_COUNT:
            return

        # 合并 swarm/members.json 兜底记录
        merged = list(direct_refs)
        existing = {r["conversation_id"] for r in direct_refs}
        for fb in read_swarm_members_fallback(brain_dir, parent_id):
            if fb["conversation_id"] not in existing:
                existing.add(fb["conversation_id"])
                merged.append(fb)

        for ref in merged:
            if len(collected) >= MAX_SUBAGENT_COUNT:
                break
            cid = ref["conversation_id"]
            if cid in visited:
                continue
            visited.add(cid)

            sub_path = os.path.join(brain_dir, cid, ".system_generated", "logs", "transcript.jsonl")
            sub_summary: dict[str, Any] | None = None
            if os.path.isfile(sub_path):
                try:
                    mtime_ms = os.path.getmtime(sub_path) * 1000.0
                    sub_steps = load_transcript(sub_path)
                    sub_summary = analyze_steps(sub_steps, now_ms=mtime_ms)
                except OSError:
                    sub_summary = None

            invs = sub_summary["all_invocations"] if sub_summary else []
            s_inp = sum(x["input_tokens"] for x in invs)
            s_cache = sum(x["cache_read_tokens"] for x in invs)
            s_out = sum(x["output_tokens"] for x in invs)
            s_model_ms = sum(x["model_ms"] for x in invs)
            s_tool_ms = sum(x["tool_ms"] for x in invs)
            label = (
                f"swarm: {ref['role']}"
                if ref["kind"] == "swarm" and ref.get("role")
                else (ref.get("role") or ref.get("type_name") or f"subagent-{cid[:6]}")
            )
            model_raw = invs[-1]["model"] if invs else ref.get("model", "")

            collected.append(
                {
                    "conversation_id": cid,
                    "depth": depth,
                    "kind": ref["kind"],
                    "label": label,
                    "model": fmt_model(model_raw),
                    "steps": len(invs),
                    "input_tokens": s_inp,
                    "cache_read_tokens": s_cache,
                    "output_tokens": s_out,
                    "total_tokens": s_inp + s_cache + s_out,
                    "model_ms": s_model_ms,
                    "tool_ms": s_tool_ms,
                }
            )

            if sub_summary:
                walk(cid, sub_summary.get("subagent_refs") or [], depth + 1)

    walk(root_conv_id, root_refs, 1)
    return collected


def build_end_of_turn_markdown(
    summary: dict[str, Any],
    subagents: list[dict[str, Any]] | None = None,
) -> str:
    """构造每轮结束时注入聊天流的精简 Markdown 统计表格。"""
    turn = summary["current_turn"]
    turns = summary["turns"]
    all_inv = summary["all_invocations"]
    last = summary["last"]

    turn_steps = len(turn)
    turn_inp = sum(x["input_tokens"] for x in turn)
    turn_cache = sum(x["cache_read_tokens"] for x in turn)
    turn_out = sum(x["output_tokens"] for x in turn)
    turn_total = turn_inp + turn_cache + turn_out
    turn_hit = fmt_pct(turn_cache, turn_inp + turn_cache)
    turn_model_ms = sum(x["model_ms"] for x in turn)
    turn_tool_ms = sum(x["tool_ms"] for x in turn)

    # 非首步出现整步缓存未命中时高亮提示
    has_cache_miss = any(
        x["seq"] > 1 and x["cache_read_tokens"] == 0 and x["input_tokens"] >= 5000
        for x in turn
    )
    miss_badge = " ⚠️" if has_cache_miss else ""

    sess_turns = len(turns)
    sess_steps = len(all_inv)
    sess_inp = sum(x["input_tokens"] for x in all_inv)
    sess_cache = sum(x["cache_read_tokens"] for x in all_inv)
    sess_out = sum(x["output_tokens"] for x in all_inv)
    sess_total = sess_inp + sess_cache + sess_out
    sess_hit = fmt_pct(sess_cache, sess_inp + sess_cache)
    sess_model_ms = sum(x["model_ms"] for x in all_inv)
    sess_tool_ms = sum(x["tool_ms"] for x in all_inv)

    tps_part = ""
    if sess_model_ms >= 1000 and sess_out > 0:
        tps = int(round(sess_out / (sess_model_ms / 1000.0)))
        tps_part = f" · 速度 `{tps} tok/s`"

    turn_tool_str = fmt_duration(turn_tool_ms) if turn_tool_ms >= 50 else "-"
    sess_tool_str = fmt_duration(sess_tool_ms) if sess_tool_ms >= 50 else "-"
    turn_time = f"{fmt_duration(turn_model_ms)} / {turn_tool_str}"
    sess_time = f"{fmt_duration(sess_model_ms)} / {sess_tool_str}"

    rows = [
        "| 维度 | 总用量 | 缓存命中 | 未缓存 | 缓存读 | 输出 | 耗时 (模型 / 工具) |",
        "| :--- | ---: | ---: | ---: | ---: | ---: | ---: |",
        (
            f"| **本轮** ({turn_steps}步) | **{fmt_num(turn_total)}** | "
            f"**{turn_hit}**{miss_badge} | {fmt_num(turn_inp)} | "
            f"{fmt_num(turn_cache)} | {fmt_num(turn_out)} | {turn_time} |"
        ),
        (
            f"| **会话** ({sess_turns}轮 {sess_steps}步) | **{fmt_num(sess_total)}** | "
            f"**{sess_hit}** | {fmt_num(sess_inp)} | "
            f"{fmt_num(sess_cache)} | {fmt_num(sess_out)} | {sess_time} |"
        ),
    ]

    # 存在子智能体时，追加「子代理」和「总计」两行；无子智能体时保持原有极简表格
    if subagents:
        sub_count = len(subagents)
        sub_steps = sum(x["steps"] for x in subagents)
        sub_inp = sum(x["input_tokens"] for x in subagents)
        sub_cache = sum(x["cache_read_tokens"] for x in subagents)
        sub_out = sum(x["output_tokens"] for x in subagents)
        sub_total = sub_inp + sub_cache + sub_out
        sub_hit = fmt_pct(sub_cache, sub_inp + sub_cache)
        sub_model_ms = sum(x["model_ms"] for x in subagents)
        sub_tool_ms = sum(x["tool_ms"] for x in subagents)
        sub_tool_str = fmt_duration(sub_tool_ms) if sub_tool_ms >= 50 else "-"
        sub_time = f"{fmt_duration(sub_model_ms)} / {sub_tool_str}"

        comb_steps = sess_steps + sub_steps
        comb_inp = sess_inp + sub_inp
        comb_cache = sess_cache + sub_cache
        comb_out = sess_out + sub_out
        comb_total = comb_inp + comb_cache + comb_out
        comb_hit = fmt_pct(comb_cache, comb_inp + comb_cache)
        comb_model_ms = sess_model_ms + sub_model_ms
        comb_tool_ms = sess_tool_ms + sub_tool_ms
        comb_tool_str = fmt_duration(comb_tool_ms) if comb_tool_ms >= 50 else "-"
        comb_time = f"{fmt_duration(comb_model_ms)} / {comb_tool_str}"

        rows.append(
            f"| **子代理** ({sub_count}个 {sub_steps}步) | **{fmt_num(sub_total)}** | "
            f"**{sub_hit}** | {fmt_num(sub_inp)} | "
            f"{fmt_num(sub_cache)} | {fmt_num(sub_out)} | {sub_time} |"
        )
        rows.append(
            f"| **总计** ({comb_steps}步) | **{fmt_num(comb_total)}** | "
            f"**{comb_hit}** | {fmt_num(comb_inp)} | "
            f"{fmt_num(comb_cache)} | {fmt_num(comb_out)} | {comb_time} |"
        )

    model_label = fmt_model(last.get("model"))
    rows.extend(
        [
            "",
            (
                f"模型 `{model_label}`{tps_part} · "
                f"[打开详情面板](sidecar://token-stats/token_dashboard/)"
            ),
        ]
    )
    return f"{chr(10).join(rows)}{INVISIBLE_MARKER}"


def resolve_transcript_path(payload: dict[str, Any]) -> str | None:
    candidates = []
    tp = payload.get("transcriptPath")
    if isinstance(tp, str) and tp:
        candidates.append(tp)
    art_dir = payload.get("artifactDirectoryPath")
    if isinstance(art_dir, str) and art_dir:
        candidates.append(
            os.path.join(art_dir, ".system_generated", "logs", "transcript.jsonl")
        )
    for p in candidates:
        if os.path.isfile(p):
            return p
    return None


def print_cli_report(path: str) -> None:
    steps = load_transcript(path)
    summary = analyze_steps(steps)
    if not summary:
        print("No PLANNER_RESPONSE steps with token usage found.")
        return

    subagents = collect_subagents_recursive(path, summary.get("subagent_refs") or [])

    print(f"Transcript: {path}")
    print(
        f"{'Step':>4} | {'Uncached':>8} | {'CacheRd':>8} | {'Hit%':>6} | "
        f"{'Out':>6} | {'Model':>7} | {'Tool':>7}"
    )
    print("-" * 64)
    for inv in summary["all_invocations"]:
        print(
            f"{inv['seq']:>4} | {fmt_num(inv['input_tokens']):>8} | "
            f"{fmt_num(inv['cache_read_tokens']):>8} | "
            f"{fmt_pct(inv['cache_read_tokens'], inv['total_in']):>6} | "
            f"{fmt_num(inv['output_tokens']):>6} | "
            f"{fmt_duration(inv['model_ms']):>7} | {fmt_duration(inv['tool_ms']):>7}"
        )

    if subagents:
        print("-" * 64)
        print(f"Subagents ({len(subagents)}):")
        for sa in subagents:
            indent = "  " * max(0, sa["depth"] - 1)
            hit = fmt_pct(sa["cache_read_tokens"], sa["input_tokens"] + sa["cache_read_tokens"])
            print(
                f"{indent}- {sa['label']} [{sa['conversation_id'][:8]}] "
                f"steps={sa['steps']} total={fmt_num(sa['total_tokens'])} "
                f"hit={hit} out={fmt_num(sa['output_tokens'])} "
                f"time={fmt_duration(sa['model_ms'])}/{fmt_duration(sa['tool_ms'])}"
            )

    print("-" * 64)
    print(build_end_of_turn_markdown(summary, subagents=subagents))


def run_hook() -> dict[str, Any]:
    raw_bytes = sys.stdin.buffer.read()
    raw = raw_bytes.decode("utf-8-sig", errors="replace")
    if not raw.strip():
        return {}
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        return {}

    transcript_path = resolve_transcript_path(payload)
    if not transcript_path:
        return {}

    steps = load_transcript(transcript_path)
    now_ms = time.time() * 1000.0
    summary = analyze_steps(steps, now_ms=now_ms)
    if not summary:
        return {}

    # 中间工具调用步骤保持静默，仅在每轮最终回复后注入一次
    if summary["last"]["has_tools"]:
        return {}

    # 防止对同一条 PLANNER_RESPONSE 重复注入
    last_end_idx = summary["last"]["raw_end_idx"]
    for trailing in steps[last_end_idx + 1 :]:
        content = str(trailing.get("content") or "")
        if INVISIBLE_MARKER in content:
            return {}

    subagents = collect_subagents_recursive(
        transcript_path, summary.get("subagent_refs") or []
    )
    md = build_end_of_turn_markdown(summary, subagents=subagents)
    return {
        "injectSteps": [
            {
                "systemMessage": {
                    "systemMessage": md,
                }
            }
        ]
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Antigravity token & cache stats hook")
    parser.add_argument("--file", help="Inspect a transcript.jsonl directly from CLI")
    args = parser.parse_args()

    if args.file:
        print_cli_report(args.file)
        return

    try:
        result = run_hook()
    except Exception:
        result = {}
    # 输出 ASCII 转义 JSON，避免 Windows 控制台代码页乱码
    sys.stdout.write(json.dumps(result, ensure_ascii=True))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
