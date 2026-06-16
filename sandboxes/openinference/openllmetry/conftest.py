"""
Pytest fixtures for openinference-instrumentation-openllmetry sandbox tests.

Provides:
  - tracer_provider: TracerProvider with in-memory + optional Arize AX export
  - memory_exporter: InMemorySpanExporter for assertions
"""

import sys
import os
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../.."))

from sandboxes.openinference.shared.arize_trace_helper import (
    make_tracer_provider,
    flush_and_get_trace_url,
    write_trace_url_file,
)


@pytest.fixture(scope="module")
def tracer_provider():
    provider, memory_exporter = make_tracer_provider(service_name="osa-repro-openllmetry")
    yield provider, memory_exporter
    # Flush + write trace URL after all tests in the module complete.
    spans = memory_exporter.get_finished_spans()
    trace_id = spans[0].context.trace_id if spans else None
    url = flush_and_get_trace_url(provider, trace_id)
    write_trace_url_file(url)
    provider.shutdown()


@pytest.fixture(scope="module")
def memory_exporter(tracer_provider):
    _, exporter = tracer_provider
    return exporter


@pytest.fixture(scope="module")
def oi_tracer(tracer_provider):
    provider, _ = tracer_provider
    return provider.get_tracer("openinference-openllmetry-sandbox")


