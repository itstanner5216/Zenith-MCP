"""
Pipeline orchestrator — wires search → crawl → synthesis → output.
"""

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

logger = logging.getLogger("search_pipeline.pipeline")


@dataclass
class PipelineResult:
    [TRUNCATED: lines 26-38]


class SearchPipeline:
    """Main pipeline: query_expansion → search → crawl → depth2 → synthesis → output."""

    async def execute(
        [TRUNCATED: lines 43-71]
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

            logger.info("Search returned %d URLs via %s", len(all_urls), search_source)

            # ── Stage 3: Depth-1 crawl ──
            crawl_results = await crawl_urls(all_urls, mode)
            successful_crawls = [r for r in crawl_results if r.success and r.markdown_content]

            if not successful_crawls:
                result.error = "All crawl attempts failed"
                result.elapsed_seconds = time.monotonic() - t0
                return result

            # ── Stage 3b: Rerank (deep mode) ──
            if mode == SearchMode.DEEP and len(successful_crawls) > max_urls:
                logger.info("Reranking %d crawled pages → top %d", len(successful_crawls), max_urls)
                successful_crawls = await rerank(successful_crawls, query, top_n=max_urls)

            result.crawled_count = len(successful_crawls)

            # ── Stage 4: Depth-2 crawl (deep only) ──
            depth2_results: list[CrawlResult] = []
            if mode == SearchMode.DEEP:
                depth2_results = await crawl_depth2(
                    successful_crawls, query, settings.deep_depth2_max_pages
                )
                depth2_successful = [r for r in depth2_results if r.success and r.markdown_content]
                result.depth2_count = len(depth2_successful)
                successful_crawls.extend(depth2_successful)
                logger.info("Depth-2: %d additional pages crawled", len(depth2_successful))

            # ── Stage 5: Synthesis ──
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

            # ── Stage 6: Output ──
            source_dicts = [
                {"url": s.url, "title": s.title, "content": s.content, "depth": s.depth}
                for s in sources
            ]

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
            "Pipeline %s in %.2fs — mode=%s, sources=%d, depth2=%d",
            "succeeded" if result.success else "failed",
            result.elapsed_seconds,
            mode.value,
            result.crawled_count,
            result.depth2_count,
        )
        return result