#!/usr/bin/env node
/*
 * eosl-mcp — stdio MCP server for EOSL.ai hardware end-of-life lookups.
 *
 * SINCE 2.0.0 THIS IS A RELAY. Every tool call is forwarded to the hosted endpoint at
 * https://eosl.ai/mcp and its answer is returned unchanged, so this server can never give a
 * different answer from the hosted one. Versions up to 1.2.0 downloaded
 * https://eosl.ai/data/lookup.json (the whole database) and matched locally; that file stops being
 * served on 2027-01-31, and the local copy of the matching rules had already drifted from the
 * hosted server twice.
 *
 * If your client speaks Streamable HTTP you do not need this at all:
 *
 *   claude mcp add --transport http eosl https://eosl.ai/mcp
 *
 * Run this when a client only speaks stdio:
 *
 *   npx -y github:Kranny36/eosl-mcp      (or)  node server.js
 *
 * initialize and tools/list are answered locally, so a client can inspect the server with no
 * network. Tool calls need outbound HTTPS to eosl.ai. Limits are the hosted server's: bulk_check
 * takes 25 part numbers, and list checks are limited to 250 part numbers a day per address.
 *
 * Zero dependencies. Node >= 18 (global fetch). Apache-2.0.
 */
'use strict';

const readline = require('node:readline');

const SITE = process.env.EOSL_SITE || 'https://eosl.ai';
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const VERSION = '2.1.0';

const toolError = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

// ---- tools (the hosted endpoint's list, kept here so tools/list works offline) ---------------------------------------------------
const TOOLS = [
  {
    "name": "lookup_part",
    "title": "Look up a part number",
    "annotations": {
      "title": "Look up a part number",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "description": "Look up one hardware part number or model name in the EOSL.ai database (read-only, no auth; for many parts use bulk_check). Returns support status, End-of-Sale and End-of-Service-Life dates, support runway score, and the primary vendor bulletin URL backing the dates. Matching is exact, then punctuation-insensitive, then Fortinet short-SKU aliases (FG-60E -> FortiGate-60E); a model/family name (e.g. \"7010TX-48\") that matches no SKU returns the family-level record, flagged matchedVia:family-name. Anything else returns found:false rather than a guessed date.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "part_number": {
          "type": "string",
          "description": "Vendor part number / SKU, e.g. \"WS-C3850-48P-S\" or \"FG-100F\"."
        },
        "vendor": {
          "type": "string",
          "description": "Optional vendor, e.g. \"Cisco\". A tracked vendor restricts the match to that vendor (a part tracked under another vendor returns found:false naming that vendor). A string that is not a tracked vendor is ignored and reported back as vendorHint."
        }
      },
      "required": [
        "part_number"
      ]
    }
  },
  {
    "name": "bulk_check",
    "title": "Check a list of part numbers",
    "annotations": {
      "title": "Check a list of part numbers",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "description": "Check up to 25 part numbers in one call (read-only, no auth; for a single part use lookup_part). A longer list is refused, not shortened; 250 part numbers a day per address across list checks. Returns a per-part row (status, EOSL date, source URL, page URL) plus summary counts: past, mixed, endingSoon, supported, active, endedNoDate (the vendor states support ended and publishes no date), unknown (no date on record), notFound. A part with no date is never counted as supported. Never partial and never destructive: unknown or malformed entries do not fail the call, each simply returns found:false in its row.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "part_numbers": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "minItems": 1,
          "maxItems": 25,
          "description": "Part numbers to check; max 25 after case-insensitive deduplication. Punctuation differences (dashes, dots, spaces) are tolerated by the matcher, so raw inventory strings are fine."
        }
      },
      "required": [
        "part_numbers"
      ]
    }
  },
  {
    "name": "search_models",
    "title": "Search product families",
    "annotations": {
      "title": "Search product families",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "description": "Search tracked product families by vendor, product line, or series name (case-insensitive substring, e.g. \"nexus 9300\"). Read-only. Returns up to 10 families with status, EOSL window, and page URL. Use this for discovery when you have a name; for an exact part number use lookup_part, and use get_family with a returned slug for the full record.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "query": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120,
          "description": "Search text, 1-120 characters."
        }
      },
      "required": [
        "query"
      ]
    }
  },
  {
    "name": "get_family",
    "title": "Get a product family record",
    "annotations": {
      "title": "Get a product family record",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "description": "Fetch the full source-backed record for one product family by slug (from search_models or lookup_part pageUrl): lifecycle dates per SKU group, every part number, support runway score factors, and the vendor bulletin URLs. Read-only; an unknown slug returns found:false with a hint, never an error.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "slug": {
          "type": "string",
          "description": "Family slug, e.g. \"cisco-catalyst-3850\"."
        }
      },
      "required": [
        "slug"
      ]
    }
  },
  {
    "name": "list_vendors",
    "title": "List tracked vendors",
    "annotations": {
      "title": "List tracked vendors",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "description": "List all vendors tracked by EOSL.ai with family counts and vendor page URLs. Read-only, no parameters. Use this first to check whether a vendor is covered at all; for specific models use search_models, for a part number use lookup_part.",
    "inputSchema": {
      "type": "object",
      "properties": {}
    }
  },
  {
    "name": "search",
    "title": "Search the database",
    "annotations": {
      "title": "Search the database",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "description": "Search EOSL.ai for a hardware model, product line, vendor or part number. Read-only. Returns up to 10 matching product records as {results: [{id, title, url}]}; pass an id to fetch for the full dated record. A part number returns the product family that holds it. This is the standard search half of the search/fetch pair; an agent that can choose tools gets more direct answers from lookup_part (one part number) and bulk_check (a list).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "query": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120,
          "description": "A model, product line, vendor or part number, e.g. \"FortiGate 60F\" or \"WS-C3850-48P-S\"."
        }
      },
      "required": [
        "query"
      ]
    }
  },
  {
    "name": "fetch",
    "title": "Fetch a product record",
    "annotations": {
      "title": "Fetch a product record",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "description": "Fetch the full record for one id returned by search, as {id, title, text, url, metadata}. Read-only. The text holds every lifecycle date group of the product family with its part numbers, the vendor bulletin each date was read from and when it was last verified. An unknown id returns an error result; nothing is guessed.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "description": "An id from search (a family slug such as \"fortinet-fortigate-60f\"), or that product's eosl.ai page address."
        }
      },
      "required": [
        "id"
      ]
    }
  }
];

