#!/usr/bin/env python3
"""Prepare and normalize the MemoryVault documentation snapshot.

Fetching is deliberately delegated to curl through the generated config file.
This script only reads and writes local files.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, urlparse

from bs4 import BeautifulSoup
from markdownify import markdownify


ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / "references" / "memoryvault"
INDEX = BASE / "mcp-llms-index.txt"
REFERENCE_LIST = ROOT / "memoryvault-documentation.md"
ADDITIONAL_SOURCES = BASE / "additional-sources.txt"
MCP_VERSION = "2026-07-28"
OWASP_PDFS = {
    "https://genai.owasp.org/download/52117/?tmstv=1765059207": "owasp-agentic-top10-2026.pdf",
    "https://genai.owasp.org/download/49059/?tmstv=1753666640": "owasp-securing-agentic-applications.pdf",
}


def slug_for(url: str) -> str:
    parsed = urlparse(url)
    path = parsed.path.strip("/").removesuffix(".md")
    stem = re.sub(r"[^a-z0-9]+", "-", f"{parsed.netloc}-{path}".lower()).strip("-")
    return f"{stem[:110]}-{hashlib.sha256(url.encode()).hexdigest()[:10]}"


def collect_sources() -> list[dict[str, str]]:
    links = re.findall(r"\[[^]]+\]\((https://[^)]+)\)", REFERENCE_LIST.read_text())
    if ADDITIONAL_SOURCES.exists():
        links.extend(
            line.strip()
            for line in ADDITIONAL_SOURCES.read_text().splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        )
    mcp_links = re.findall(r"\[[^]]+\]\((https://[^)]+)\)", INDEX.read_text())
    mcp_links = [
        url
        for url in mcp_links
        if f"/docs/{MCP_VERSION}/" in url
        or f"/specification/{MCP_VERSION}/" in url
        or url == "https://modelcontextprotocol.io/examples.md"
    ]
    mcp_links.extend(
        [
            "https://modelcontextprotocol.io/llms.txt",
            "https://ts.sdk.modelcontextprotocol.io/v2/",
            "https://py.sdk.modelcontextprotocol.io/",
        ]
    )
    seen: set[str] = set()
    result: list[dict[str, str]] = []
    for url in links + mcp_links:
        if url in seen:
            continue
        seen.add(url)
        category = "mcp" if "modelcontextprotocol.io" in url else "reference"
        if "supabase.com" in url:
            category = "supabase"
        elif "genai.owasp.org" in url:
            category = "owasp"
        elif "developers.openai.com" in url:
            category = "openai"
        elif "code.claude.com" in url:
            category = "claude_code"
        elif "platform.claude.com" in url:
            category = "anthropic"
        elif "postgresql.org" in url:
            category = "postgresql"
        result.append({"url": url, "category": category, "slug": slug_for(url)})
    return result


def prepare() -> None:
    (BASE / "raw").mkdir(parents=True, exist_ok=True)
    (BASE / "pages").mkdir(parents=True, exist_ok=True)
    sources = collect_sources()
    (BASE / "sources.json").write_text(json.dumps(sources, indent=2) + "\n")
    config: list[str] = []
    missing_config: list[str] = []
    for source in sources:
        raw_path = BASE / "raw" / f"{source['slug']}.txt"
        entry = [f'url = "{source["url"]}"', f'output = "{raw_path}"', "next"]
        config.extend(entry)
        if not raw_path.exists():
            missing_config.extend(entry)
    if config:
        config.pop()  # A trailing `next` creates an empty final curl transfer.
    if missing_config:
        missing_config.pop()
    (BASE / "download.curl").write_text("\n".join(config) + "\n")
    (BASE / "download-missing.curl").write_text("\n".join(missing_config) + "\n")
    print(f"Prepared {len(sources)} URLs; {len(missing_config) // 3 + bool(missing_config)} missing")


def text_from_html(raw: str) -> tuple[str, str]:
    soup = BeautifulSoup(raw, "html.parser")
    title = soup.title.get_text(" ", strip=True) if soup.title else "Untitled"
    candidates = soup.find_all("article") + soup.find_all("main")
    target = max(candidates, key=lambda node: len(node.get_text(" ", strip=True))) if candidates else soup.body or soup
    for tag in target.find_all(["script", "style", "nav", "aside", "footer", "header", "svg", "form", "button", "noscript"]):
        tag.decompose()
    content = markdownify(str(target), heading_style="ATX", bullets="-")
    content = re.sub(r"\n{4,}", "\n\n\n", content).strip()
    return title, content


def normalize(source: dict[str, str], raw: str) -> tuple[str, str]:
    if source["url"].endswith((".md", ".txt")):
        title = next((line.lstrip("# ") for line in raw.splitlines() if line.startswith("# ")), source["slug"])
        content = raw.strip()
    else:
        title, content = text_from_html(raw)
    return title, content


def process() -> None:
    sources: list[dict[str, str]] = json.loads((BASE / "sources.json").read_text())
    fetched_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    rows: list[dict[str, str | int]] = []
    for source in sources:
        raw_path = BASE / "raw" / f"{source['slug']}.txt"
        row: dict[str, str | int] = dict(source)
        if not raw_path.exists():
            row["status"] = "missing"
            rows.append(row)
            continue
        raw_bytes = raw_path.read_bytes()
        raw = raw_bytes.decode("utf-8", errors="replace")
        title, content = normalize(source, raw)
        if len(content) < 200 or content.lstrip().startswith("404"):
            row["status"] = "too_short_or_error"
            row["content_chars"] = len(content)
            rows.append(row)
            continue
        destination = BASE / "pages" / f"{source['slug']}.md"
        header = (
            "---\n"
            f"title: {json.dumps(title, ensure_ascii=False)}\n"
            f"source_url: {json.dumps(source['url'])}\n"
            f"category: {source['category']}\n"
            f"retrieved_at_utc: {fetched_at}\n"
            f"source_sha256: {hashlib.sha256(raw_bytes).hexdigest()}\n"
            "---\n\n"
        )
        destination.write_text(header + content + "\n")
        row.update(
            status="ok",
            title=title,
            content_chars=len(content),
            raw_bytes=len(raw_bytes),
            snapshot=str(destination.relative_to(ROOT)),
        )
        rows.append(row)

    for name in [
        "memoryvault-documentation.md",
        "README.md",
        "PORTFOLIO_SETUP.md",
        "docs/ROADMAP.md",
    ]:
        path = ROOT / name
        if not path.exists():
            continue
        if path.suffix == ".pdf":
            output = subprocess.run(["pdftotext", "-layout", str(path), "-"], check=True, capture_output=True, text=True).stdout
        else:
            output = path.read_text()
        destination = BASE / "pages" / f"local-{slug_for(name)}.md"
        header = (
            "---\n"
            f"title: {json.dumps(path.stem)}\n"
            f"source_path: {json.dumps(name)}\n"
            "category: project\n"
            f"retrieved_at_utc: {fetched_at}\n"
            f"source_sha256: {hashlib.sha256(path.read_bytes()).hexdigest()}\n"
            "---\n\n"
        )
        destination.write_text(header + output.strip() + "\n")
        rows.append(
            {
                "url": name,
                "category": "project",
                "status": "ok",
                "title": path.stem,
                "content_chars": len(output),
                "snapshot": str(destination.relative_to(ROOT)),
            }
        )

    for url, name in OWASP_PDFS.items():
        path = BASE / "raw" / name
        if not path.exists():
            rows.append({"url": url, "category": "owasp", "status": "missing"})
            continue
        output = subprocess.run(
            ["pdftotext", "-layout", str(path), "-"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        title = path.stem.replace("-", " ").title()
        destination = BASE / "pages" / f"{path.stem}.md"
        header = (
            "---\n"
            f"title: {json.dumps(title)}\n"
            f"source_url: {json.dumps(url)}\n"
            "category: owasp\n"
            f"retrieved_at_utc: {fetched_at}\n"
            f"source_sha256: {hashlib.sha256(path.read_bytes()).hexdigest()}\n"
            "---\n\n"
        )
        destination.write_text(header + output.strip() + "\n")
        rows.append(
            {
                "url": url,
                "category": "owasp",
                "status": "ok",
                "title": title,
                "content_chars": len(output),
                "raw_bytes": path.stat().st_size,
                "snapshot": str(destination.relative_to(ROOT)),
            }
        )

    with (BASE / "manifest.jsonl").open("w") as manifest:
        for row in rows:
            manifest.write(json.dumps(row, ensure_ascii=False) + "\n")

    by_category: dict[str, list[dict[str, str | int]]] = {}
    for row in rows:
        by_category.setdefault(str(row["category"]), []).append(row)
    catalog = ["# MemoryVault reference snapshots", "", f"Retrieved: {fetched_at}", ""]
    for category, members in sorted(by_category.items()):
        catalog.extend([f"## {category.title()} ({len(members)})", ""])
        for row in members:
            if row["status"] != "ok":
                catalog.append(f"- Fetch failed: {row['url']}")
                continue
            snapshot = Path(str(row["snapshot"]))
            relative = snapshot.relative_to(BASE.relative_to(ROOT))
            source = str(row["url"])
            if not source.startswith("https://"):
                source = "../../" + quote(source)
            catalog.append(f"- [{row['title']}]({relative}) — [source]({source})")
        catalog.append("")
    (BASE / "CATALOG.md").write_text("\n".join(catalog))

    with (BASE / "chunks.jsonl").open("w") as chunks_file:
        for row in rows:
            if row["status"] != "ok":
                continue
            page = (ROOT / str(row["snapshot"])).read_text()
            page = page.split("---\n\n", 1)[-1]
            paragraphs = re.split(r"\n\s*\n", page)
            chunk_parts: list[str] = []
            chunk_size = 0
            chunk_index = 0

            def emit_chunk() -> None:
                nonlocal chunk_parts, chunk_size, chunk_index
                if not chunk_parts:
                    return
                chunks_file.write(
                    json.dumps(
                        {
                            "source": row["url"],
                            "title": row["title"],
                            "category": row["category"],
                            "snapshot": row["snapshot"],
                            "chunk_index": chunk_index,
                            "text": "\n\n".join(chunk_parts),
                        },
                        ensure_ascii=False,
                    )
                    + "\n"
                )
                chunk_index += 1
                chunk_parts = []
                chunk_size = 0

            for paragraph in paragraphs:
                paragraph = paragraph.strip()
                if not paragraph:
                    continue
                if len(paragraph) > 4000:
                    emit_chunk()
                    for start in range(0, len(paragraph), 3800):
                        chunk_parts = [paragraph[start : start + 3800]]
                        chunk_size = len(chunk_parts[0])
                        emit_chunk()
                elif chunk_size + len(paragraph) > 4000:
                    emit_chunk()
                    chunk_parts.append(paragraph)
                    chunk_size = len(paragraph)
                else:
                    chunk_parts.append(paragraph)
                    chunk_size += len(paragraph) + 2
            emit_chunk()

    counts: dict[str, int] = {}
    for row in rows:
        status = str(row["status"])
        counts[status] = counts.get(status, 0) + 1
    print(json.dumps(counts, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["prepare", "process"])
    args = parser.parse_args()
    {"prepare": prepare, "process": process}[args.action]()
