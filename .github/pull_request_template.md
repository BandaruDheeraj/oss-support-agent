<!-- Thanks for contributing to the OSS support agent harness! -->

## Summary

<!-- Describe what this PR changes and why. -->

## Adapter contract checklist (US-113)

If this PR modifies `core/adapter.interface.ts` (the `RepoAdapter` interface or any of its supporting types: `Issue`, `ServiceConfig`, `SandboxOutput`, `EvalResult`, `PRMetadata`):

- [ ] I bumped `ADAPTER_INTERFACE_VERSION` in `core/adapter.interface.ts`.
- [ ] I updated `core/adapter.interface.snapshot.json` with a new entry for the bumped version.
- [ ] I either updated **every** existing adapter under `configs/<org>/<repo>/adapter.ts` to satisfy the new contract, **or** added a safe default for the new/changed method on `BaseRepoAdapter` so existing adapters keep compiling.
- [ ] `npm run lint` and `npm test` pass locally.

If this PR does **not** touch the adapter interface, you can ignore this section.

## Other notes

<!-- Anything else reviewers should know. -->
