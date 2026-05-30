#!/usr/bin/env node
"use strict";

var fs = require("fs");
var path = require("path");
var http = require("http");
var http2 = require("http2");
var crypto = require("crypto");

function loadEnv() {
  var envPath = path.resolve(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  var content = fs.readFileSync(envPath, "utf8");
  if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
  var lines = content.split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line || line[0] === "#") continue;
    var eq = line.indexOf("=");
    if (eq === -1) continue;
    var key = line.slice(0, eq).trim();
    var val = line.slice(eq + 1).trim();
    if (val[0] === '"' && val[val.length - 1] === '"') val = val.slice(1, -1);
    if (val[0] === "'" && val[val.length - 1] === "'") val = val.slice(1, -1);
    if (!process.env[key]) process.env[key] = val;
  }
}
loadEnv();

var PORT = parseInt(process.env.PROXY_PORT, 10) || 9999;
var TARGET_HOST = process.env.NVIDIA_NIM_HOST || "integrate.api.nvidia.com";
var TARGET_PORT = parseInt(process.env.NVIDIA_NIM_PORT, 10) || 443;
var UPSTREAM_TIMEOUT = parseInt(process.env.UPSTREAM_TIMEOUT, 10) || 180000;
var DEFAULT_API_KEY = process.env.NVIDIA_API_KEY || "";
var BIND_ADDRESS = process.env.BIND_ADDRESS || "127.0.0.1";
var VISION_MODEL = process.env.VISION_MODEL || "meta/llama-3.2-90b-vision-instruct";

var NUMERIC_ID_RE = /("id")\s*:\s*(\d+)/g;

function generateCallId() {
  return "call_" + crypto.randomUUID();
}

function getLastUserMessage(messages) {
  if (!messages || !Array.isArray(messages)) return "";
  for (var i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      var c = messages[i].content;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) {
        var textParts = [];
        for (var j = 0; j < c.length; j++) {
          if (c[j] && c[j].type === "text" && typeof c[j].text === "string") {
            textParts.push(c[j].text);
          }
        }
        return textParts.join(" ");
      }
      return "";
    }
  }
  return "";
}

function buildToolLookup(tools) {
  if (!tools || !Array.isArray(tools)) return null;
  var byName = {};
  var names = [];
  var paramSignatures = [];
  var noParamTools = [];
  for (var i = 0; i < tools.length; i++) {
    var tool = tools[i];
    if (!tool || !tool.function || !tool.function.name) continue;
    var name = tool.function.name;
    byName[name] = tool;
    names.push(name);
    var params = [];
    if (tool.function.parameters && tool.function.parameters.properties) {
      params = Object.keys(tool.function.parameters.properties).sort();
    }
    paramSignatures.push({
      name: name,
      params: params,
      paramSet: new Set(params),
      description: (tool.function.description || "").toLowerCase(),
    });
    if (params.length === 0) {
      noParamTools.push({
        name: name,
        description: (tool.function.description || "").toLowerCase(),
      });
    }
  }
  return {
    byName: byName,
    names: names,
    paramSignatures: paramSignatures,
    noParamTools: noParamTools,
  };
}

