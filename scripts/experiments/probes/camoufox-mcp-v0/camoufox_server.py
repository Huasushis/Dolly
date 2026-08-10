#!/usr/bin/env python3
"""Launch the preregistered Camoufox Playwright endpoint for one MCP case."""

from camoufox.server import launch_server


if __name__ == "__main__":
    launch_server(
        headless=True,
        os="linux",
        window=(800, 600),
        locale="en-US",
        enable_cache=False,
    )
