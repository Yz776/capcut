#!/usr/bin/env python3
"""Find video material schema fields in CapCut editor bundle."""
import re
import sys

PATH = sys.argv[1] if len(sys.argv) > 1 else 'tmp/editor-bundle/bundle-035.js'

with open(PATH) as f:
    src = f.read()

print(f'=== File: {PATH} ({len(src)} bytes) ===')

# 1. Find YB enum (fileType) - look for "Video" or "Image" near it
print('\n=== YB-like enums ===')
for m in re.finditer(r'(\w{1,3})\s*=\s*\{[^}]*"Video"[^}]*\}', src):
    print(f'At offset {m.start()}: {src[m.start():m.start()+500]}')
    print('---')
    if m.start() > 5_000_000: break  # cap

# 2. Find all schemas with material_id and category fields
print('\n=== Schemas with material_id ===')
for m in re.finditer(r'\[\s*"id"[^\]]{50,1500}\]', src):
    s = m.group(0)
    if 'material_id' in s:
        print(s[:1500])
        print('---')

# 3. Find context around 'video_id' assignment
print('\n=== Context around video_id assignment ===')
for m in re.finditer(r'video_id', src):
    chunk = src[max(0, m.start()-300):m.end()+1000]
    if 'width' in chunk or 'height' in chunk or 'duration' in chunk:
        print(chunk[:2000])
        print('---')
        break
