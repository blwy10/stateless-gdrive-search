<!-- Copyright (c) 2026 Benjamin Lau -->
<!-- SPDX-License-Identifier: MIT -->

# Inaccessible files: surface Google's error reason

> Part of the [project documentation](./README.md). Operating rules live in
> [`AGENTS.md`](../AGENTS.md).

Some files return `200` on metadata but fail the content fetch. The canonical
case (seen in `.debug`): a Google Sheet whose owner has disabled
download/export (IRM/DLP) returns `403` on `/export` with
`{ error: { message: "This file cannot be exported by the user.",
errors: [{ reason: "cannotExportFile" }] } }`. It is NOT a size limit (the file
can be tiny) and NOT something the app can work around — Google blocks the bytes
server-side. Other permanent reasons in this family: `notFound`,
`insufficientFilePermissions`, `fileNotDownloadable`; `exportSizeLimitExceeded`
is the genuinely-too-large case.

`googleFetch` (in `lib/drive/client.ts`) used to throw a bare
`"Google Drive request failed with status 403"`, which (a) told the model
nothing — so it might pointlessly re-open the same file — and (b) hid the reason
unless DEBUG_LOG_CONTENT was on (the body is logged via `debugText`, so it's
`{length, hash}` when content logging is off). Now `parseDriveApiError` (covered
by `test/drive.test.ts`) pulls the `reason` + `message` out of the body and
`googleFetch`:
- throws `"...failed with status 403: This file cannot be exported by the user.
  (cannotExportFile)"` — the message reaches the model via `errorText` so it
  skips the file and can note the gap in its answer; and
- adds `reason` (a stable, non-sensitive code) to the `drive.google.failed` log
  unconditionally, so 403s are diagnosable without DEBUG_LOG_CONTENT (the raw
  body stays gated in `response`).

Retry interaction: `isRetryableToolError` (in `lib/agent/tool-runtime.ts`) keys
off the `status <N>` prefix, NOT any digits in the message — otherwise the
appended Google prose (which can contain a standalone `500`-like number) could
trigger a pointless retry of a hard `403`. Only `408/409/429/5xx` after
`status ` are retried. Both behaviours are covered in `test/agent.test.ts`
(handler call-count) and `test/drive.test.ts` (`parseDriveApiError`).
