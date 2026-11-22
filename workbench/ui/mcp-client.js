"use strict";

function workbenchClient(endpoint = "/mcp", signal, reviewToken = () => undefined) {
  let sequence = 0;
  let ready;
  const version = "2025-11-25";
  async function send(method, params, notification = false, timeout = 4500) {
    const id = ++sequence;
    const deadline = AbortSignal.timeout(timeout);
    const response = await fetch(endpoint, {
      method: "POST", signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      headers: {"Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": version, ...(reviewToken() && {"X-Review-Token": reviewToken()})},
      body: JSON.stringify({jsonrpc: "2.0", ...(notification ? {} : {id}), method, params})
    });
    if (!response.ok) throw new Error("Local MCP returned HTTP " + response.status + ".");
    if (notification) return;
    const message = await response.json();
    if (message.jsonrpc !== "2.0" || message.id !== id || message.error) throw new Error(message.error?.message || "Unexpected MCP response.");
    return message.result;
  }
  async function connect(timeout) {
    const info = await send("initialize", {protocolVersion: version, clientInfo: {name: "workbench-editor", version: "1"}, capabilities: {}}, false, timeout);
    if (!info.capabilities?.tools || info.protocolVersion !== version) throw new Error("Incompatible MCP service.");
    await send("notifications/initialized", {}, true, timeout);
    return (await send("tools/list", {}, false, timeout)).tools;
  }
  return async (name, args, {timeout = 4500} = {}) => {
    const connection = ready ||= connect(Math.min(timeout, 20000));
    let result;
    try {
      const tools = await connection;
      if (!tools.some(tool => tool.name === name)) throw new Error("Tool unavailable: " + name);
      result = await send("tools/call", {name, arguments: args}, false, timeout);
    } catch (error) {
      if (ready === connection) ready = null;
      throw error;
    }
    if (result.isError) throw new Error(result.content[0].text);
    return result.structuredContent;
  };
}
