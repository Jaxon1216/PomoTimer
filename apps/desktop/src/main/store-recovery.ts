import { constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const databaseFiles = ["pomodoro.sqlite", "pomodoro.sqlite-wal", "pomodoro.sqlite-shm"] as const;
const consumedRecoveries = new WeakSet<StoreRecoveryError>();

// StoreRecoveryError 携带已备份的本地恢复信息，交由 Main 决定是否重建。
//
// 领域：SQLite / 故障恢复
// 顺序：初始化错误链，SqliteStore -> 备份并关闭 -> Main 恢复对话框。
// 作用：区分已完成备份的故障与禁止重建的备份失败。
// 原因：主进程必须向用户展示保留数据的位置，再接受显式恢复选择。
// 边界：不进入 IPC，也不自动重建或清空任何数据库。
export class StoreRecoveryError extends Error {
  constructor(
    message: string,
    readonly dataDirectory: string,
    readonly backupDirectory: string | undefined,
    cause: unknown,
  ) {
    super(message, { cause });
    this.name = "StoreRecoveryError";
  }
}

function recoveryDirectory(dataDirectory: string, kind: "backup" | "archive"): string {
  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  return mkdtempSync(join(dataDirectory, `database-${kind}-${timestamp}-`));
}

// 领域：SQLite / 文件备份
// 顺序：初始化错误链，failInitialization -> backupDatabaseFiles -> close。
// 作用：在独立目录保留主文件以及当时存在的 WAL 和 SHM。
// 原因：关闭最后一个连接可能 checkpoint 并移除尚含提交数据的 WAL。
// 边界：同步复制失败即禁止重建；唯一目录和排他复制防止覆盖旧备份。
export function backupDatabaseFiles(dataDirectory: string): string {
  const directory = recoveryDirectory(dataDirectory, "backup");
  const files = databaseFiles.filter((file) => existsSync(join(dataDirectory, file)));
  if (!files.includes("pomodoro.sqlite")) throw new Error("未找到可备份的数据库，禁止重建");
  for (const file of files) {
    copyFileSync(join(dataDirectory, file), join(directory, file), constants.COPYFILE_EXCL);
  }
  writeFileSync(join(directory, "backup.json"), JSON.stringify({ capturedAt: new Date().toISOString(), files }, null, 2), { flag: "wx", mode: 0o600 });
  return directory;
}

// 领域：SQLite / 用户确认恢复
// 顺序：恢复选择链，Main 对话框 -> rebuildSqliteStore -> 归档 -> 新建。
// 作用：将原始文件移动到独立归档，腾出新的数据库路径。
// 原因：恢复应保留原文件，并且不能覆盖首次故障时的备份。
// 边界：仅供 Main 在用户显式选择重建后调用，每次恢复请求只能执行一次。
export function archiveDatabaseForRebuild(recovery: StoreRecoveryError): void {
  if (!recovery.backupDirectory || !statSync(join(recovery.backupDirectory, "pomodoro.sqlite")).isFile()) {
    throw new Error("数据库备份未完成，禁止重建");
  }
  if (consumedRecoveries.has(recovery)) throw new Error("该数据库恢复请求已经处理");
  const directory = recoveryDirectory(recovery.dataDirectory, "archive");
  const moved: string[] = [];
  try {
    for (const file of databaseFiles) {
      const original = join(recovery.dataDirectory, file);
      if (!existsSync(original)) continue;
      renameSync(original, join(directory, file));
      moved.push(file);
    }
  } catch (error) {
    for (const file of moved.reverse()) renameSync(join(directory, file), join(recovery.dataDirectory, file));
    throw error;
  }
  consumedRecoveries.add(recovery);
}