function inferFunctionName(argumentsStr, toolLookup, messages, toolChoice) {
  if (!toolLookup || !toolLookup.names || toolLookup.names.length === 0) return null;

  if (argumentsStr === "{}" && toolLookup.noParamTools.length > 0) {
    if (
      toolChoice &&
      typeof toolChoice === "object" &&
      toolChoice.function &&
      typeof toolChoice.function.name === "string"
    ) {
      var forced = toolChoice.function.name;
      if (toolLookup.byName[forced]) {
        console.error("[INFER] tool_choice forced -> " + forced);
        return forced;
      }
    }
    var lastUserMsg = getLastUserMessage(messages).toLowerCase();
    if (lastUserMsg) {
      for (var i = 0; i < toolLookup.noParamTools.length; i++) {
        var npName = toolLookup.noParamTools[i].name;
        var npLower = npName.toLowerCase();
        if (lastUserMsg.indexOf(npLower) !== -1) {
          console.error("[INFER] user message contains tool name -> " + npName);
          return npName;
        }
      }
      var bestTool = null;
      var bestScore = 0;
      var userWords = lastUserMsg
        .replace(/[^\w\s]/g, " ")
        .split(/\s+/)
        .filter(function (w) { return w.length > 2; });
      for (var i = 0; i < toolLookup.noParamTools.length; i++) {
        var t = toolLookup.noParamTools[i];
        var descWords = t.description
          .replace(/[^\w\s]/g, " ")
          .split(/\s+/)
          .filter(function (w) { return w.length > 2; });
        var score = 0;
        for (var u = 0; u < userWords.length; u++) {
          for (var d = 0; d < descWords.length; d++) {
            if (userWords[u] === descWords[d]) score += 2;
            else if (
              userWords[u].indexOf(descWords[d]) === 0 ||
              descWords[d].indexOf(userWords[u]) === 0
            )
              score += 1;
          }
        }
        var nameParts = t.name.split("_");
        for (var u = 0; u < userWords.length; u++) {
          for (var n = 0; n < nameParts.length; n++) {
            if (userWords[u] === nameParts[n]) score += 3;
            else if (
              userWords[u].indexOf(nameParts[n]) === 0 ||
              nameParts[n].indexOf(userWords[u]) === 0
            )
              score += 1;
          }
        }
        if (score > bestScore) {
          bestScore = score;
          bestTool = t.name;
        }
      }
      if (bestTool && bestScore >= 2) {
        console.error(
          "[INFER] keyword match from user message -> " + bestTool + " (score: " + bestScore + ")"
        );
        return bestTool;
      }
    }
    if (toolLookup.noParamTools.length === 1) {
      console.error("[INFER] only no-param tool -> " + toolLookup.noParamTools[0].name);
      return toolLookup.noParamTools[0].name;
    }
  }

  var argKeys = [];
  if (argumentsStr && argumentsStr !== "{}") {
    try {
      var parsed = JSON.parse(argumentsStr);
      if (parsed && typeof parsed === "object") {
        argKeys = Object.keys(parsed);
      }
    } catch (e) {
      var trimmed = argumentsStr.trim();
      if (trimmed.length > 1) {
        var m = trimmed.match(/^\{"/);
        if (m) {
          var keyMatches = trimmed.match(/"([a-zA-Z_][a-zA-Z0-9_]*)"\s*:/g);
          if (keyMatches) {
            argKeys = keyMatches.map(function (k) {
              return k.replace(/"/g, "").replace(/:$/, "");
            });
          }
        }
      }
    }
  }

  if (argKeys.length === 0) {
    if (toolLookup.names.length === 1) {
      return toolLookup.names[0];
    }
    if (argumentsStr) {
      for (var ni = 0; ni < toolLookup.names.length; ni++) {
        if (argumentsStr.indexOf(toolLookup.names[ni]) !== -1) {
          return toolLookup.names[ni];
        }
      }
    }
    return null;
  }

  var argKeySet = new Set(argKeys);
  var bestMatch = null;
  var bestScore = -1;
  for (var i = 0; i < toolLookup.paramSignatures.length; i++) {
    var sig = toolLookup.paramSignatures[i];
    var overlap = 0;
    var iter = argKeySet.values();
    var item;
    while (!(item = iter.next()).done) {
      if (sig.paramSet.has(item.value)) overlap++;
    }
    if (overlap > bestScore) {
      bestScore = overlap;
      bestMatch = sig.name;
    }
  }
  if (bestScore > 0) return bestMatch;
  return null;
}

function patchToolCalls(obj, toolCallIdMap, toolCallNameMap, toolLookup, messages, toolChoice) {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    for (var i = 0; i < obj.length; i++) {
      obj[i] = patchToolCalls(obj[i], toolCallIdMap, toolCallNameMap, toolLookup, messages, toolChoice);
    }
    return obj;
  }
  if (obj.tool_calls && Array.isArray(obj.tool_calls)) {
    for (var j = 0; j < obj.tool_calls.length; j++) {
      var tc = obj.tool_calls[j];
      if (!tc) continue;
      if (tc.id == null || typeof tc.id === "undefined") {
        var newId = generateCallId();
        console.error("[PATCH] missing id -> " + newId);
        tc.id = newId;
      } else if (typeof tc.id === "number") {
        var replacement = "call_" + tc.id;
        console.error("[PATCH] numeric id " + tc.id + " -> " + replacement);
        tc.id = replacement;
      }
        if (tc.function && typeof tc.function === "object") {
          if (tc.function.name == null || typeof tc.function.name === "undefined") {
            var knownName = toolCallNameMap && tc.index != null && toolCallNameMap.has(tc.index)
              ? toolCallNameMap.get(tc.index) : null;
            if (knownName) {
              tc.function.name = knownName;
            } else {
              var inferred = inferFunctionName(
                tc.function.arguments,
                toolLookup,
                messages,
                toolChoice
              );
              if (inferred) {
                console.error("[INFER] missing function.name -> " + inferred);
                tc.function.name = inferred;
              } else {
                console.error('[PATCH] missing function.name -> "unknown" (could not infer)');
                tc.function.name = "unknown";
              }
            }
          } else if (typeof tc.function.name === "number") {
          var nameStr = String(tc.function.name);
            console.error("[PATCH] numeric function.name " + tc.function.name + " -> " + nameStr);
            tc.function.name = nameStr;
          }
          if (toolCallNameMap && tc.index != null && typeof tc.function.name === "string" && tc.function.name.length > 0 && tc.function.name !== "unknown") {
            toolCallNameMap.set(tc.index, tc.function.name);
          }
      }
      if (toolCallIdMap && tc.index != null) {
        var idx = tc.index;
        var tcIdStr = typeof tc.id === "string" ? tc.id : "";
        if (toolCallIdMap.has(idx)) {
          var stableId = toolCallIdMap.get(idx);
          if (tcIdStr && tcIdStr !== stableId) {
            console.error(
              "[PATCH] stabilized id for index " + idx + ": " + tc.id + " -> " + stableId
            );
            tc.id = stableId;
          } else if (!tcIdStr) {
            tc.id = stableId;
          }
        } else if (tcIdStr.length > 0) {
          toolCallIdMap.set(idx, tcIdStr);
        }
      }
    }
  }
  for (var key in obj) {
    if (key !== "tool_calls" && Object.prototype.hasOwnProperty.call(obj, key)) {
      obj[key] = patchToolCalls(obj[key], toolCallIdMap, toolCallNameMap, toolLookup, messages, toolChoice);
    }
  }
  return obj;
}

function patchSseData(dataStr, toolCallIdMap, toolCallNameMap, toolLookup, messages, toolChoice) {
  if (!dataStr || dataStr.trim() === "[DONE]") return dataStr;
  try {
    var parsed = JSON.parse(dataStr);
    patchToolCalls(parsed, toolCallIdMap, toolCallNameMap, toolLookup, messages, toolChoice);
    return JSON.stringify(parsed);
  } catch (e) {
    var patched = dataStr.replace(NUMERIC_ID_RE, function (match, key, num) {
      var replacement = "call_" + num;
      console.error("[PATCH] regex numeric id " + num + " -> " + replacement);
      return key + ':"' + replacement + '"';
    });
    return patched;
  }
}

function patchNonStreamingBody(bodyStr, toolLookup, messages, toolChoice) {
  try {
    var parsed = JSON.parse(bodyStr);
    patchToolCalls(parsed, null, null, toolLookup, messages, toolChoice);
    return JSON.stringify(parsed);
  } catch (e) {
    return bodyStr;
  }
}

function detectVisionRequest(messages) {
  if (!messages || !Array.isArray(messages)) return false;
  for (var i = 0; i < messages.length; i++) {
    var content = messages[i].content;
    if (Array.isArray(content)) {
      for (var j = 0; j < content.length; j++) {
        if (content[j] && content[j].type === "image_url") return true;
      }
    }
  }
  return false;
}

function extractRequestContext(bodyBuf) {
  try {
    var parsed = JSON.parse(bodyBuf.toString("utf8"));
    var messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    return {
      tools: Array.isArray(parsed.tools) ? parsed.tools : [],
      messages: messages,
      toolChoice: parsed.tool_choice || null,
      isVisionRequest: detectVisionRequest(messages),
      model: parsed.model || null,
    };
  } catch (e) {
    return { tools: [], messages: [], toolChoice: null, isVisionRequest: false, model: null };
  }
}

function buildProxyHeaders(incomingHeaders) {
  var out = {};
  var skip = ["host", "connection", "content-length", "transfer-encoding"];
  for (var key in incomingHeaders) {
    if (!Object.prototype.hasOwnProperty.call(incomingHeaders, key)) continue;
    var lower = key.toLowerCase();
    if (skip.indexOf(lower) !== -1) continue;
    out[key] = incomingHeaders[key];
  }
  out["host"] = TARGET_HOST;
  if (DEFAULT_API_KEY) {
    var authKey = null;
    for (var k in out) {
      if (k.toLowerCase() === "authorization") {
        authKey = k;
        break;
      }
    }
    if (authKey !== null) {
      var oldVal = out[authKey];
      if (oldVal !== "Bearer " + DEFAULT_API_KEY) {
        delete out[authKey];
        out["authorization"] = "Bearer " + DEFAULT_API_KEY;
        console.error("[AUTH] replaced client Authorization header with default API key");
      }
    } else {
      out["authorization"] = "Bearer " + DEFAULT_API_KEY;
      console.error("[AUTH] injected default API key from env");
    }
  }
  return out;
}

function handleHealthCheck(req, res) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      status: "ok",
      proxy: "nvidia-glm-proxy",
      version: require("./package.json").version,
      upstream: TARGET_HOST + ":" + TARGET_PORT,
      port: PORT,
      visionModel: VISION_MODEL,
    })
  );
}

