#!/usr/bin/env python3
"""Analyze the captured CapCut API traffic to find real request bodies for the
endpoints we need (get_template_file, plane_draft/save, prepare_upload_cloud,
create_cloud_asset, render_task/create).

Output: per-endpoint summary with URL, body, and response.
"""
import json
import sys
import os
from collections import defaultdict

CAPTURE_DIR = "/home/z/my-project/capcut-api/tmp/captures"
OUT_DIR = "/home/z/my-project/capcut-api/tmp/captures-analysis"
os.makedirs(OUT_DIR, exist_ok=True)

TARGET_ENDPOINTS = [
    "/lv/v1/editor/draft/get_template_file",
    "/lv/v1/editor/plane_draft/save",
    "/lv/v1/editor/plane_draft/get_draft_detail",
    "/lv/v1/editor/plane_draft/get_template_detail",
    "/lv/v1/cc_web/plane/get_template_detail",
    "/lv/v1/cc_web/replicate/multi_get_templates",
    "/lv/v1/asset/prepare_upload_cloud",
    "/lv/v1/asset/create_cloud_asset",
    "/lv/v1/render_task/create",
    "/lv/v1/render_task/batch_get",
    "/lv/v1/editor/video_draft/save",
    "/lv/v1/editor/video_draft/delta_update",
    "/lv/v1/editor/plane/intelligence/fill_render",
    "/lv/v1/intelligence/render_create",
    "/lv/v1/cc_web_task/get_task_draft",
    "/lv/v1/cc_web_task/task_bind_draft",
    "/lv/v1/draft/get_package_info",
]


def parse_capture(path):
    """Parse a JSONL capture file. Each line: {url, method, headers, body, response, ...}"""
    entries = []
    with open(path) as f:
        for line_no, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
                entries.append(entry)
            except json.JSONDecodeError as e:
                # First line may be MOTD
                if "Z_B64" in line or "sakura" in line:
                    continue
                print(f"  ! line {line_no} JSON error: {e}", file=sys.stderr)
    return entries


def extract_endpoint(url):
    """Get the path component from a URL."""
    if not url:
        return None
    try:
        from urllib.parse import urlparse
        return urlparse(url).path
    except Exception:
        return None


def find_target_hits(entries):
    """Group entries by endpoint path, only keep ones matching TARGET_ENDPOINTS."""
    hits = defaultdict(list)
    for e in entries:
        ep = extract_endpoint(e.get("url") or e.get("request", {}).get("url"))
        if not ep:
            continue
        for tgt in TARGET_ENDPOINTS:
            if ep.endswith(tgt) or ep == tgt:
                hits[tgt].append(e)
                break
    return hits


def main():
    all_hits = defaultdict(list)
    captures = sorted(os.listdir(CAPTURE_DIR))
    for cap_name in captures:
        if not cap_name.endswith(".jsonl"):
            continue
        cap_path = os.path.join(CAPTURE_DIR, cap_name)
        print(f"\n=== {cap_name} ===")
        entries = parse_capture(cap_path)
        print(f"  {len(entries)} entries")
        hits = find_target_hits(entries)
        for ep, items in hits.items():
            print(f"  {ep}: {len(items)} hits")
            all_hits[ep].extend(items)

    # Save per-endpoint detailed analysis
    print("\n\n=== Detailed per-endpoint analysis ===")
    for ep in TARGET_ENDPOINTS:
        items = all_hits.get(ep, [])
        out_path = os.path.join(OUT_DIR, ep.strip("/").replace("/", "_") + ".json")
        if not items:
            print(f"\n[{ep}] NO HITS")
            with open(out_path, "w") as f:
                json.dump({"endpoint": ep, "hits": 0, "note": "no captures"}, f, indent=2)
            continue
        print(f"\n[{ep}] {len(items)} hits")
        # Extract first 3 unique bodies
        seen_bodies = set()
        unique = []
        for item in items:
            body = item.get("postData") or item.get("body") or item.get("request", {}).get("body") or ""
            body_str = json.dumps(body, sort_keys=True) if isinstance(body, (dict, list)) else str(body)
            key = body_str[:200]
            if key in seen_bodies:
                continue
            seen_bodies.add(key)
            unique.append(item)
            if len(unique) >= 3:
                break

        with open(out_path, "w") as f:
            json.dump({
                "endpoint": ep,
                "total_hits": len(items),
                "unique_samples": len(unique),
                "samples": unique,
            }, f, indent=2, default=str)
        print(f"  saved: {out_path}")
        # Print first sample for quick view
        if unique:
            s = unique[0]
            body = s.get("postData") or s.get("body") or s.get("request", {}).get("body") or ""
            resp = s.get("response") or s.get("responseBody") or s.get("response_body") or ""
            url = s.get("url") or s.get("request", {}).get("url", "")
            print(f"  URL: {url}")
            print(f"  BODY: {str(body)[:500]}")
            print(f"  RESP: {str(resp)[:300]}")


if __name__ == "__main__":
    main()
