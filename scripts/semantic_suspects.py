#!/usr/bin/env python3
from __future__ import annotations

import ast
import contextlib
import hashlib
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

from llama_index.core import Settings, SimpleDirectoryReader, StorageContext, VectorStoreIndex, load_index_from_storage
from llama_index.embeddings.huggingface import HuggingFaceEmbedding


def _read_payload() -> dict[str, Any]:
  raw = sys.stdin.read().strip()
  if not raw:
    raise ValueError("semantic_suspects.py expects JSON payload on stdin")
  payload = json.loads(raw)
  if not isinstance(payload, dict):
    raise ValueError("payload must be a JSON object")
  return payload


def _normalize_rel_path(path_value: str) -> str:
  return path_value.replace("\\", "/").lstrip("./").lstrip("/")


def _is_hidden_or_ignored(name: str) -> bool:
  if not name:
    return True
  ignored = {
    ".git",
    "node_modules",
    ".venv",
    "venv",
    ".agent-venv",
    ".semantic-venv",
    ".semantic-hf-cache",
    ".semantic-index-cache",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".tox",
    "dist",
    "build",
  }
  return name.startswith(".") and name not in {".", ".."} or name in ignored


def _collect_instrumentation_dirs(workspace_dir: Path, affected_module: str) -> list[Path]:
  dirs: list[Path] = []
  seen: set[Path] = set()

  def add_dir(candidate: Path) -> None:
    resolved = candidate.resolve()
    if not resolved.exists() or not resolved.is_dir():
      return
    if resolved in seen:
      return
    seen.add(resolved)
    dirs.append(resolved)

  affected = (affected_module or ".").strip()
  if affected and affected != ".":
    add_dir(workspace_dir / affected)

  common = [
    workspace_dir / "instrumentation",
    workspace_dir / "python" / "instrumentation",
    workspace_dir / "openinference" / "instrumentation",
    workspace_dir / "src" / "instrumentation",
  ]
  for candidate in common:
    add_dir(candidate)

  max_depth = 6
  for root, dir_names, _ in os.walk(workspace_dir):
    rel = Path(root).resolve().relative_to(workspace_dir.resolve())
    depth = len(rel.parts)
    dir_names[:] = [
      d
      for d in dir_names
      if not _is_hidden_or_ignored(d) and depth < max_depth
    ]
    base = Path(root).name.lower()
    rel_norm = str(rel).replace("\\", "/").lower()
    if "instrument" in base or "/instrumentation" in f"/{rel_norm}":
      add_dir(Path(root))

  if not dirs:
    add_dir(workspace_dir)

  return dirs


def _list_python_files(instrumentation_dirs: list[Path], workspace_dir: Path) -> list[str]:
  files: list[str] = []
  for directory in instrumentation_dirs:
    rel_dir = _normalize_rel_path(str(directory.relative_to(workspace_dir)))
    if _is_hidden_or_ignored(directory.name):
      continue
    try:
      reader = SimpleDirectoryReader(
        input_dir=str(directory),
        recursive=True,
        required_exts=[".py"],
        filename_as_id=True,
      )
    except ValueError as exc:
      if "No files found" in str(exc):
        continue
      raise
    for file_path in reader.input_files:
      path_obj = Path(file_path).resolve()
      if not path_obj.is_file():
        continue
      rel = _normalize_rel_path(str(path_obj.relative_to(workspace_dir)))
      if rel.startswith(".semantic-"):
        continue
      if rel_dir and not rel.startswith(rel_dir):
        continue
      files.append(rel)
  deduped = sorted(set(files))
  return deduped


def _compute_cache_key(workspace_dir: Path, files: list[str], model: str) -> str:
  hasher = hashlib.sha256()
  hasher.update(model.encode("utf-8"))
  for rel in files:
    absolute = workspace_dir / rel
    stat = absolute.stat()
    hasher.update(rel.encode("utf-8"))
    hasher.update(str(stat.st_size).encode("utf-8"))
    hasher.update(str(stat.st_mtime_ns).encode("utf-8"))
  return hasher.hexdigest()[:24]


def _load_or_build_index(
  workspace_dir: Path,
  files: list[str],
  model: str,
  cache_root: Path,
) -> tuple[VectorStoreIndex, bool, str]:
  cache_key = _compute_cache_key(workspace_dir, files, model)
  persist_dir = cache_root / cache_key
  index_file = persist_dir / "index_store.json"
  if index_file.exists():
    storage_context = StorageContext.from_defaults(persist_dir=str(persist_dir))
    return load_index_from_storage(storage_context), True, cache_key

  input_files = [str((workspace_dir / rel).resolve()) for rel in files]
  reader = SimpleDirectoryReader(input_files=input_files, filename_as_id=True)
  docs = reader.load_data()
  if not docs:
    raise RuntimeError("semantic index received zero documents")

  index = VectorStoreIndex.from_documents(docs)
  persist_dir.mkdir(parents=True, exist_ok=True)
  index.storage_context.persist(persist_dir=str(persist_dir))
  return index, False, cache_key


