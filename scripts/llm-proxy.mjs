#!/usr/bin/env node
// 本地 LLM CORS 代理（HTTPS 模式，供安全上下文里的 Codex 页面跨域调用 LLM 供应商）。
// 用法：node scripts/llm-proxy.mjs [端口]   默认 8443（HTTPS，自签证书 resources/cert/llm-proxy.crt）。
// 第一次需在钥匙串里信任证书，之后 Codex 页面 fetch https://127.0.0.1:8443/llm 才不被拦。
import https from "node:https";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.argv[2] || 8443);
const CERT_DIR = path.resolve(process.cwd(), "resources", "cert");
// 优先用 CA 签发的 server 证书（正规链，系统信任 CA 即可）；回退到旧的单张自签
const hasCaChain = fs.existsSync(path.join(CERT_DIR, "server.crt")) && fs.existsSync(path.join(CERT_DIR, "server.key"));
const cert = hasCaChain
  ? Buffer.concat([fs.readFileSync(path.join(CERT_DIR, "server.crt")), fs.readFileSync(path.join(CERT_DIR, "ca.crt"))])
  : fs.readFileSync(path.join(CERT_DIR, "llm-proxy.crt"));
const key = fs.readFileSync(path.join(CERT_DIR, hasCaChain ? "server.key" : "llm-proxy.key"));

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
  // Chrome Private Network Access：安全上下文访问 localhost 必须带这个头
  "Access-Control-Allow-Private-Network": "true",
};

const handler = (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }
  if (req.method === "POST" && req.url === "/llm") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      let cfg;
      try { cfg = JSON.parse(raw || "{}"); } catch {
        res.writeHead(400, CORS);
        return res.end(JSON.stringify({ error: "bad json" }));
      }
      const { provider, baseUrl, apiKey, model, body } = cfg;
      let target;
      const headers = { "Content-Type": "application/json" };
      if (provider === "anthropic") {
        target = (baseUrl || "https://api.anthropic.com/v1") + "/messages";
        headers["anthropic-version"] = "2023-06-01";
        headers["x-api-key"] = apiKey || "";
      } else if (provider === "dashscope") {
        target = baseUrl || "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
        headers["Authorization"] = "Bearer " + (apiKey || "");
      } else {
        target = (baseUrl ? baseUrl.replace(/\/$/, "") : "https://api.openai.com/v1") + "/chat/completions";
        headers["Authorization"] = "Bearer " + (apiKey || "");
      }
      try {
        const resp = await fetch(target, { method: "POST", headers, body: JSON.stringify(body || { model, messages: [] }) });
        const text = await resp.text();
        let parsed = {};
        try { parsed = JSON.parse(text); } catch { /* keep raw */ }
        res.writeHead(resp.status, { ...CORS, "Content-Type": "application/json" });
        return res.end(JSON.stringify({ upstream: parsed, raw: text, status: resp.status }));
      } catch (e) {
        res.writeHead(502, { ...CORS, "Content-Type": "application/json" });
        return res.end(JSON.stringify({ upstream: {}, error: String(e?.message || e) }));
      }
    });
    return;
  }
  res.writeHead(404, CORS);
  res.end("not found");
};

https.createServer({ key, cert }, handler).listen(PORT, "127.0.0.1", () => {
  console.log(`[llm-proxy] HTTPS CORS proxy on https://127.0.0.1:${PORT}/llm（证书链 resources/cert/server.crt + ca.crt）`);
});
