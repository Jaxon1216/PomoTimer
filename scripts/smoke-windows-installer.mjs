import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, open, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

assert.equal(process.platform, "win32", "NSIS installer smoke tests require Windows.");
assert.ok(process.argv.length <= 3, "Usage: node scripts/smoke-windows-installer.mjs [installer-path]");
const execFileAsync = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(await readFile(join(root, "apps/desktop/package.json"), "utf8"));
const { version, build: { productName, nsis } } = manifest;
assert.equal(nsis.perMachine, false, "This smoke test installs only for the runner's current user.");
assert.equal(nsis.createDesktopShortcut, true);
assert.equal(nsis.createStartMenuShortcut, true);
const installerName = `Pomodot-${version}-windows-x64-setup.exe`;
const installerPath = resolve(process.argv[2] ?? join(root, "apps/desktop/dist", installerName));
assert.equal(basename(installerPath), installerName, "Test the exact current-version installer, never an older glob match.");
assert.ok((await stat(installerPath)).size > 1_000_000, "The NSIS installer must be complete.");
const installerFile = await open(installerPath, "r");
try {
  const header = Buffer.alloc(2);
  await installerFile.read(header, 0, 2, 0);
  assert.equal(header.toString(), "MZ", "The Windows installer must be a PE executable.");
} finally {
  await installerFile.close();
}