def _extract_primary_symbols(file_path: Path) -> tuple[str | None, str | None]:
  source = file_path.read_text(encoding="utf-8", errors="ignore")
  try:
    tree = ast.parse(source, filename=str(file_path))
  except SyntaxError:
    return None, None
  primary_class: str | None = None
  primary_func: str | None = None
  for node in tree.body:
    if primary_class is None and isinstance(node, ast.ClassDef):
      primary_class = node.name
    if primary_func is None and isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
      primary_func = node.name
    if primary_class is not None and primary_func is not None:
      break
  return primary_class, primary_func


def _node_file_path(metadata: dict[str, Any], text: str) -> str | None:
  candidates = [
    metadata.get("file_path"),
    metadata.get("filepath"),
    metadata.get("source"),
    metadata.get("file_name"),
    metadata.get("document_id"),
  ]
  for candidate in candidates:
    if isinstance(candidate, str) and candidate.strip():
      return candidate
  match = re.search(r"([A-Za-z0-9_\-./\\]+\.py)", text)
  if match:
    return match.group(1)
  return None


def _normalize_result_path(workspace_dir: Path, file_value: str) -> str:
  candidate = Path(file_value)
  if not candidate.is_absolute():
    candidate = (workspace_dir / file_value).resolve()
  try:
    rel = candidate.relative_to(workspace_dir.resolve())
    return _normalize_rel_path(str(rel))
  except ValueError:
    return _normalize_rel_path(file_value)


def _emit_json(payload: dict[str, Any]) -> None:
  sys.stdout.write(json.dumps(payload))
  sys.stdout.write("\n")
  sys.stdout.flush()


def main() -> int:
  payload = _read_payload()
  workspace_dir = Path(str(payload.get("workspaceDir", ""))).resolve()
  if not workspace_dir.exists():
    raise ValueError(f"workspaceDir does not exist: {workspace_dir}")

  query = str(payload.get("query", "")).strip()
  if not query:
    raise ValueError("query must be non-empty")
  top_k = int(payload.get("topK", 5))
  if top_k <= 0:
    top_k = 5
  affected_module = str(payload.get("affectedModule", ".")).strip() or "."

  model_name = os.getenv("SEMANTIC_INDEX_MODEL", "BAAI/bge-small-en-v1.5")

  instrumentation_dirs = _collect_instrumentation_dirs(workspace_dir, affected_module)
  py_files = _list_python_files(instrumentation_dirs, workspace_dir)
  if not py_files:
    _emit_json(
      {
        "model": model_name,
        "cacheHit": False,
        "cacheKey": "no-files",
        "indexedFileCount": 0,
        "instrumentationDirs": [
          _normalize_rel_path(str(d.relative_to(workspace_dir))) for d in instrumentation_dirs
        ],
        "results": [],
      }
    )
    return 0

  # Guard stdout contract: third-party libraries may print progress lines.
  # Redirecting to stderr keeps stdout as JSON-only for workflow parsers.
  with contextlib.redirect_stdout(sys.stderr):
    Settings.embed_model = HuggingFaceEmbedding(model_name=model_name)
    Settings.llm = None

    cache_root = Path(
      os.getenv("SEMANTIC_INDEX_CACHE_DIR", str(workspace_dir / ".semantic-index-cache"))
    ).resolve()
    cache_root.mkdir(parents=True, exist_ok=True)
    index, cache_hit, cache_key = _load_or_build_index(workspace_dir, py_files, model_name, cache_root)

    retriever = index.as_retriever(similarity_top_k=top_k)
    nodes = retriever.retrieve(query)
  seen_files: set[str] = set()
  results: list[dict[str, Any]] = []
  for node in nodes:
    metadata = node.metadata or {}
    file_hint = _node_file_path(metadata, node.get_content())
    if not file_hint:
      continue
    normalized = _normalize_result_path(workspace_dir, file_hint)
    if not normalized or normalized in seen_files:
      continue
    file_path = workspace_dir / normalized
    if not file_path.exists() or file_path.suffix != ".py":
      continue
    seen_files.add(normalized)
    primary_class, primary_function = _extract_primary_symbols(file_path)
    results.append(
      {
        "file": normalized,
        "score": float(node.score) if node.score is not None else None,
        "primaryClass": primary_class,
        "primaryFunction": primary_function,
      }
    )
    if len(results) >= top_k:
      break

  _emit_json(
    {
      "model": model_name,
      "cacheHit": cache_hit,
      "cacheKey": cache_key,
      "indexedFileCount": len(py_files),
      "instrumentationDirs": [
        _normalize_rel_path(str(d.relative_to(workspace_dir))) for d in instrumentation_dirs
      ],
      "results": results,
    }
  )
  return 0


if __name__ == "__main__":
  try:
    raise SystemExit(main())
  except Exception as exc:
    print(str(exc), file=sys.stderr)
    raise
