# eosl-mcp

MCP server for [EOSL.ai](https://eosl.ai) — **source-backed hardware end-of-life (EOL / EOSL)
lookups by part number**. Is this switch/server/firewall still supported? When did — or does —
vendor support end? Every answer carries the URL of the **manufacturer's own end-of-life bulletin**,
so nothing is asserted without a source. Unknown parts return `found:false`, never a guess.

Covers enterprise datacenter gear from Cisco, Dell, HPE, Fortinet, IBM, Juniper, Palo Alto Networks,
Arista, and more — current [coverage figures live on the site](https://eosl.ai/database/).

## Fastest path: the hosted endpoint (no install)

A hosted, no-auth instance runs at `https://eosl.ai/mcp` (Streamable HTTP), listed in the official
MCP registry as `ai.eosl/eosl`:

```bash
claude mcp add --transport http eosl https://eosl.ai/mcp
```

## This package: local stdio server

Same seven tools, answered by the hosted server, as a local stdio process. It is not published on npm; it runs straight from this repository.

```bash
npx -y github:Kranny36/eosl-mcp
```

**Claude Desktop / any stdio client** (`mcpServers` config):

```json
{ "mcpServers": { "eosl": { "command": "npx", "args": ["-y", "github:Kranny36/eosl-mcp"] } } }
```

**Docker:**

```bash
docker build -t eosl-mcp . && docker run -i eosl-mcp
```

Zero dependencies; Node ≥ 18. Verify everything works:

```bash
node server.js --selftest
```

## Tools

| Tool | What it does |
|---|---|
| `lookup_part` | One part number → status, end-of-sale, EOSL, support runway score, vendor bulletin URL |
| `bulk_check` | Up to 25 part numbers in one call, with summary counts. A longer list is refused, not shortened |
| `search_models` | Find product families by vendor / line / series text |
| `get_family` | Full source-backed record for one family (every SKU, group dates, sources) |
| `list_vendors` | Tracked vendors with family counts |
| `search` | The standard search half of the search/fetch pair that ChatGPT connectors and deep research call: up to 10 records as id, title and page address |
| `fetch` | The full record for an id from `search`: every date group, its part numbers, the vendor source of each date and when it was last read |

Every tool is read-only and annotated so (`readOnlyHint`). A part with no date is never counted as supported in `bulk_check`.

## How it works since 2.0.0

This server is a relay. Every tool call is forwarded to the hosted endpoint at `https://eosl.ai/mcp`
and the answer is returned unchanged, so the two can never disagree. `initialize` and `tools/list` are
answered locally and need no network; tool calls need outbound HTTPS to eosl.ai.

Versions up to 1.2.0 downloaded `https://eosl.ai/data/lookup.json` and matched locally. That file stops
being served on 31 January 2027. **Upgrade before then.**

Limits are the hosted server's: `bulk_check` takes 25 part numbers, and list checks are limited to 250
part numbers a day per address. Looking up one part at a time is not limited.

## Matching, honestly

Exact match first, then punctuation-insensitive, then **vendor-gated** Fortinet short-SKU aliases
(`FG-60E` → `FortiGate-60E`) — never fuzzy. If a caller names a vendor, a match from any other
vendor is rejected: another vendor's dates are worse than no answer. The rejection says which vendor
the part *is* tracked under, so a filter mistake reads as a filter mistake rather than as a coverage
gap.

**A `vendor` that names no tracked vendor is ignored, not enforced** (1.2.0). It cannot be protecting
you from a cross-vendor match, so it is an argument mix-up — and honouring it turns a fully tracked
part into `found:false`. The hosted server's telemetry caught a client passing `vendor:"eosl.ai"`,
which made one Catalyst 3850 part number miss every day for a month while the site had its page.
The answer comes back with a `vendorHint` saying the string was dropped and why.

## Data and privacy

- Data comes from the hosted endpoint, which reads vendors' own published notices, refreshed weekly.
- Every tool call sends its arguments (the part numbers or search text) to `https://eosl.ai/mcp`. Nothing
  is matched locally any more. The hosted endpoint records aggregate usage as described at
  [eosl.ai/api/usage](https://eosl.ai/api/usage) and in the [privacy page](https://eosl.ai/privacy/).
- Always confirm critical dates against the linked vendor bulletin before acting on them.

## License

Code: Apache-2.0.
