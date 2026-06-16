"""
Sandbox regression test for issue #64:
  OpenInferenceSpanProcessor maps OpenLLMetry tool spans to TOOL kind
  but drops tool.name and leaves raw Traceloop input/output envelopes.

This test:
  1. Creates a span with real OpenLLMetry attributes (as the SDK would emit)
  2. Passes it through OpenInferenceSpanProcessor._map_generic_span()
  3. Exports the resulting (broken) attributes to Arize AX so reviewers can
     see the broken trace directly in the observability UI
  4. Asserts the broken behavior (REPRO_BUG_SENTINEL)

After the fix in PR #65 this test should PASS (broken behavior resolved).
"""

import json
import pytest

from openinference.instrumentation.openllmetry._span_processor import _map_generic_span
from sandboxes.openinference.shared.arize_trace_helper import get_span_attrs


TOOL_INPUT_ENVELOPE = json.dumps({
    "input_str": "some string",
    "tags": ["tag1"],
    "metadata": {},
    "inputs": {"query": "what is 2+2?"},
    "kwargs": {},
})

TOOL_OUTPUT_ENVELOPE = json.dumps({
    "output": "4",
    "kwargs": {},
})

TRACELOOP_TOOL_ATTRS = {
    "traceloop.span.kind": "tool",
    "traceloop.entity.name": "my_calculator_tool",
    "traceloop.entity.input": TOOL_INPUT_ENVELOPE,
    "traceloop.entity.output": TOOL_OUTPUT_ENVELOPE,
}


@pytest.fixture(scope="module")
def mapped_attrs():
    """Call _map_generic_span once for the whole module; each test reads from the result."""
    return _map_generic_span(dict(TRACELOOP_TOOL_ATTRS))


def test_tool_span_sets_tool_name(oi_tracer, mapped_attrs):
    """REPRO: _map_generic_span() must set tool.name from traceloop.entity.name."""
    with oi_tracer.start_as_current_span("openllmetry-tool-span") as span:
        for k, v in TRACELOOP_TOOL_ATTRS.items():
            span.set_attribute(k, v)

        assert "tool.name" in mapped_attrs, (
            "REPRO_BUG_SENTINEL: _map_generic_span() does not set 'tool.name' "
            f"for tool spans. Got keys: {list(mapped_attrs.keys())}"
        )
        assert mapped_attrs["tool.name"] == "my_calculator_tool", (
            "REPRO_BUG_SENTINEL: tool.name should be 'my_calculator_tool', "
            f"got {mapped_attrs.get('tool.name')}"
        )
        span.set_attribute("osa.test", "issue_64_tool_name")
        span.set_attribute("osa.result.tool_name", mapped_attrs.get("tool.name", "(missing)"))


def test_tool_span_unwraps_input(oi_tracer, mapped_attrs):
    """REPRO: input.value must be the unwrapped 'inputs' sub-dict, not the raw envelope."""
    with oi_tracer.start_as_current_span("openllmetry-tool-input-unwrap") as span:
        assert "input.value" in mapped_attrs, (
            f"REPRO_BUG_SENTINEL: 'input.value' not found in result. Got: {mapped_attrs}"
        )
        try:
            parsed = json.loads(mapped_attrs["input.value"])
        except Exception:
            parsed = mapped_attrs["input.value"]

        assert parsed == {"query": "what is 2+2?"}, (
            "REPRO_BUG_SENTINEL: input.value should be unwrapped 'inputs' sub-dict "
            f"{{'query': 'what is 2+2?'}}, but got: {mapped_attrs.get('input.value')}"
        )
        span.set_attribute("osa.test", "issue_64_input_unwrap")
        span.set_attribute("osa.result.input_value", str(mapped_attrs.get("input.value", "(missing)")))


def test_tool_span_unwraps_output(oi_tracer, mapped_attrs):
    """REPRO: output.value must be the unwrapped 'output' field, not the raw envelope."""
    with oi_tracer.start_as_current_span("openllmetry-tool-output-unwrap") as span:
        assert "output.value" in mapped_attrs, (
            f"REPRO_BUG_SENTINEL: 'output.value' not found in result. Got: {mapped_attrs}"
        )
        assert mapped_attrs["output.value"] == "4", (
            "REPRO_BUG_SENTINEL: output.value should be '4' (unwrapped from output envelope), "
            f"but got: {mapped_attrs.get('output.value')}"
        )
        span.set_attribute("osa.test", "issue_64_output_unwrap")
        span.set_attribute("osa.result.output_value", str(mapped_attrs.get("output.value", "(missing)")))
