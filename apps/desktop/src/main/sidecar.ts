import { access, constants } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { app } from "electron";
import { z } from "zod";
import {
  initializeResultSchema,
  protocolVersion,
  timerSnapshotSchema,
  type InitializeResult,
  type TimerSnapshot,
} from "../shared/contracts.js";

const maxLineSize = 64 * 1024;

const rpcErrorSchema = z
  .object({
    code: z.number().int(),
    message: z.string().min(1),
  })
  .strict();

const rpcResponseSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.number().int().nonnegative(),
    result: z.unknown().optional(),
    error: rpcErrorSchema.optional(),
  })
  .strict()
  .superRefine((response, context) => {
    if ((response.result === undefined) === (response.error === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "response must have exactly one result or error",
      });
    }
  });

const coreInitializeParamsSchema = z
  .object({
    protocolVersion: z.literal(protocolVersion),
    instanceId: z.string().uuid(),
    dataDirectory: z.string().min(1),
    locale: z.string().min(1),
    timeZone: z.string().min(1),
  })
  .strict();

type RpcResponse = z.infer<typeof rpcResponseSchema>;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

export class CoreUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoreUnavailableError";
  }
}

export class CoreSupervisor {
  private process: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestID = 1;
  private stdoutBuffer = "";
  private initialized: InitializeResult | undefined;
  private failure: Error | undefined;
  private stopping = false;

  async start(): Promise<InitializeResult> {
    if (this.initialized) {
      return this.initialized;
    }
    if (this.process) {
      throw new CoreUnavailableError("Timer core is starting.");
    }

    const executablePath = await this.resolveExecutablePath();
    this.process = spawn(executablePath, [], {
      cwd: app.getPath("userData"),
      shell: false,
      stdio: "pipe",
      windowsHide: true,
    });
    this.attachProcessHandlers(this.process);

    try {
      const result = await this.request("core.initialize", {
        protocolVersion,
        instanceId: randomUUID(),
        dataDirectory: app.getPath("userData"),
        locale: app.getLocale() || "en-US",
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      });
      this.initialized = initializeResultSchema.parse(result);
      return this.initialized;
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  async getSnapshot(): Promise<TimerSnapshot> {
    this.ensureAvailable();
    const result = await this.request("timer.getSnapshot", {});
    return z
      .object({ snapshot: timerSnapshotSchema })
      .strict()
      .parse(result).snapshot;
  }

  getInitializeResult(): InitializeResult {
    if (!this.initialized) {
      throw this.failure ?? new CoreUnavailableError("Timer core is unavailable.");
    }
    return this.initialized;
  }

  getFailure(): Error | undefined {
    return this.failure;
  }

  stop(): void {
    this.stopping = true;
    this.rejectPending(new CoreUnavailableError("Timer core stopped."));
    if (this.process && !this.process.killed) {
      this.process.kill();
    }
    this.process = undefined;
    this.initialized = undefined;
  }

  private async resolveExecutablePath(): Promise<string> {
    const executableName =
      process.platform === "win32" ? "pomodoro-core.exe" : "pomodoro-core";
    const path = app.isPackaged
      ? join(process.resourcesPath, "core", executableName)
      : join(__dirname, "../../resources", "core", executableName);

    try {
      await access(path, constants.X_OK);
    } catch {
      throw new CoreUnavailableError("Timer core executable is missing or not executable.");
    }
    return path;
  }

  private attachProcessHandlers(core: ChildProcessWithoutNullStreams): void {
    core.stdout.on("data", (chunk: Buffer) => {
      this.stdoutBuffer += chunk.toString("utf8");
      if (this.stdoutBuffer.length > maxLineSize) {
        this.fail(new CoreUnavailableError("Timer core sent an oversized protocol message."));
        return;
      }

      let newLineIndex = this.stdoutBuffer.indexOf("\n");
      while (newLineIndex >= 0) {
        const line = this.stdoutBuffer.slice(0, newLineIndex);
        this.stdoutBuffer = this.stdoutBuffer.slice(newLineIndex + 1);
        this.handleLine(line);
        newLineIndex = this.stdoutBuffer.indexOf("\n");
      }
    });
    core.stderr.on("data", () => {
      // Core stderr remains diagnostic-only and is intentionally not exposed to Renderer.
    });
    core.once("error", () => {
      this.fail(new CoreUnavailableError("Timer core could not be started."));
    });
    core.once("exit", () => {
      if (!this.stopping) {
        this.fail(new CoreUnavailableError("Timer core exited unexpectedly."));
      }
      this.process = undefined;
    });
  }

  private handleLine(line: string): void {
    try {
      const parsed: unknown = JSON.parse(line);
      const response = rpcResponseSchema.parse(parsed);
      this.handleResponse(response);
    } catch {
      this.fail(new CoreUnavailableError("Timer core sent an invalid protocol message."));
    }
  }

  private handleResponse(response: RpcResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) {
      this.fail(new CoreUnavailableError("Timer core returned an unknown request ID."));
      return;
    }
    this.pending.delete(response.id);
    if (response.error) {
      pending.reject(new CoreUnavailableError(response.error.message));
      return;
    }
    pending.resolve(response.result);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (!this.process?.stdin.writable) {
      return Promise.reject(
        this.failure ?? new CoreUnavailableError("Timer core is unavailable."),
      );
    }
    const id = this.nextRequestID++;
    const message = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params:
        method === "core.initialize"
          ? coreInitializeParamsSchema.parse(params)
          : z.object({}).strict().parse(params),
    });
    if (Buffer.byteLength(message, "utf8") + 1 > maxLineSize) {
      return Promise.reject(new CoreUnavailableError("Protocol request is too large."));
    }

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.process?.stdin.write(`${message}\n`, (error) => {
        if (error) {
          this.pending.delete(id);
          reject(new CoreUnavailableError("Timer core request failed."));
        }
      });
    });
  }

  private ensureAvailable(): void {
    if (!this.initialized) {
      throw this.failure ?? new CoreUnavailableError("Timer core is unavailable.");
    }
  }

  private fail(error: Error): void {
    if (this.failure) {
      return;
    }
    this.failure = error;
    this.initialized = undefined;
    this.rejectPending(error);
    if (this.process && !this.process.killed) {
      this.process.kill();
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
