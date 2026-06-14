<!-- Copyright (c) 2026 Benjamin Lau -->
<!-- SPDX-License-Identifier: MIT -->

# Railway MCP: pin the project/environment first

> Part of the [project documentation](./README.md). Operating rules live in
> [`AGENTS.md`](../AGENTS.md); deployment basics are in the
> [`README`](../README.md#deployment).

The configured `railway` MCP server is backed by the local Railway CLI, so its
environment-scoped tools resolve the **currently linked** project/environment/
service from local CLI state. When nothing is linked, those tools fail with
`Failed to connect to MCP server 'railway'`. This reads like a transport/network
error but is actually a missing-context error — retrying does not help.

- Works without linking (no environment context needed): `whoami`,
  `list_projects`, and `list_services` (pass an explicit `project_id`).
- Needs a linked context: `environment_status`, `get_service_config`,
  `list_deployments`, `list_variables`, `get_logs`, `set_variables`,
  `generate_domain`, `update_service`, `add_reference_variable`, etc.

Fix: link the project once up front, then **also pass explicit IDs on every MCP
call** (the MCP does not reliably share the working-directory link, so explicit
IDs are the robust path):

```bash
railway link --project <project-id> --environment production --service <service-name>
railway status --json   # prints the linked project/environment/service IDs
```

Discover the project/environment/service IDs at runtime rather than hardcoding
them — they change if infrastructure is recreated and should be treated as
sensitive (do not commit them):

- `railway status --json` once a project is linked, or
- the MCP `list_projects` / `list_services` tools, then resolve the environment
  by name (commonly `production`).