// ---- relay ---------------------------------------------------------------------------------------
// One POST per tool call. The hosted server's result object is returned as it came, including its
// own error results (a refused list, an unknown slug). Only a failure to REACH it is ours to word,
// and it is worded as "could not look", never as "not found".
async function callTool(name, args) {
  let resp;
  try {
    resp = await fetch(`${SITE}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': `eosl-mcp/${VERSION}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args && typeof args === 'object' ? args : {} } }),
    });
  } catch (e) {
    return toolError(`Could not reach ${SITE}/mcp (${e.message}). Nothing was looked up; this is not a "not found" answer.`);
  }
  let body = null;
  try { body = await resp.json(); } catch { /* handled below */ }
  if (body && body.result && Array.isArray(body.result.content)) return body.result;
  const why = body && body.error && body.error.message ? body.error.message : `HTTP ${resp.status}`;
  return toolError(`${SITE}/mcp did not answer the call (${why}). Nothing was looked up; this is not a "not found" answer.`);
}

// ---- JSON-RPC over stdio (newline-delimited, per the MCP stdio transport) -----------------------
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } });

async function handleMessage(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return rpcError(null, -32600, 'Invalid Request: expected a JSON-RPC 2.0 object.');
  }
  const { method, id, params } = msg;
  if (typeof method !== 'string') return id === undefined ? null : rpcError(id, -32600, 'Invalid Request: missing method.');
  if (id === undefined) return null;                    // notification — no response
  try {
    if (method === 'initialize') {
      const requested = params && params.protocolVersion;
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'eosl', title: 'EOSL.ai — Hardware End-of-Life Database', version: VERSION },
        instructions: 'Look up end-of-life status for enterprise datacenter hardware (Cisco, Dell, HPE, Fortinet, IBM, Juniper, and more) by part number or product family. Every date is backed by a linked vendor bulletin — nothing is estimated, and unknown parts return found:false. Confirm critical dates at the sourceUrl before making support or purchasing decisions.',
      });
    }
    if (method === 'ping') return rpcResult(id, {});
    if (method === 'tools/list') return rpcResult(id, { tools: TOOLS });
    if (method === 'tools/call') {
      const name = params && params.name;
      if (typeof name !== 'string') return rpcError(id, -32602, 'tools/call requires params.name.');
      if (!TOOLS.some((t) => t.name === name)) return rpcError(id, -32602, `Unknown tool: ${name}`);
      return rpcResult(id, await callTool(name, params.arguments));
    }
    return rpcError(id, -32601, `Method not found: ${method}`);
  } catch (e) {
    if (method === 'tools/call') return rpcResult(id, toolError('The call could not be completed. Nothing was looked up; this is not a "not found" answer.'));
    return rpcError(id, -32603, 'Internal error.');
  }
}

