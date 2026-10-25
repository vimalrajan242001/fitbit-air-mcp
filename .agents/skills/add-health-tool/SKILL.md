---
name: add-health-tool
description: Add a Google Health API read to this MCP server. Use when adding a tool, resource, or data type.
---

# Add a Health API read

1. Open the official page for the data type and the method before writing the request. Start from the links in `docs/context.md`: the data-type guide, the method reference (`dailyRollUp`, `reconcile`, or `list`), and the filters page. Copy documented field names. Do not invent a unit conversion.
2. Page inside the server. Follow `nextPageToken` with the same request body or query. Sleep and exercise page size is 25. Stop at the page cap and add a `missing` entry if the window is not covered.
3. A missing scope or HTTP 403 becomes a `missing` entry. The rest of the tool still returns. A day or night with no wearable samples is an empty value plus a `missing` entry, not a fake zero. A documented zero stays zero.
4. Build the tool result from an allowlist of fields. Delete `macAddress` before the result is built. Do not return access tokens, refresh tokens, or the OAuth client.
5. This slice does not add write, delete, GPS, irregular-rhythm notifications, nutrition, ECG, heart-rate series, HRV, SpO2, or a Sleep Score. Ask before adding a scope or a tool.
6. Do not call `api.fitbit.com`. Log to stderr only. Extend the fixture tests with a published JSON example and run `npm run check`.
