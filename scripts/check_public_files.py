"""Check publishable Git files; report paths/categories only, never matched values."""
from pathlib import Path
import re
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[1]
paths=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','-z'],cwd=ROOT).decode('utf-8').split('\0')
forbidden_parts={'data','node_modules','.venv','runtime-secrets','_secrets','releases','_audit_artifacts','_runtime_logs','.gitea'}
patterns={
    'private-key':re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
    'github-token':re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b'),
    'model-key':re.compile(r'\bsk-[A-Za-z0-9_-]{24,}\b'),
    'original-client-brand':re.compile('万影|wanying',re.I),
    'internal-location':re.compile(r'E:[\\/]Codex|Gitea|192\.168\.\d+\.\d+',re.I),
}
findings=[]
for name in sorted(set(paths)):
    if not name:continue
    path=ROOT/name
    if any(part in forbidden_parts for part in Path(name).parts) or path.suffix.lower() in {'.db','.sqlite','.sqlite3','.pem','.key'}:
        findings.append((name,'forbidden-file'));continue
    if not path.is_file() or path.suffix.lower() in {'.png','.jpg','.jpeg','.webp'}:continue
    text=path.read_text(encoding='utf-8',errors='replace')
    # The scanner itself names forbidden patterns without containing source data.
    if name=='scripts/check_public_files.py':continue
    for category,pattern in patterns.items():
        if pattern.search(text):findings.append((name,category))
for name,category in findings:print(f'{name}: {category}')
if findings:sys.exit(1)
print(f'Public-file check passed: {len([p for p in paths if p])} files; no forbidden paths or credential patterns.')
