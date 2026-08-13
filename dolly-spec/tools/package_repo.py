#!/usr/bin/env python3
"""Create a deterministic source archive without requiring a Git checkout."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
import zipfile


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "dist" / "dolly-spec.zip"
EXCLUDED_TOP_LEVEL = {".git", "book", "dist", "node_modules", "__pycache__"}
EXCLUDED_SUFFIXES = {".log", ".pyc", ".tmp"}
ARCHIVE_TIME = (2026, 8, 10, 0, 0, 0)


def included(path: Path) -> bool:
    relative = path.relative_to(ROOT)
    return (
        relative.parts
        and relative.parts[0] not in EXCLUDED_TOP_LEVEL
        and not any(part == "__pycache__" for part in relative.parts)
        and path.suffix not in EXCLUDED_SUFFIXES
        and not path.is_symlink()
    )


def main() -> int:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    files = sorted(path for path in ROOT.rglob("*") if path.is_file() and included(path))
    with zipfile.ZipFile(OUTPUT, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in files:
            relative = path.relative_to(ROOT)
            info = zipfile.ZipInfo(f"dolly-spec/{relative.as_posix()}", ARCHIVE_TIME)
            mode = 0o755 if os.access(path, os.X_OK) else 0o644
            info.external_attr = (mode & 0xFFFF) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, path.read_bytes(), compresslevel=9)

    digest = hashlib.sha256(OUTPUT.read_bytes()).hexdigest()
    print(f"wrote {OUTPUT.relative_to(ROOT)} ({len(files)} files, sha256:{digest})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