var h2Session = null;
var h2SessionBusy = false;
var h2SessionQueue = [];

function getH2Session(cb) {
  if (h2Session && !h2Session.destroyed && !h2Session.closed) {
    cb(null, h2Session);
    return;
  }
  h2SessionQueue.push(cb);
  if (h2SessionBusy) return;
  h2SessionBusy = true;
  var session = http2.connect("https://" + TARGET_HOST, {
    peerMaxConcurrentStreams: 100,
  });
  session.on("error", function (err) {
    console.error("[H2] session error: " + err.message);
    h2Session = null;
    h2SessionBusy = false;
    var queued = h2SessionQueue.splice(0);
    for (var i = 0; i < queued.length; i++) {
      queued[i](err, null);
    }
  });
  session.on("goaway", function () {
    console.error("[H2] goaway received, closing session");
    if (h2Session === session) h2Session = null;
    session.close();
  });
  session.on("close", function () {
    if (h2Session === session) h2Session = null;
    h2SessionBusy = false;
  });
  session.on("connect", function () {
    console.error("[H2] session established to " + TARGET_HOST);
    h2Session = session;
    h2SessionBusy = false;
    var queued = h2SessionQueue.splice(0);
    for (var i = 0; i < queued.length; i++) {
      queued[i](null, session);
    }
  });
}

