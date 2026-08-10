#!/usr/bin/env python3
"""Dump all captured requests/responses from the v3 capture, sorted by sequence."""
import json
import sys
from urllib.parse import urlparse

CAP = "/home/z/my-project/capcut-api/tmp/captures/api-capture-v3.jsonl"

with open(CAP) as f:
    entries = []
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            entries.append(json.loads(line))
        except:
            continue

print(f"Total entries: {len(entries)}")
print()

# Group by URL path
by_path = {}
for e in entries:
    url = e.get("url", "")
    if not url:
        continue
    path = urlparse(url).path
    by_path.setdefault(path, []).append(e)

# Show all unique paths with sample method/kind
print("=== Unique paths captured ===")
for path in sorted(by_path.keys()):
    items = by_path[path]
    methods = set(it.get("method", "?") for it in items)
    kinds = set(it.get("kind", "?") for it in items)
    statuses = set(str(it.get("status", "")) for it in items if it.get("kind") == "response")
    print(f"  {path}  methods={list(methods)} kinds={list(kinds)} statuses={list(statuses)} ({len(items)})")

print()
print("=== Sequence of requests (with body) ===")
for e in entries:
    if e.get("kind") != "request":
        continue
    if e.get("method") == "OPTIONS":
        continue
    url = e.get("url", "")
    if "capcut" not in url:
        continue
    path = urlparse(url).path
    body = e.get("postData") or ""
    if isinstance(body, (dict, list)):
        body = json.dumps(body)
    print(f"  [{e.get('seq')}] {e.get('method')} {path}")
    if body and len(body) < 800:
        print(f"        body: {body[:800]}")
    elif body:
        print(f"        body (truncated): {body[:400]}...")

print()
print("=== All responses ===")
for e in entries:
    if e.get("kind") != "response":
        continue
    url = e.get("url", "")
    if "capcut" not in url:
        continue
    path = urlparse(url).path
    body = e.get("body") or ""
    if isinstance(body, (dict, list)):
        body = json.dumps(body)
    print(f"  [{e.get('seq')}] HTTP {e.get('status')} {path}")
    if body and len(body) < 800:
        print(f"        body: {body[:800]}")
    elif body:
        print(f"        body (truncated): {body[:400]}...")
