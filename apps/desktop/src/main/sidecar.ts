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
  type TimerCommand,
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

const timerCommandMethods: Record<TimerCommand, string> = {
  start: "timer.start",
  pause: "timer.pause",
  resume: "timer.resume",
  next: "timer.next",
  reset: "timer.reset",
};

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

// 领域：Electron / Sidecar
// 顺序：错误返回链：Go 或传输失败 -> CoreUnavailableError -> 拒绝 Promise -> Main IPC -> Renderer。
// 作用：表示 Go Core 未启动、已停止或协议失效时的统一错误。
// 原因：调用方只需处理一种可预期的可用性失败，而不用了解子进程细节。
// 边界：它描述 Core 通信状态，不包含或替代 Core 返回的业务错误。
export class CoreUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoreUnavailableError";
  }
}

// 领域：Electron / Sidecar
// 顺序：命令链第 4 站：Main IPC -> CoreSupervisor -> stdin -> Go 协议入口；响应反向返回。
// 作用：启动 Core、维护请求与响应的对应关系，并在协议或进程失败时统一关闭通道。
// 原因：主进程需要一个单一入口来保证 Renderer 永远不会直接访问子进程。
// 边界：只负责传输和启动握手；计时状态迁移与 SQLite 持久化仍属于 Go Core。
export class CoreSupervisor {
  private process: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestID = 1;
  private stdoutBuffer = "";
  private initialized: InitializeResult | undefined;
  private failure: Error | undefined;
  private stopping = false;

  // 领域：Electron / Sidecar 启动
  // 顺序：启动链第 2 站：Main -> start -> core.initialize -> Go Core -> SQLite -> 初始化结果。
  // 作用：启动可执行文件，并通过 core.initialize 完成版本和环境握手。
  // 原因：在发送计时命令前确认 Core 能打开本地数据目录且协议版本匹配。
  // 边界：初始化结果由 Core 提供；Main 不自行构造设置或计时快照。
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

  async command(command: TimerCommand): Promise<TimerSnapshot> {
    this.ensureAvailable();
    const result = await this.request(timerCommandMethods[command], {});
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

  // 领域：Electron / Sidecar 协议
  // 顺序：响应返回链第 2 站：Go stdout -> 按行拆包 -> handleResponse -> 等待中的 Main Promise。
  // 作用：读取 stdout 的换行分帧 JSON-RPC 响应并交给匹配的等待请求。
  // 原因：pipe 返回的数据块没有消息边界，一次 data 事件可能包含半行或多行。
  // 边界：stderr 仅保留给主进程诊断，绝不作为 Renderer 可见的协议或数据来源。
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
      // 领域：Electron / Sidecar 诊断
      // 顺序：诊断链：Go stderr -> Main 消费；不进入 IPC、Promise 或 Renderer。
      // 作用：消费 Core 的标准错误输出，避免 pipe 缓冲区阻塞子进程。
      // 原因：stderr 只用于本地诊断，不应成为 Renderer 的数据通道。
      // 边界：此处不向 UI 透露 stderr 内容，避免泄露内部实现或用户路径。
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

  // 领域：Electron / Sidecar 协议
  // 顺序：请求发送链第 4 站：CoreSupervisor -> 写入 stdin -> Go main -> protocol.ReadRequest。
  // 作用：把一个允许的方法编码为单行 JSON-RPC 请求，并等待同 ID 的响应。
  // 原因：严格校验参数和字节长度，使 Main 与 Core 共享明确、可拒绝的传输边界。
  // 边界：仅 core.initialize 接收初始化参数；其他当前方法只能接收空对象。
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

  // 领域：Electron / Sidecar 故障
  // 顺序：错误返回链：协议或进程失败 -> fail -> 拒绝等待请求 -> 调用方收到异常。
  // 作用：记录首次致命错误、拒绝所有等待请求并结束 Core 进程。
  // 原因：协议损坏后不能继续相信后续消息，继续发送命令会产生不确定的计时结果。
  // 边界：不重试可能已到达 Core 的命令；重启策略由更高层生命周期代码决定。
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