function handleProxyRequest(req, res, bodyBuf) {
  var ctx = extractRequestContext(bodyBuf);
  var toolLookup = buildToolLookup(ctx.tools);
  var messages = ctx.messages;
  var toolChoice = ctx.toolChoice;

  if (ctx.isVisionRequest) {
    try {
      var bodyObj = JSON.parse(bodyBuf.toString("utf8"));
      bodyObj.model = VISION_MODEL;
      bodyBuf = Buffer.from(JSON.stringify(bodyObj), "utf8");
      console.error("[VISION] detected image_url -> routing to " + VISION_MODEL);
    } catch (e) {
      console.error("[VISION] failed to rewrite model: " + e.message);
    }
  }

  var proxyHeaders = buildProxyHeaders(req.headers);
  delete proxyHeaders["connection"];
  delete proxyHeaders["transfer-encoding"];
  proxyHeaders[http2.constants.HTTP2_HEADER_PATH] = req.url;
  proxyHeaders[http2.constants.HTTP2_HEADER_METHOD] = req.method;
  proxyHeaders[http2.constants.HTTP2_HEADER_AUTHORITY] = TARGET_HOST;
  proxyHeaders["content-length"] = bodyBuf.length;

  var timeoutId = setTimeout(function () {
    console.error("[ERROR] upstream timeout (" + UPSTREAM_TIMEOUT / 1000 + "s)");
    if (stream && !stream.destroyed) stream.destroy(new Error("upstream timeout"));
    if (!res.headersSent) {
      res.writeHead(504, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Gateway Timeout", message: "upstream timeout" }));
    }
  }, UPSTREAM_TIMEOUT);

  var stream = null;
  getH2Session(function (err, session) {
    if (err || !session) {
      clearTimeout(timeoutId);
      console.error("[ERROR] h2 session unavailable: " + (err ? err.message : "null"));
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Bad Gateway", message: err ? err.message : "h2 session unavailable" }));
      }
      return;
    }
    try {
      stream = session.request(proxyHeaders);
    } catch (e) {
      clearTimeout(timeoutId);
      console.error("[ERROR] h2 request failed: " + e.message);
      h2Session = null;
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Bad Gateway", message: e.message }));
      }
      return;
    }
    stream.on("response", function (headers) {
      clearTimeout(timeoutId);
      var status = headers[http2.constants.HTTP2_HEADER_STATUS] || 200;
      var contentType = (headers["content-type"] || "").toLowerCase();
      var isStreaming = contentType.indexOf("text/event-stream") !== -1;

      if (isStreaming) {
        var outHeaders = {
          "content-type": headers["content-type"] || "text/event-stream",
          "cache-control": headers["cache-control"] || "no-cache",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        };
        res.writeHead(status, outHeaders);
        var buffer = "";
      var toolCallIdMap = new Map();
      var toolCallNameMap = new Map();
      stream.on("data", function (chunk) {
        buffer += chunk.toString("utf8");
        var parts = buffer.split("\n\n");
        buffer = parts.pop();
        for (var i = 0; i < parts.length; i++) {
          var eventBlock = parts[i];
          if (!eventBlock) continue;
          var lines = eventBlock.split("\n");
          var patchedLines = [];
          for (var j = 0; j < lines.length; j++) {
            var line = lines[j];
            if (line.indexOf("data: ") === 0) {
              var dataPayload = line.slice(6);
              patchedLines.push(
                "data: " + patchSseData(dataPayload, toolCallIdMap, toolCallNameMap, toolLookup, messages, toolChoice)
              );
              } else {
                patchedLines.push(line);
              }
            }
            res.write(patchedLines.join("\n") + "\n\n");
          }
        });
        stream.on("end", function () {
          if (buffer.trim()) {
            var lines = buffer.split("\n");
            var patchedLines = [];
            for (var j = 0; j < lines.length; j++) {
              var line = lines[j];
              if (line.indexOf("data: ") === 0) {
                var dataPayload = line.slice(6);
                patchedLines.push(
                  "data: " + patchSseData(dataPayload, toolCallIdMap, toolCallNameMap, toolLookup, messages, toolChoice)
                );
              } else {
                patchedLines.push(line);
              }
            }
            res.write(patchedLines.join("\n") + "\n\n");
          }
          res.end();
        });
      } else {
        var bodyChunks = [];
        stream.on("data", function (chunk) {
          bodyChunks.push(chunk);
        });
        stream.on("end", function () {
          var bodyStr = Buffer.concat(bodyChunks).toString("utf8");
          var patched = patchNonStreamingBody(bodyStr, toolLookup, messages, toolChoice);
          var outHeaders = {};
          for (var k in headers) {
            if (
              k !== http2.constants.HTTP2_HEADER_STATUS &&
              Object.prototype.hasOwnProperty.call(headers, k)
            ) {
              outHeaders[k] = headers[k];
            }
          }
          outHeaders["content-length"] = Buffer.byteLength(patched);
          delete outHeaders["transfer-encoding"];
          res.writeHead(status, outHeaders);
          res.end(patched);
        });
      }
    });
    stream.on("error", function (err) {
      clearTimeout(timeoutId);
      console.error("[ERROR] h2 stream error: " + err.message);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Bad Gateway", message: err.message }));
      } else {
        res.end();
      }
    });
    stream.write(bodyBuf);
    stream.end();
  });
}

