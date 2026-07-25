"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { once } = require("node:events");
const { SidecarClient } = require("./sidecar-client.cjs");

const responsiveFixture = String.raw`
process.stdout.write(JSON.stringify({event:"ready",protocolVersion:1}) + "\n");
let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  pending += chunk;
  while (pending.includes("\n")) {
    const index = pending.indexOf("\n");
    const line = pending.slice(0, index);
    pending = pending.slice(index + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.method === "ping") {
      process.stdout.write(JSON.stringify({event:"catalogProgress",requestId:request.id,files:1}) + "\n");
      process.stdout.write(JSON.stringify({id:request.id,ok:true,result:{pong:true}}) + "\n");
    } else if (request.method === "shutdown") {
      process.stdout.write(JSON.stringify({id:request.id,ok:true,result:{shuttingDown:true}}) + "\n");
      process.exit(0);
    }
  }
});
`;

test("parses sidecar events and resolves matching responses", async () => {
  const client = await SidecarClient.start(process.execPath, ["-e", responsiveFixture]);
  const eventPromise = once(client, "sidecarEvent");
  const result = await client.request("ping", {});
  const [event] = await eventPromise;
  assert.deepEqual(result, { pong: true });
  assert.equal(event.event, "catalogProgress");
  await client.dispose();
});

test("terminates a sidecar that exceeds the response-line bound", async () => {
  const fixture = String.raw`
process.stdout.write(JSON.stringify({event:"ready",protocolVersion:1}) + "\n");
setTimeout(() => process.stdout.write("x".repeat(300) + "\n"), 10);
setInterval(() => {}, 1000);
`;
  const client = await SidecarClient.start(process.execPath, ["-e", fixture], {
    maxResponseLineBytes: 256
  });
  const [error] = await once(client, "sidecarFailure");
  assert.match(error.message, /response line exceeds/);
  assert.equal(client.closed, true);
});

test("sends an optional job ID with long-running requests", async () => {
  const fixture = String.raw`
process.stdout.write(JSON.stringify({event:"ready",protocolVersion:1}) + "\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  const request = JSON.parse(chunk);
  process.stdout.write(JSON.stringify({id:request.id,ok:true,result:{jobId:request.jobId}}) + "\n");
});
`;
  const client = await SidecarClient.start(process.execPath, ["-e", fixture]);
  assert.deepEqual(
    await client.request("scanCatalog", {}, { jobId: "job-123" }),
    { jobId: "job-123" }
  );
  await client.dispose();
});

test("cancels an in-flight sidecar request and terminates the child", async () => {
  const fixture = String.raw`
process.stdout.write(JSON.stringify({event:"ready",protocolVersion:1}) + "\n");
setInterval(() => {}, 1000);
`;
  const client = await SidecarClient.start(process.execPath, ["-e", fixture]);
  const pending = client.request("longOperation", {});
  const cancellation = client.cancel();
  await assert.rejects(pending, (error) => error.code === "operation_cancelled");
  await cancellation;
  assert.equal(client.closed, true);
});
