#!/usr/bin/env python3
"""Find generateSaveTask / saveDraft function body in CapCut editor bundle."""
import re
import sys

PATH = sys.argv[1] if len(sys.argv) > 1 else 'tmp/editor-bundle/bundle-027.js'

with open(PATH) as f:
    src = f.read()

print(f'=== File: {PATH} ({len(src)} bytes) ===\n')

# Find generateSaveTask() method definition
# Pattern: generateSaveTask() { ... } — need to balance braces
def find_method_body(name, src, max_size=8000):
    results = []
    for m in re.finditer(rf'{name}\s*\(\s*\)\s*\{{', src):
        start = m.end() - 1  # opening brace
        depth = 0
        end = start
        for i in range(start, min(start + max_size, len(src))):
            c = src[i]
            if c == '{':
                depth += 1
            elif c == '}':
                depth -= 1
                if depth == 0:
                    end = i + 1
                    break
        results.append(src[m.start():end])
    return results

for name in ['generateSaveTask', 'saveDraft']:
    print(f'\n=== {name}() bodies ===')
    bodies = find_method_body(name, src)
    if not bodies:
        print(f'  (no {name}() method found)')
        continue
    for i, body in enumerate(bodies[:2]):
        print(f'\n--- {name} #{i} (first 4000 chars) ---')
        print(body[:4000])

# Also find the actual save request body construction
# Look for "plane_draft/save" usage
print('\n\n=== plane_draft/save context ===')
for m in re.finditer(r'plane_draft/save', src):
    chunk = src[max(0, m.start() - 500):m.end() + 3000]
    print(chunk)
    print('---')
    break

# Search for saveRequest builder patterns
print('\n\n=== Search for save body construction patterns ===')
for pattern in [r'template_data\s*:', r'package_assets\s*:', r'referenced_assets\s*:', r'cover_image_content\s*:']:
    matches = list(re.finditer(pattern, src))
    if matches:
        print(f'\n>>> Pattern: {pattern} ({len(matches)} matches)')
        for m in matches[:2]:
            chunk = src[max(0, m.start() - 100):m.end() + 500]
            print(chunk)
            print('---')