var server = http.createServer(function (req, res) {
  if (req.method === "GET" && req.url === "/health") {
    handleHealthCheck(req, res);
    return;
  }
  if (req.url.indexOf("/v1") !== 0) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found", path: req.url }));
    return;
  }
  var bodyChunks = [];
  req.on("data", function (chunk) {
    bodyChunks.push(chunk);
  });
  req.on("end", function () {
    var bodyBuf = Buffer.concat(bodyChunks);
    handleProxyRequest(req, res, bodyBuf);
  });
  req.on("error", function (err) {
    console.error("[ERROR] client request error: " + err.message);
    if (!res.headersSent) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Bad Request", message: err.message }));
    }
  });
});

server.listen(PORT, BIND_ADDRESS, function () {
  console.error("[nvidia-glm-proxy] Listening on http://" + BIND_ADDRESS + ":" + PORT);
  console.error("[nvidia-glm-proxy] Proxying to https://" + TARGET_HOST + " (HTTP/2)");
  console.error(
    "[nvidia-glm-proxy] Patches: numeric id, missing id, missing function.name (with inference), id stabilization"
  );
  console.error("[nvidia-glm-proxy] Upstream timeout: " + UPSTREAM_TIMEOUT / 1000 + "s");
  console.error("[nvidia-glm-proxy] Vision model: " + VISION_MODEL + " (auto-route on image_url)");
  if (DEFAULT_API_KEY) {
    console.error("[nvidia-glm-proxy] Default API key: loaded from env");
  } else {
    console.error("[nvidia-glm-proxy] Default API key: not set (client must provide Authorization header)");
  }
});
