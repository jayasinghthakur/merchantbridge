#!/usr/bin/env python3
"""Call the MerchantBridge MCP server from Python with only the standard library.

Speaks Streamable HTTP JSON-RPC directly (no SDK), so it runs on any Python 3.9+:

    python3 examples/python/mcp_demo_client.py                     # local dev API
    MB_MCP_URL=https://<api>/mcp/demo python3 examples/python/mcp_demo_client.py
    MB_MCP_URL=https://<api>/mcp MB_API_KEY=mb_live_... python3 examples/python/mcp_demo_client.py

It lists the tools, looks up stock for a SKU and prints the envelope's data and meta. For an agent loop in Python,
use the Claude Agent SDK with an HTTP MCP server entry (see docs/integration.md); this script shows the wire.
"""

import json
import os
import sys
import urllib.error
import urllib.request

URL = os.environ.get("MB_MCP_URL", "http://localhost:8787/mcp/demo")
API_KEY = os.environ.get("MB_API_KEY")
SKU = os.environ.get("MB_SKU", "CHAI-250")


def rpc(method, params=None, request_id=1):
    body = {"jsonrpc": "2.0", "id": request_id, "method": method}
    if params is not None:
        body["params"] = params
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    if API_KEY:
        headers["Authorization"] = "Bearer " + API_KEY
    req = urllib.request.Request(URL, data=json.dumps(body).encode(), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            raw = res.read().decode()
            content_type = res.headers.get("Content-Type", "")
    except urllib.error.HTTPError as err:
        sys.exit("HTTP %d from %s: %s" % (err.code, URL, err.read().decode()[:300]))
    # The server answers with JSON, or with a single SSE `message` event carrying the JSON.
    if "text/event-stream" in content_type:
        data_lines = [line[5:].strip() for line in raw.splitlines() if line.startswith("data:")]
        raw = data_lines[-1] if data_lines else "{}"
    message = json.loads(raw)
    if "error" in message:
        sys.exit("JSON-RPC error: %s" % json.dumps(message["error"]))
    return message["result"]


def main():
    tools = rpc("tools/list")["tools"]
    print("%d tools at %s" % (len(tools), URL))
    for tool in tools:
        print("  - %s: %s" % (tool["name"], tool.get("title", "")))

    result = rpc("tools/call", {"name": "zoho_get_item", "arguments": {"sku": SKU}}, request_id=2)
    payload = result.get("structuredContent")
    if payload is None:  # clients may only get the text copy
        payload = json.loads(result["content"][0]["text"])
    if result.get("isError"):
        sys.exit("tool error: %s" % json.dumps(payload["error"]))

    item, meta = payload["data"], payload["meta"]
    rate = item["rate"]
    print("\n%s (%s): %s %.2f" % (item["name"], item["sku"], rate["currency"], rate["amount_minor"] / 100))
    for loc in item.get("locations") or []:
        print("  %-22s %4d available" % (loc["location_name"], loc["available_stock"]))
    print("as_of=%s demo=%s budget_remaining_today=%s" % (meta["as_of"], meta["demo"], meta["budget_remaining_today"]))


if __name__ == "__main__":
    main()
