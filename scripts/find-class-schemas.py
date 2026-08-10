#!/usr/bin/env python3
"""Find class schemas referenced in segment/material schemas."""
import re
import sys

PATH = sys.argv[1] if len(sys.argv) > 1 else 'tmp/editor-bundle/bundle-035.js'

with open(PATH) as f:
    src = f.read()

def find_schema(name, max_size=2500):
    """Find `let NAME = { ... }` and return body."""
    # Try multiple patterns - class definitions or let assignments
    patterns = [
        rf'\blet\s+{name}\s*=\s*\{{',
        rf'\bconst\s+{name}\s*=\s*\{{',
        rf'\bclass\s+{name}\b',
        rf'\b{name}\s*=\s*\{{',
    ]
    for pat in patterns:
        for m in re.finditer(pat, src):
            start = m.end() - 1 if '{' in m.group(0) else m.start()
            # Find next {
            brace_start = src.find('{', start)
            if brace_start == -1:
                continue
            depth = 0
            end = brace_start
            for i in range(brace_start, min(brace_start + max_size, len(src))):
                c = src[i]
                if c == '{':
                    depth += 1
                elif c == '}':
                    depth -= 1
                    if depth == 0:
                        end = i + 1
                        break
            return src[m.start():end]
    return None

for name in ['cO', 'cW', 'f7', 'TW', 'Ii', 'm5', 'Il', 'Im', 'IA', 'Ek']:
    print(f'=== {name} ===')
    body = find_schema(name)
    if body:
        print(body[:2500])
    else:
        print(f'(not found)')
    print()
