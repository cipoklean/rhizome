// Vercel serverless proxy for Starknet JSON-RPC POSTs.
//
// Public Starknet RPCs (Lava, drpc, ...) block direct browser POSTs via CORS,
// which killed the app's raw-RPC calls in the deployed app. This endpoint
// forwards the request server-side, where CORS does not apply, and returns the
// node's JSON response with permissive CORS headers so the SPA can call it.
//
//   POST /api/simulate   { rpcUrl, method, params, id }
//     -> the RPC's JSON-RPC response, verbatim
//
// Only POST is accepted and the body shape is enforced — this is a narrow
// relay for our own simulate/block/nonce reads, not an open proxy.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

module.exports = async (req, res) => {
  // Browser CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { ...CORS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "POST only" }));
    return;
  }

  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    // Same guard the rest of the codebase uses against absurd payloads.
    if (body.length > 2 * 1024 * 1024) req.destroy();
  });
  req.on("end", async () => {
    try {
      const { rpcUrl, method, params, id } = JSON.parse(body);
      const paramsOk =
        Array.isArray(params)
        || (params !== null && typeof params === "object");
      if (
        typeof rpcUrl !== "string"
        || !/^https?:\/\//.test(rpcUrl)
        || typeof method !== "string"
        || method.length === 0
        || !paramsOk
      ) {
        res.writeHead(400, { ...CORS, "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "body must be { rpcUrl, method, params[], id }" }));
        return;
      }
      const upstream = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id: id ?? 1 }),
      });
      const text = await upstream.text();
      res.writeHead(upstream.status, { ...CORS, "Content-Type": "application/json" });
      res.end(text);
    } catch (e) {
      res.writeHead(502, { ...CORS, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(e?.message ?? e) }));
    }
  });
};
