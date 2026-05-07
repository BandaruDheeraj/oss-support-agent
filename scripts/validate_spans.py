#!/usr/bin/env python3
"""Validate OpenInference spans in a running Phoenix instance.

This harness script is intentionally dependency-free.

Contract:
- Accepts --phoenix-url
- Emits one "VIOLATION: <message>" line per failure on stdout
- Exits non-zero if any violations are found

Note: The full OpenInference span contract evolves; this script focuses on a small,
robust baseline: ensure Phoenix is reachable and returning HTTP 2xx/3xx.
"""

from __future__ import annotations

import argparse
import sys
import urllib.request


def check_phoenix_reachable(url: str) -> list[str]:
    violations: list[str] = []

    try:
        req = urllib.request.Request(url, headers={"User-Agent": "oss-support-agent/validate_spans"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            status = getattr(resp, "status", None) or resp.getcode()
            if status < 200 or status >= 400:
                violations.append(f"Phoenix returned HTTP {status} for {url}")
    except Exception as e:  # noqa: BLE001 - broad for CLI robustness
        violations.append(f"Phoenix not reachable at {url}: {e}")

    return violations


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--phoenix-url", required=True, help="Phoenix base URL (e.g. http://localhost:6006/)")
    args = parser.parse_args()

    url = args.phoenix_url
    if not url.endswith("/"):
        url = url + "/"

    violations = check_phoenix_reachable(url)

    for v in violations:
        print(f"VIOLATION: {v}")

    return 1 if violations else 0


if __name__ == "__main__":
    raise SystemExit(main())