function serve() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', async (line) => {
    const text = line.trim();
    if (!text) return;
    let msg;
    try { msg = JSON.parse(text); } catch { process.stdout.write(JSON.stringify(rpcError(null, -32700, 'Parse error.')) + '\n'); return; }
    const resp = await handleMessage(msg);
    if (resp) process.stdout.write(JSON.stringify(resp) + '\n');
  });
  // Keep firmly quiet on stdout except JSON-RPC — stdio clients treat stray output as protocol noise.
  process.on('uncaughtException', (e) => { process.stderr.write(`eosl-mcp: ${e.message}\n`); });
}

// ---- selftest -----------------------------------------------------------------------------------
async function selftest() {
  let fail = 0;
  const ok = (c, m) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fail++; };
  const call = (id, name, args) => handleMessage({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

  const init = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  ok(init.result && init.result.serverInfo.name === 'eosl' && init.result.serverInfo.version === VERSION, 'initialize returns the server card');
  const list = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  ok(list.result && list.result.tools.length === 7, 'tools/list returns exactly 7 tools, with no network');
  ok(list.result && list.result.tools.every((t) => t.annotations && t.annotations.readOnlyHint === true && t.annotations.destructiveHint === false && t.title), 'every tool is titled and annotated read-only, as on the hosted server');
  const bad = await handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nope' } });
  ok(bad.error && bad.error.code === -32602, 'CONTROL: an unknown tool is a JSON-RPC error, not a crash');
  const note = await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
  ok(note === null, 'CONTROL: a notification gets no response');

  // The relay must say "could not look" when the hosted endpoint is unreachable, never "not found".
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  const down = await call(10, 'lookup_part', { part_number: 'WS-C3850-48P-S' });
  globalThis.fetch = async () => new Response('<html>bad gateway</html>', { status: 502 });
  const junk = await call(11, 'lookup_part', { part_number: 'WS-C3850-48P-S' });
  globalThis.fetch = realFetch;
  ok(down.result.isError && /Nothing was looked up/.test(down.result.content[0].text) && !/found": false/.test(down.result.content[0].text), 'an unreachable endpoint is an error result that says nothing was looked up');
  ok(junk.result.isError && /HTTP 502/.test(junk.result.content[0].text), 'a non-JSON answer is an error result naming the status');

  // Network-dependent: the hosted endpoint this server relays to.
  let hit = null;
  try { hit = await call(4, 'lookup_part', { part_number: 'WS-C3850-48P-S' }); } catch (e) { hit = null; }
  if (!hit || hit.result.isError) {
    console.log('  SKIP  network checks (the hosted endpoint was not reachable); the checks above are the offline core');
  } else {
    const text = hit.result.content[0].text;
    let hosted = null;
    try { hosted = await (await fetch(`${SITE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }) })).json(); } catch (e) { hosted = null; }
    const names = (l) => (l || []).map((t) => t.name + ':' + JSON.stringify(t.annotations || {})).sort().join('|');
    ok(hosted && hosted.result && names(hosted.result.tools) === names(TOOLS), 'the local tool list matches the hosted server\'s (names and annotations)');
    ok(/past end of service life/.test(text) && /cisco\.com/.test(text), 'lookup_part resolves a known part with its vendor bulletin');
    const miss = await call(5, 'lookup_part', { part_number: 'NOT-A-REAL-PART-999' });
    ok(/found": false/.test(miss.result.content[0].text), 'CONTROL: an invented part returns found:false, never a guess');
    const fam = await call(6, 'lookup_part', { part_number: '7010TX-48', vendor: 'Arista' });
    ok(/family-name/.test(fam.result.content[0].text) && /arista\.com/.test(fam.result.content[0].text), 'a model/family name resolves to the family record with its bulletin');
    const famWrongVendor = await call(7, 'lookup_part', { part_number: '7010TX-48', vendor: 'Cisco' });
    ok(/found": false/.test(famWrongVendor.result.content[0].text), 'CONTROL: the family fallback respects the vendor gate (Cisco + an Arista model = not found)');
    // The drift this version ends: a mixed family must answer "mixed", as the hosted server does.
    const mixed = await call(8, 'lookup_part', { part_number: 'Catalyst 3850' });
    ok(/mixed/.test(mixed.result.content[0].text), 'a family whose part numbers have different dates answers "mixed", not its earliest date');
    const over = await call(9, 'bulk_check', { part_numbers: Array.from({ length: 26 }, (_, i) => 'PART-' + i) });
    ok(over.result.isError && /25/.test(over.result.content[0].text), 'CONTROL: 26 part numbers are refused by the hosted limit and the refusal is passed through');
  }
  console.log(fail ? `\n${fail} FAILURE(S)` : '\nall selftests pass');
  process.exit(fail ? 1 : 0);
}

if (process.argv.includes('--selftest')) selftest();
else serve();
