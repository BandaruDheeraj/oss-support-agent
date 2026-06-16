"""
Arize AX trace export helper for OSA repro sandboxes.

Usage in a repro test:
    from sandboxes.openinference.shared.arize_trace_helper import (
        make_tracer_provider,
        flush_and_get_trace_url,
        write_trace_url_file,
    )
"""

import os
import sys
from typing import Optional

from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter


def _make_arize_exporter():
    """Return an OTLPSpanExporter pointed at Arize AX, or None if creds are missing."""
    api_key = os.environ.get("ARIZE_API_KEY", "")
    space_id = os.environ.get("ARIZE_SPACE_ID", "")
    if not api_key or not space_id:
        return None
    try:
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    except ImportError:
        print("[arize_trace_helper] opentelemetry-exporter-otlp-proto-http not installed; skipping Arize export", file=sys.stderr)
        return None

    endpoint = os.environ.get("ARIZE_ENDPOINT", "https://otlp.arize.com/v1/traces")
    project = os.environ.get("ARIZE_PROJECT_NAME", "osa-repro")
    return OTLPSpanExporter(
        endpoint=endpoint,
        headers={
            "arize-space-id": space_id,
            "arize-api-key": api_key,
            "arize-project-name": project,
        },
    )


def make_tracer_provider(service_name: str = "osa-repro") -> tuple:
    """
    Create a TracerProvider with:
      - InMemorySpanExporter (always, for test assertions)
      - OTLPSpanExporter to Arize AX (when ARIZE_API_KEY + ARIZE_SPACE_ID are set)

    Returns (TracerProvider, InMemorySpanExporter).
    """
    from opentelemetry.sdk.resources import Resource, SERVICE_NAME

    memory_exporter = InMemorySpanExporter()
    resource = Resource.create({SERVICE_NAME: service_name})
    provider = TracerProvider(resource=resource)
    provider.add_span_processor(SimpleSpanProcessor(memory_exporter))

    arize_exporter = _make_arize_exporter()
    if arize_exporter:
        provider.add_span_processor(BatchSpanProcessor(arize_exporter))
        print(f"[arize_trace_helper] Arize AX export enabled → project={os.environ.get('ARIZE_PROJECT_NAME', 'osa-repro')}", file=sys.stderr)
    else:
        print("[arize_trace_helper] Arize AX export skipped (no creds)", file=sys.stderr)

    return provider, memory_exporter


def flush_and_get_trace_url(provider: TracerProvider, trace_id: Optional[int] = None) -> Optional[str]:
    """
    Flush all pending spans and return an Arize AX deep-link URL for the trace.
    trace_id should be the integer trace ID from the span context.
    """
    provider.force_flush(timeout_millis=10_000)

    base = os.environ.get("ARIZE_UI_BASE_URL", "")
    if not base or trace_id is None:
        return None

    # Convert int trace ID to 32-char hex
    trace_id_hex = format(trace_id, "032x")
    joiner = "&" if "?" in base else "?"
    return f"{base.rstrip('/')}{joiner}selectedTrace={trace_id_hex}"


def write_trace_url_file(url: Optional[str], path: str = "sandbox-trace-url.txt") -> None:
    """Write the Arize trace URL to a file so the GHA sandbox step can capture it."""
    if url:
        with open(path, "w") as f:
            f.write(url)
        print(f"[arize_trace_helper] Trace URL written → {path}", file=sys.stderr)


def get_span_attrs(spans, name_filter: str = None) -> list:
    """Return attribute dicts for finished spans, optionally filtered by span name."""
    result = []
    for span in spans:
        if name_filter and span.name != name_filter:
            continue
        result.append({k: v for k, v in span.attributes.items()})
    return result
