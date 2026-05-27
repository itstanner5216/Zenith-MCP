from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from .config import SearchMode, settings
from .crawler import CrawlResult, crawl_depth2, crawl_urls
from .output import format_deep, format_regular, write_markdown
from .query_expansion import expand_queries
from .ranker import rerank
from .search import execute_search
from .synthesis import SourceMaterial, synthesize



@dataclass
class PipelineResult:
# ... [lines 26-36 omitted]


class SearchPipeline:
    """Main pipeline: query_expansion → search → crawl → depth2 → synthesis → output."""

    async def execute(
        self,
        query: str,
        mode: SearchMode = SearchMode.REGULAR,
        max_results: Optional[int] = None,
        output_path: Optional[str] = None,
    ) -> PipelineResult:
        t0 = time.monotonic()
        result = PipelineResult(success=False, query=query, mode=mode)

        try:
            # ── Stage 1: Query expansion ──
            if mode == SearchMode.DEEP:
                queries = await expand_queries(query, settings.deep_query_variants)
            else:
                queries = [query]
            result.queries_used = queries
            logger.info("Queries: %s", queries)

            # ... [lines 61-66 omitted]
            all_urls: list[str] = []
            search_source = ""

            if parallel and len(queries) > 1:
                # Deep mode: search all variants in parallel, merge results
                import asyncio
                tasks = [execute_search(q, crawl_pool, parallel=True) for q in queries]
                search_results = await asyncio.gather(*tasks)

                seen: set[str] = set()
                source_labels: set[str] = set()
                for urls, src in search_results:
                    source_labels.add(src)
                    for url in urls:
                        if url not in seen:
                            seen.add(url)
                            all_urls.append(url)
                search_source = "+".join(sorted(source_labels))
            else:
                all_urls, search_source = await execute_search(query, crawl_pool, parallel=parallel)

            all_urls = all_urls[:crawl_pool]
            result.urls_found = all_urls
            result.search_source = search_source

            if not all_urls:
                result.error = "No URLs found from search engines"
                result.elapsed_seconds = time.monotonic() - t0
                return result

            # ... [lines 97-102 omitted]
            if not successful_crawls:
                result.error = "All crawl attempts failed"
                result.elapsed_seconds = time.monotonic() - t0
                return result

            # ── Stage 3b: Rerank (deep mode) ──
            # ... [lines 109-114 omitted]
            # ── Stage 4: Depth-2 crawl (deep only) ──
            depth2_results: list[CrawlResult] = []
            if mode == SearchMode.DEEP:
                depth2_results = await crawl_depth2(
                    successful_crawls, query, settings.deep_depth2_max_pages
                )
            # ... [lines 121-126 omitted]
            sources = [
                SourceMaterial(
                    url=r.url,
                    title=r.title or r.url,
                    content=r.markdown_content,
                    depth=r.depth,
                )
                for r in successful_crawls
            ]

            synthesis_text = await synthesize(sources, query, mode)

            # ... [lines 139-144 omitted]
            if mode == SearchMode.DEEP:
                md_content = format_deep(
                    query=query,
                    synthesis=synthesis_text,
                    sources=source_dicts,
                    search_source=search_source,
                    queries_used=queries,
                    depth2_count=result.depth2_count,
                )
            else:
                md_content = format_regular(
                    query=query,
                    synthesis=synthesis_text,
                    sources=source_dicts,
                    search_source=search_source,
                )

            filepath = write_markdown(md_content, output_path=output_path, query=query)
            result.output_file = str(filepath.resolve())
            result.success = True

        except Exception as e:
            logger.exception("Pipeline error: %s", e)
            result.error = str(e)

        result.elapsed_seconds = round(time.monotonic() - t0, 3)
        logger.info(