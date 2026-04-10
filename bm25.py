"""
BM25 (Okapi BM25) lexical search with inverted index.

Production-ready implementation using Term-At-A-Time (TAAT) posting list
traversal — only documents containing query terms are scored.

Scoring formula (Okapi BM25):
  score(D, Q) = sum_qi [ IDF(qi) * tf(qi,D)*(k1+1) / (tf(qi,D) + k1*(1-b+b*|D|/avgdl)) ]

  IDF(qi) = log((N - df(qi) + 0.5) / (df(qi) + 0.5) + 1)   [Lucene variant, always >= 0]

  k1 = 1.5  (term frequency saturation)
  b  = 0.75 (document length normalization)

Drop-in compatible API: build_index, search, update_index, remove_from_index.
"""

import logging
import math
import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

_WORD_RE = re.compile(r"[a-z0-9_]+")


@dataclass
class BM25Index:
    """
    In-memory BM25 index with TAAT posting list search.

    Example:
        index = BM25Index()
        index.build_index([
            {"chunk_id": "c1", "text": "Python programming language"},
            {"chunk_id": "c2", "text": "JavaScript for web development"}
        ])
        results = index.search("programming", top_k=10)
        # Returns: [("c1", 0.85), ...]
    """

    k1: float = 1.5
    b: float = 0.75

    # term -> {chunk_id: tf}
    _posting_lists: dict[str, dict[str, int]] = field(default_factory=dict)
    _doc_lengths: dict[str, int] = field(default_factory=dict)
    _avg_doc_length: float = 0.0
    _doc_freqs: dict[str, int] = field(default_factory=dict)
    _idf_cache: dict[str, float] = field(default_factory=dict)
    _total_docs: int = 0
    _is_built: bool = False

    def __post_init__(self):
        self._posting_lists = {}
        self._doc_lengths = {}
        self._doc_freqs = {}
        self._idf_cache = {}

    @staticmethod
    def _tokenize(text: str) -> list[str]:
        if not text:
            return []
        tokens = _WORD_RE.findall(text.lower())
        return [t for t in tokens if len(t) > 1 or t in {"a", "i"}]

    def _compute_idf(self, term: str) -> float:
        df = self._doc_freqs.get(term, 0)
        if df > 0 and self._total_docs > 0:
            return math.log((self._total_docs - df + 0.5) / (df + 0.5) + 1.0)
        return 0.0

    # ── Build ──

    def build_index(self, chunks: list[dict]) -> None:
        """Build index from [{"chunk_id": str, "text": str}, ...]."""
        if not chunks:
            logger.warning("Building BM25 index with empty chunk list")
            self._is_built = True
            return

        self._posting_lists.clear()
        self._doc_lengths.clear()
        self._doc_freqs.clear()
        self._idf_cache.clear()

        total_length = 0

        for chunk in chunks:
            chunk_id = chunk.get("chunk_id")
            text = chunk.get("text", "")
            if not chunk_id:
                continue

            tokens = self._tokenize(text)
            self._doc_lengths[chunk_id] = len(tokens)
            total_length += len(tokens)

            for term, count in Counter(tokens).items():
                if term not in self._posting_lists:
                    self._posting_lists[term] = {}
                self._posting_lists[term][chunk_id] = count

        self._total_docs = len(self._doc_lengths)
        if self._total_docs == 0:
            self._is_built = True
            return

        self._avg_doc_length = total_length / self._total_docs

        for term, posting in self._posting_lists.items():
            self._doc_freqs[term] = len(posting)
            self._idf_cache[term] = self._compute_idf(term)

        self._is_built = True
        logger.info(
            "BM25 index built: %d docs, %d terms, avg length %.1f",
            self._total_docs, len(self._posting_lists), self._avg_doc_length,
        )

    # ── Search (TAAT) ──

    def search(self, query: str, top_k: int = 30) -> list[tuple[str, float]]:
        """Search via Term-At-A-Time posting list traversal."""
        if not self._is_built or not self._doc_lengths:
            return []
        if not query:
            return []

        query_tokens = self._tokenize(query)
        if not query_tokens:
            return []

        k1, b, avgdl = self.k1, self.b, self._avg_doc_length
        doc_lengths = self._doc_lengths
        posting_lists = self._posting_lists
        idf_cache = self._idf_cache

        scores: dict[str, float] = defaultdict(float)

        for term in query_tokens:
            posting = posting_lists.get(term)
            if not posting:
                continue
            idf = idf_cache.get(term, 0.0)
            if idf <= 0.0:
                continue
            for cid, tf in posting.items():
                dl = doc_lengths[cid]
                tf_sat = (tf * (k1 + 1.0)) / (tf + k1 * (1.0 - b + b * dl / avgdl))
                scores[cid] += idf * tf_sat

        if not scores:
            return []

        sorted_results = sorted(scores.items(), key=lambda x: x[1], reverse=True)
        return sorted_results[:top_k]

    # ── Incremental Updates ──

    def update_index(self, chunk_id: str, text: str) -> None:
        """Add or replace a single document."""
        if chunk_id in self._doc_lengths:
            self.remove_from_index(chunk_id)

        tokens = self._tokenize(text)
        if not tokens:
            return

        self._doc_lengths[chunk_id] = len(tokens)
        self._total_docs = len(self._doc_lengths)
        self._avg_doc_length = sum(self._doc_lengths.values()) / self._total_docs

        affected: set[str] = set()
        for term, count in Counter(tokens).items():
            if term not in self._posting_lists:
                self._posting_lists[term] = {}
            self._posting_lists[term][chunk_id] = count
            affected.add(term)

        for term in affected:
            self._doc_freqs[term] = len(self._posting_lists[term])
            self._idf_cache[term] = self._compute_idf(term)

    def remove_from_index(self, chunk_id: str) -> bool:
        """Remove a document from the index."""
        if chunk_id not in self._doc_lengths:
            return False

        affected: set[str] = set()
        for term, posting in list(self._posting_lists.items()):
            if chunk_id in posting:
                del posting[chunk_id]
                affected.add(term)
                if not posting:
                    del self._posting_lists[term]
                    self._doc_freqs.pop(term, None)
                    self._idf_cache.pop(term, None)

        del self._doc_lengths[chunk_id]
        self._total_docs = len(self._doc_lengths)
        self._avg_doc_length = (
            sum(self._doc_lengths.values()) / self._total_docs
            if self._total_docs > 0 else 0.0
        )

        for term in affected:
            if term in self._posting_lists:
                self._doc_freqs[term] = len(self._posting_lists[term])
                self._idf_cache[term] = self._compute_idf(term)

        return True

    # ── Stats / Clear ──

    def get_index_stats(self) -> dict:
        return {
            "total_documents": self._total_docs,
            "unique_terms": len(self._posting_lists),
            "avg_doc_length": self._avg_doc_length,
            "is_built": self._is_built,
            "k1": self.k1,
            "b": self.b,
        }

    def clear(self) -> None:
        self._posting_lists.clear()
        self._doc_lengths.clear()
        self._doc_freqs.clear()
        self._idf_cache.clear()
        self._total_docs = 0
        self._avg_doc_length = 0.0
        self._is_built = False
