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

Same five tools, same matching rules, reading the same public data — as a local stdio process.

```bash
npx eosl-mcp
```

**Claude Desktop / any stdio client** (`mcpServers` config):

```json
{ "mcpServers": { "eosl": { "command": "npx", "args": ["-y", "eosl-mcp"] } } }
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
| `bulk_check` | Up to 200 part numbers in one call, with summary counts |
| `search_models` | Find product families by vendor / line / series text |
| `get_family` | Full source-backed record for one family (every SKU, group dates, sources) |
| `list_vendors` | Tracked vendors with family counts |

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

- Data source: [`https://eosl.ai/data/lookup.json`](https://eosl.ai/data/lookup.json) — the same
  open dataset behind the site, **CC BY 4.0**, refreshed weekly from vendors' own published notices.
- This local server sends only the HTTP fetches above; part numbers you look up locally are matched
  in-process against the downloaded dataset copy for `lookup_part`/`bulk_check`/`search_models`
  (only `get_family` fetches per-slug). The hosted endpoint records aggregate usage as described at
  [eosl.ai/api/usage](https://eosl.ai/api/usage).
- Always confirm critical dates against the linked vendor bulletin before acting on them.

## License

Code: Apache-2.0. Dataset: [CC BY 4.0](https://eosl.ai/dataset/) — attribution to EOSL.ai.
