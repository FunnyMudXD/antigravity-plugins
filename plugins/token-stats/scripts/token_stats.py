#!/usr/bin/env python3
"""Antigravity PostInvocation hook for end-of-turn token, cache & latency stats.

Silent on intermediate tool-calling steps; injects 1 concise summary at the end
of each turn (when the latest PLANNER_RESPONSE has no tool_calls).

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
    parts = raw.strip().split("-")
    # e.g. gemini-4-neon-high -> Gemini 4 Neon (High)
    tier_words = {"high", "medium", "low", "fast", "thinking"}
    if len(parts) >= 2 and parts[-1].lower() in tier_words:
        base = " ".join(p.capitalize() if not p.isdigit() else p for p in parts[:-1])
        return f"{base} ({parts[-1].capitalize()})"
    return " ".join(p.capitalize() if not p.isdigit() else p for p in parts)


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


def analyze_steps(
    steps: list[dict[str, Any]], now_ms: float | None = None
) -> dict[str, Any] | None:
    turns: list[list[dict[str, Any]]] = []
    current_turn: list[dict[str, Any]] = []
    all_invocations: list[dict[str, Any]] = []

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

            # Scan steps following this PLANNER_RESPONSE until next model/user step
            tool_intervals: list[tuple[float, float]] = []
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

            tool_ms = merge_intervals_ms(tool_intervals)

            # Determine model duration for this step
            model_ms = 0.0
            if start_ms is not None:
                end_ms: float | None = None
                if first_tool_ms is not None:
                    end_ms = first_tool_ms
                elif first_sys_ms is not None:
                    end_ms = first_sys_ms
                elif j == n and now_ms is not None:
                    # Live PostInvocation firing right as final reply completes
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
    }


def build_end_of_turn_markdown(summary: dict[str, Any]) -> str:
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

    # Highlight if any non-first step in this turn experienced full cache miss
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

    model_label = fmt_model(last.get("model"))
    table = "\n".join(
        [
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
            "",
            (
                f"模型 `{model_label}`{tps_part} · "
                f"[打开详情面板](sidecar://token-stats/token_dashboard/)"
            ),
        ]
    )
    return f"{table}{INVISIBLE_MARKER}"


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
    print("-" * 64)
    print(build_end_of_turn_markdown(summary))


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

    # Silent on intermediate tool-calling steps; only inject once at end of turn
    if summary["last"]["has_tools"]:
        return {}

    # Guard against duplicate injection for the same PLANNER_RESPONSE
    last_end_idx = summary["last"]["raw_end_idx"]
    for trailing in steps[last_end_idx + 1 :]:
        content = str(trailing.get("content") or "")
        if INVISIBLE_MARKER in content:
            return {}

    md = build_end_of_turn_markdown(summary)
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
    # Use ASCII-escaped JSON to avoid Windows console codepage issues
    sys.stdout.write(json.dumps(result, ensure_ascii=True))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