const temporary = await realpath(await mkdtemp(join(tmpdir(), "pomodot-nsis-smoke-")));
const installPath = join(temporary, "Installed Pomodoro Timer");
const executablePath = join(installPath, `${productName}.exe`);
const uninstallerPath = join(installPath, `Uninstall ${productName}.exe`);
const controller = new AbortController();
const interrupt = () => controller.abort(new Error("Windows installer smoke test interrupted."));
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
let installationAttempted = false;
let trackedRegistryPaths = [];
let failure;
let evidence;

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function inspectInstallation() {
  // Query known product entries only; the real uninstaller owns all registry and shortcut removal.
  const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$product = $env:POMODORO_INSTALLER_PRODUCT
$shell = New-Object -ComObject WScript.Shell
$roots = @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKCU:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')
$entries = @(foreach ($registryRoot in $roots) {
  if (Test-Path -LiteralPath $registryRoot) {
    foreach ($entry in Get-ChildItem -LiteralPath $registryRoot) {
      $item = Get-ItemProperty -LiteralPath $entry.PSPath -ErrorAction SilentlyContinue
      if ($item.DisplayName -and ($item.DisplayName -eq $product -or $item.DisplayName.StartsWith($product + ' '))) {
        $hive = if ($registryRoot.StartsWith('HKCU:')) { 'HKEY_CURRENT_USER' } else { 'HKEY_LOCAL_MACHINE' }
        $installRegistryPath = 'Registry::' + $hive + '\Software\' + $entry.PSChildName
        $install = Get-ItemProperty -LiteralPath $installRegistryPath -ErrorAction SilentlyContinue
        [pscustomobject]@{ path = $entry.Name; displayVersion = $item.DisplayVersion;
          uninstallString = $item.UninstallString; installRegistryPath = $installRegistryPath;
          installLocation = $install.InstallLocation }
      }
    }
  }
})
$shortcutDirectories = [ordered]@{
  desktop = [Environment]::GetFolderPath('DesktopDirectory')
  programs = [Environment]::GetFolderPath('Programs')
  commonDesktop = [Environment]::GetFolderPath('CommonDesktopDirectory')
  commonPrograms = [Environment]::GetFolderPath('CommonPrograms')
}
$shortcuts = @(foreach ($kind in $shortcutDirectories.Keys) {
  $directory = $shortcutDirectories[$kind]
  if ($directory) {
    $path = Join-Path $directory ($product + '.lnk')
    $present = Test-Path -LiteralPath $path
    $target = if ($present) { $shell.CreateShortcut($path).TargetPath } else { $null }
    [pscustomobject]@{ kind = $kind; path = $path; exists = [bool]$present; target = $target }
  }
})
$tracked = @($env:POMODORO_INSTALLER_REGISTRY_PATHS | ConvertFrom-Json)
$registry = @(foreach ($path in $tracked) {
  [pscustomobject]@{ path = $path; exists = [bool](Test-Path -LiteralPath $path) }
})
[pscustomobject]@{ entries = $entries; shortcuts = $shortcuts; registry = $registry } | ConvertTo-Json -Depth 6 -Compress
`;
  const { stdout } = await execFileAsync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    windowsHide: true,
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, POMODORO_INSTALLER_PRODUCT: productName,
      POMODORO_INSTALLER_REGISTRY_PATHS: JSON.stringify(trackedRegistryPaths) },
    encoding: "utf8",
  });
  return JSON.parse(stdout.replace(/^\uFEFF/, "").trim());
}

async function run(file, args, { nsisArguments = false, timeout = 120_000, cleanup = false } = {}) {
  if (!cleanup) controller.signal.throwIfAborted();
  if (nsisArguments) {
    assert.ok(!file.includes('"') && args.every((argument) => !argument.includes('"')), "NSIS arguments must not contain extra quotes.");
    assert.ok(args.at(-1).startsWith("/D=") || args.at(-1).startsWith("_?="), "NSIS installation directory must be the last raw parameter.");
  }
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(file, args, {
      cwd: root,
      env: { ...process.env, TEMP: temporary, TMP: temporary, POMODORO_SMOKE_EXECUTABLE: executablePath },
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true,
      windowsVerbatimArguments: nsisArguments,
      // Quote argv[0] ourselves because NSIS needs literal unquoted /D= and _?= tails.
      ...(nsisArguments ? { argv0: `"${file}"` } : {}),
    });
    let stopped;
    let forceTimer;
    let finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      controller.signal.removeEventListener("abort", abort);
      if (error) rejectRun(error);
      else resolveRun();
    };
    const stop = (reason) => {
      if (stopped || finished) return;
      stopped = reason;
      // Windows cannot deliver a graceful SIGTERM to Node; stop only this worker's tree.
      if (child.pid) {
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.once("error", (error) => {
          stopped = new AggregateError([stopped, error], "Could not terminate the installer smoke worker.");
          child.kill();
        });
      }
      forceTimer = setTimeout(() => finish(new Error(`Timed out waiting for ${basename(file)} to stop.`)), 15_000);
    };
    const abort = () => stop(controller.signal.reason);
    const timer = setTimeout(() => stop(new Error(`${basename(file)} timed out.`)), timeout);
    child.once("error", finish);
    child.once("close", (code, signal) => finish(stopped ?? (code === 0 ? undefined : new Error(`${basename(file)} exited with ${signal ?? code}.`))));
    if (!cleanup) {
      controller.signal.addEventListener("abort", abort, { once: true });
      if (controller.signal.aborted) abort();
    }
  });
}

try {
  const baseline = await inspectInstallation();
  assert.deepEqual(baseline.entries, [], "Refusing to replace an existing Pomodoro Timer installation.");
  assert.equal(baseline.shortcuts.some((shortcut) => shortcut.exists), false, "Refusing to overwrite an existing product shortcut.");
  installationAttempted = true;
  // NSIS requires /D= last and unquoted even for paths containing spaces:
  // https://nsis.sourceforge.io/Docs/Chapter3.html#installerusage
  await run(installerPath, ["/S", "/currentuser", `/D=${installPath}`], { nsisArguments: true });
  assert.equal(await exists(executablePath), true, "The final EXE must actually install its application.");
  assert.equal(await exists(uninstallerPath), true, "The installed application must include its uninstaller.");
  const installed = await inspectInstallation();
  assert.equal(installed.entries.length, 1, "The installer must register exactly one product entry.");
  const registration = installed.entries[0];
  assert.equal(registration.displayVersion, version);
  assert.equal(registration.installLocation?.toLowerCase(), installPath.toLowerCase());
  assert.ok(registration.path.startsWith("HKEY_CURRENT_USER\\"), "A per-user install must not require an administrator.");
  trackedRegistryPaths = [registration.installRegistryPath];
  for (const kind of ["desktop", "programs"]) {
    const shortcut = installed.shortcuts.find((entry) => entry.kind === kind);
    assert.equal(shortcut?.exists, true, `The ${kind} shortcut must be created.`);
    assert.equal(shortcut.target.toLowerCase(), executablePath.toLowerCase(), `The ${kind} shortcut must launch the installed executable.`);
  }
  await run(process.execPath, [join(root, "scripts/smoke-packaged.mjs")]);
  evidence = { kind: "windows-installer-smoke", installer: installerName, version,
    actualSilentInstall: true, installPathWithSpaces: true, currentUserRegistration: true,
    desktopAndStartMenuShortcuts: true, installedApplicationSmokePassed: true };
} catch (error) {
  failure = error;
} finally {
  if (installationAttempted) {
    try {
      if (await exists(uninstallerPath)) {
        // _?= keeps the uninstaller in this process so exit means registry/shortcut cleanup finished.
        await run(uninstallerPath, ["/S", "/currentuser", `_?=${installPath}`], { nsisArguments: true, cleanup: true });
      }
      const remaining = await inspectInstallation();
      assert.deepEqual(remaining.entries, [], "The real uninstaller must remove the product registration.");
      assert.equal(remaining.registry.some((entry) => entry.exists), false, "The real uninstaller must remove its installation registry key.");
      assert.equal(remaining.shortcuts.some((entry) => entry.exists), false, "The real uninstaller must remove product shortcuts.");
      assert.equal(await exists(executablePath), false, "The real uninstaller must remove the installed executable.");
    } catch (error) {
      failure = failure ? new AggregateError([failure, error], "Installer verification and uninstall cleanup failed.") : error;
    }
  }
  try {
    await rm(temporary, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
  } catch (error) {
    failure = failure ? new AggregateError([failure, error], "Windows installer temporary-directory cleanup failed.") : error;
  }
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
if (failure) throw failure;
controller.signal.throwIfAborted();
console.log(JSON.stringify({ ...evidence, uninstalled: true, registryAndShortcutsRemoved: true, cleanedUp: true }, null, 2));
