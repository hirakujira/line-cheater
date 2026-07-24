"use strict";

const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_LINE_BYTES = 16 * 1024 * 1024;
const STDERR_TAIL_BYTES = 32 * 1024;

class SidecarClient extends EventEmitter {
  static async start(command, args, options) {
    const client = new SidecarClient(command, args, options);
    await client.ready;
    return client;
  }

  constructor(command, args, options) {
    super();
    options = options || {};
    this.maxResponseLineBytes = options.maxResponseLineBytes || MAX_RESPONSE_LINE_BYTES;
    this.pending = new Map();
    this.stdoutBuffer = Buffer.alloc(0);
    this.stderrTail = "";
    this.nextId = 1;
    this.closed = false;
    this.readySettled = false;
    this.child = (options.spawn || spawn)(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.readyTimer = setTimeout(() => {
      this.fail(new Error("Rust sidecar did not become ready within 30 seconds."));
    }, options.readyTimeoutMs || 30_000);
    this.child.stdout.on("data", (chunk) => this.consumeStdout(chunk));
    this.child.stderr.on("data", (chunk) => this.consumeStderr(chunk));
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", (code, signal) => {
      if (!this.closed) {
        const detail = this.stderrTail.trim();
        this.fail(new Error(
          `Rust sidecar exited unexpectedly (${code === null ? signal : code}).` +
          (detail ? ` ${detail}` : "")
        ));
      }
    });
  }

  request(method, params) {
    if (this.closed) return Promise.reject(new Error("Rust sidecar is closed."));
    const id = String(this.nextId++);
    const line = JSON.stringify({ id, method, params: params || {} }) + "\n";
    if (Buffer.byteLength(line) > MAX_REQUEST_BYTES) {
      return Promise.reject(new RangeError("Sidecar request exceeds 1 MiB."));
    }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(line, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  consumeStdout(chunk) {
    if (this.closed) return;
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    while (true) {
      const newline = this.stdoutBuffer.indexOf(0x0a);
      if (newline < 0) break;
      if (newline > this.maxResponseLineBytes) {
        this.fail(new Error("Rust sidecar response line exceeds the desktop limit."));
        return;
      }
      const line = this.stdoutBuffer.subarray(0, newline).toString("utf8").trim();
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (line) this.handleLine(line);
      if (this.closed) return;
    }
    if (this.stdoutBuffer.length > this.maxResponseLineBytes) {
      this.fail(new Error("Rust sidecar response line exceeds the desktop limit."));
    }
  }

  handleLine(line) {
    let value;
    try {
      value = JSON.parse(line);
    } catch (error) {
      this.fail(new Error(`Rust sidecar returned invalid JSON: ${error.message}`));
      return;
    }
    if (value && typeof value.event === "string") {
      if (value.event === "ready" && !this.readySettled) {
        this.readySettled = true;
        clearTimeout(this.readyTimer);
        this.resolveReady(value);
      }
      this.emit("sidecarEvent", value);
      return;
    }
    const pending = value && this.pending.get(String(value.id));
    if (!pending) return;
    this.pending.delete(String(value.id));
    if (value.ok) {
      pending.resolve(value.result);
    } else {
      const error = new Error(value.error && value.error.message || "Rust sidecar request failed.");
      error.code = value.error && value.error.code || "operation_failed";
      pending.reject(error);
    }
  }

  consumeStderr(chunk) {
    this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.readyTimer);
    if (!this.readySettled) {
      this.readySettled = true;
      this.rejectReady(error);
    }
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (!this.child.killed) this.child.kill();
    this.emit("sidecarFailure", error);
  }

  async dispose() {
    if (this.closed) return;
    try {
      await Promise.race([
        this.request("shutdown", {}),
        new Promise((_, reject) => setTimeout(
          () => reject(new Error("shutdown timeout")),
          2_000
        ))
      ]);
    } catch {
      // The process is terminated below if graceful shutdown is unavailable.
    }
    this.closed = true;
    clearTimeout(this.readyTimer);
    for (const pending of this.pending.values()) {
      pending.reject(new Error("Rust sidecar is closing."));
    }
    this.pending.clear();
    if (!this.child.killed) this.child.kill();
  }
}

module.exports = {
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_LINE_BYTES,
  SidecarClient
};
