<#
  QRFolder 服务管理（Windows）。

  为什么需要它：直接 `node src/main.ts` 会在命令行窗口里前台运行 ——
  窗口得一直挂着，关掉窗口服务就没了，误点一下也一样。
  这里用 Start-Process -WindowStyle Hidden 把 Node 起成**没有窗口**的独立进程，
  启动脚本自己立刻退出。桌面上双击 start.bat 即可，不会留下任何窗口。

  用法（双击根目录的 start.bat / stop.bat 也可以）：
    powershell -ExecutionPolicy Bypass -File scripts\service.ps1 start
    powershell -ExecutionPolicy Bypass -File scripts\service.ps1 stop
    powershell -ExecutionPolicy Bypass -File scripts\service.ps1 restart
    powershell -ExecutionPolicy Bypass -File scripts\service.ps1 status

  进程身份靠 logs\qrfolder.pid 记录；PID 会被系统复用，所以每次都用
  「进程名是 node + 命令行含 main.ts」复核一遍才敢动手。
#>

[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('start', 'stop', 'restart', 'status')]
  [string]$Action = 'start'
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$ConfigPath = Join-Path $Root 'config\config.json'
$LogDir = Join-Path $Root 'logs'
$PidFile = Join-Path $LogDir 'qrfolder.pid'
$OutLog = Join-Path $LogDir 'service.out.log'
$ErrLog = Join-Path $LogDir 'service.err.log'

# ---------------------------------------------------------------- 配置

function Get-Settings {
  $settings = [ordered]@{
    Port = 8080
    Host = '127.0.0.1'
    AdminPath = '/admin'
    TlsEnabled = $false
    CaddyBinary = ''
    CaddyConfigPath = ''
    Domains = @()
  }
  if (-not (Test-Path $ConfigPath)) { return $settings }

  try {
    $cfg = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    Write-Host "配置文件解析失败（$ConfigPath），将按默认端口 8080 处理。" -ForegroundColor Yellow
    return $settings
  }

  if ($null -ne $cfg.system) {
    if ($null -ne $cfg.system.port) { $settings.Port = [int]$cfg.system.port }
    if (-not [string]::IsNullOrEmpty($cfg.system.host)) { $settings.Host = [string]$cfg.system.host }
    if (-not [string]::IsNullOrEmpty($cfg.system.adminPath)) { $settings.AdminPath = [string]$cfg.system.adminPath }

    $tls = $cfg.system.tls
    if ($null -ne $tls) {
      $settings.TlsEnabled = [bool]$tls.enabled
      if (-not [string]::IsNullOrEmpty($tls.caddyBinary)) { $settings.CaddyBinary = [string]$tls.caddyBinary }
      if (-not [string]::IsNullOrEmpty($tls.caddyConfigPath)) { $settings.CaddyConfigPath = [string]$tls.caddyConfigPath }
      if ($null -ne $tls.domains) { $settings.Domains = @($tls.domains) }
    }
  }
  return $settings
}

# ---------------------------------------------------------------- Caddy

$CaddyPidFile = Join-Path $LogDir 'caddy.pid'
$CaddyOutLog = Join-Path $LogDir 'caddy.out.log'
$CaddyErrLog = Join-Path $LogDir 'caddy.err.log'

<#
  解析 Caddy 可执行文件：先用配置里的路径，没有就找 PATH。
  找不到返回 $null —— 调用方负责给出可读的提示，而不是抛一个 .NET 异常。
#>
function Resolve-CaddyBinary([string]$Configured) {
  if (-not [string]::IsNullOrEmpty($Configured)) {
    if (Test-Path $Configured) { return $Configured }
    Write-Host "配置里的 Caddy 路径不存在：$Configured" -ForegroundColor Yellow
  }
  $found = Get-Command caddy -ErrorAction SilentlyContinue
  if ($null -ne $found) { return $found.Source }
  return $null
}

function Resolve-CaddyConfigPath([string]$Configured) {
  $relative = if ([string]::IsNullOrEmpty($Configured)) { 'caddy/Caddyfile' } else { $Configured }
  if ([System.IO.Path]::IsPathRooted($relative)) { return $relative }
  return (Join-Path $Root ($relative -replace '/', '\'))
}

function Get-CaddyProcess {
  if (-not (Test-Path $CaddyPidFile)) { return $null }
  $raw = Get-Content $CaddyPidFile -Raw -ErrorAction SilentlyContinue
  if ($null -eq $raw) { return $null }
  $procId = 0
  if (-not [int]::TryParse($raw.Trim(), [ref]$procId)) { return $null }

  $info = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue
  if ($null -eq $info) { return $null }
  # PID 会被复用，必须确认它确实是 caddy —— 否则可能误杀别人的进程
  if ($info.Name -ne 'caddy.exe') { return $null }
  return $info
}

function Start-Caddy($Settings) {
  if (-not $Settings.TlsEnabled) { return 0 }

  $running = Get-CaddyProcess
  if ($null -ne $running) {
    Write-Host "Caddy 已经在运行（PID $($running.ProcessId)）。" -ForegroundColor Yellow
    return 0
  }

  if ($Settings.Domains.Count -eq 0) {
    Write-Host '配置里启用了 HTTPS 但没有填域名，无法启动 Caddy。请到后台「域名与证书」页填写。' -ForegroundColor Red
    return 1
  }

  $binary = Resolve-CaddyBinary $Settings.CaddyBinary
  if ($null -eq $binary) {
    Write-Host '找不到 caddy 可执行文件。请在后台「域名与证书 → 进阶」里填写完整路径。' -ForegroundColor Red
    return 1
  }

  $caddyfile = Resolve-CaddyConfigPath $Settings.CaddyConfigPath
  if (-not (Test-Path $caddyfile)) {
    Write-Host "Caddyfile 还不存在：$caddyfile" -ForegroundColor Red
    Write-Host '请先在后台「域名与证书」页保存一次（保存会生成它）。'
    return 1
  }

  if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

  # 与 QRFolder 一样无窗口启动，否则会留一个黑框在桌面上
  $proc = Start-Process -FilePath $binary `
    -ArgumentList 'run', '--config', $caddyfile `
    -WorkingDirectory $Root `
    -WindowStyle Hidden `
    -RedirectStandardOutput $CaddyOutLog `
    -RedirectStandardError $CaddyErrLog `
    -PassThru

  Set-Content -Path $CaddyPidFile -Value $proc.Id -Encoding ASCII

  # Caddy 申请证书是异步的，这里只等它把 80/443 监听起来
  $listening = $false
  for ($i = 0; $i -lt 60; $i++) {
    if ((Test-PortBusy 80) -or (Test-PortBusy 443)) { $listening = $true; break }
    if ($null -eq (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 250
  }

  if ($listening) {
    Write-Host "Caddy 已启动（PID $($proc.Id)），正在为 $($Settings.Domains -join ', ') 申请/加载证书。" -ForegroundColor Green
    return 0
  }

  Write-Host 'Caddy 启动了但 80/443 还没进入监听，请看日志：' -ForegroundColor Red
  Write-Host "  $CaddyErrLog"
  Show-Tail $CaddyErrLog
  return 1
}

function Stop-Caddy {
  $target = Get-CaddyProcess
  if ($null -eq $target) {
    if (Test-Path $CaddyPidFile) { Remove-Item $CaddyPidFile -Force -ErrorAction SilentlyContinue }
    return 0
  }

  $procId = [int]$target.ProcessId
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & taskkill /PID $procId /T *> $null
  $ErrorActionPreference = $previous

  for ($i = 0; $i -lt 30; $i++) {
    if ($null -eq (Get-Process -Id $procId -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 100
  }
  if ($null -ne (Get-Process -Id $procId -ErrorAction SilentlyContinue)) {
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
  }

  Remove-Item $CaddyPidFile -Force -ErrorAction SilentlyContinue
  Write-Host "Caddy 已停止（PID $procId）。" -ForegroundColor Green
  return 0
}

# ---------------------------------------------------------------- 进程识别

function Get-ServiceProcess {
  if (-not (Test-Path $PidFile)) { return $null }

  $raw = (Get-Content $PidFile -Raw -ErrorAction SilentlyContinue)
  if ($null -eq $raw) { return $null }

  $procId = 0
  if (-not [int]::TryParse($raw.Trim(), [ref]$procId)) { return $null }
  return Get-VerifiedProcess $procId
}

<#
  按 PID 取进程，并确认它确实是 QRFolder。
  PID 会被系统回收再利用，只凭「PID 存在」就下手，早晚会误杀别人的进程。
#>
function Get-VerifiedProcess([int]$ProcId) {
  $info = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcId" -ErrorAction SilentlyContinue
  if ($null -eq $info) { return $null }
  if ($info.Name -ne 'node.exe') { return $null }
  if ($info.CommandLine -notmatch 'main\.ts') { return $null }
  return $info
}

function Get-PortListener([int]$Port) {
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($null -eq $conn) { return $null }
  return Get-CimInstance Win32_Process -Filter "ProcessId=$($conn.OwningProcess)" -ErrorAction SilentlyContinue
}

function Test-PortBusy([int]$Port) {
  return ($null -ne (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue))
}

function Wait-Port([int]$Port, [bool]$WantListening, [int]$TimeoutMs = 15000) {
  $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
  while ((Get-Date) -lt $deadline) {
    if ((Test-PortBusy $Port) -eq $WantListening) { return $true }
    Start-Sleep -Milliseconds 200
  }
  return $false
}

# ---------------------------------------------------------------- 动作

function Start-Fdqr {
  $settings = Get-Settings

  $running = Get-ServiceProcess
  if ($null -ne $running) {
    Write-Host "QRFolder 已经在运行了（PID $($running.ProcessId)，端口 $($settings.Port)）。" -ForegroundColor Yellow
    Write-Host "要重启请用：scripts\service.ps1 restart"
    return 0
  }

  # 端口被别人占着的话，与其让 Node 报一句 EADDRINUSE 就退出，不如在这里说清楚是谁占的
  if (Test-PortBusy $settings.Port) {
    Write-Host "端口 $($settings.Port) 已被占用，QRFolder 无法启动。占用者：" -ForegroundColor Red
    Get-NetTCPConnection -LocalPort $settings.Port -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
      $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)" -ErrorAction SilentlyContinue
      $name = if ($null -eq $owner) { '(已退出)' } else { $owner.Name }
      Write-Host "  PID $($_.OwningProcess)  $name"
    }
    Write-Host "关掉它，或改 config\config.json 里的 system.port 后重试。"
    return 1
  }

  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($null -eq $node) {
    Write-Host 'PATH 里找不到 node。请先安装 Node.js 22.18 或更高版本。' -ForegroundColor Red
    return 1
  }

  if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

  # -WindowStyle Hidden：Node 起成没有控制台窗口的独立进程。
  # 不用 start /b —— 那样进程仍挂在同一个控制台上，窗口一关服务就跟着死。
  $proc = Start-Process -FilePath $node.Source `
    -ArgumentList 'src/main.ts' `
    -WorkingDirectory $Root `
    -WindowStyle Hidden `
    -RedirectStandardOutput $OutLog `
    -RedirectStandardError $ErrLog `
    -PassThru

  Set-Content -Path $PidFile -Value $proc.Id -Encoding ASCII

  if (Wait-Port $settings.Port $true) {
    Write-Host "QRFolder 已启动。PID $($proc.Id)，监听端口 $($settings.Port)。" -ForegroundColor Green
    Write-Host "后台地址：http://127.0.0.1:$($settings.Port)$($settings.AdminPath)"
    Write-Host "没有窗口驻留，可以放心关掉这个命令行。"
    return 0
  }

  Write-Host "启动后端口 $($settings.Port) 未在 15 秒内进入监听，请查看：" -ForegroundColor Red
  Write-Host "  $ErrLog"
  Show-Tail $ErrLog
  return 1
}

function Stop-Fdqr {
  $settings = Get-Settings

  $target = Get-ServiceProcess
  if ($null -eq $target) {
    # 没有 PID 文件也不代表没在跑（比如是手动 node src/main.ts 起的），
    # 再从端口反查一次，确认是 Node 跑的 QRFolder 才动手
    $listener = Get-PortListener $settings.Port
    if ($null -ne $listener -and $listener.Name -eq 'node.exe' -and $listener.CommandLine -match 'main\.ts') {
      $target = $listener
    }
  }

  if ($null -eq $target) {
    if (Test-Path $PidFile) { Remove-Item $PidFile -Force -ErrorAction SilentlyContinue }
    Write-Host 'QRFolder 没有在运行。' -ForegroundColor Yellow
    return 0
  }

  $procId = [int]$target.ProcessId

  # 先礼后兵：不带 /F 的 taskkill 是「请求关闭」，Node 能借机收尾
  # （关监听、flush 日志）。它不应答再强杀。
  # 临时把 $ErrorActionPreference 调回 Continue：PS 5.1 在 Stop 模式下
  # 会把原生命令写到 stderr 的内容当成终止性错误抛出。
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & taskkill /PID $procId /T *> $null
  $ErrorActionPreference = $previous

  for ($i = 0; $i -lt 20; $i++) {
    if ($null -eq (Get-Process -Id $procId -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 100
  }
  if ($null -ne (Get-Process -Id $procId -ErrorAction SilentlyContinue)) {
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
  }

  Wait-Port $settings.Port $false 5000 | Out-Null
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue

  Write-Host "QRFolder 已停止（PID $procId）。" -ForegroundColor Green
  return 0
}

function Show-Status {
  $settings = Get-Settings
  $running = Get-ServiceProcess
  if ($null -eq $running) { $running = Get-PortListener $settings.Port }

  if ($null -eq $running) {
    Write-Host '状态：未运行' -ForegroundColor Yellow
    Write-Host "  配置文件 $ConfigPath"
    return 0
  }

  $proc = Get-Process -Id $running.ProcessId -ErrorAction SilentlyContinue
  $uptime = if ($null -ne $proc) { (Get-Date) - $proc.StartTime } else { $null }

  Write-Host '状态：运行中' -ForegroundColor Green
  Write-Host "  PID      $($running.ProcessId)"
  Write-Host "  端口     $($settings.Port)（监听中：$(if (Test-PortBusy $settings.Port) { '是' } else { '否' })）"
  if ($null -ne $uptime) {
    Write-Host "  已运行   $([int]$uptime.TotalHours) 小时 $($uptime.Minutes) 分"
  }
  Write-Host "  后台地址 http://127.0.0.1:$($settings.Port)$($settings.AdminPath)"
  Write-Host "  配置文件 $ConfigPath"
  Write-Host "  输出日志 $OutLog"
  return 0
}

function Show-CaddyStatus {
  $settings = Get-Settings
  if (-not $settings.TlsEnabled) {
    Write-Host 'TLS：未启用（Caddy 不参与）' -ForegroundColor DarkGray
    return
  }

  $running = Get-CaddyProcess
  if ($null -eq $running) {
    Write-Host 'Caddy：未运行' -ForegroundColor Yellow
  } else {
    $proc = Get-Process -Id $running.ProcessId -ErrorAction SilentlyContinue
    $uptime = if ($null -ne $proc) { (Get-Date) - $proc.StartTime } else { $null }
    Write-Host 'Caddy：运行中' -ForegroundColor Green
    Write-Host "  PID      $($running.ProcessId)"
    if ($null -ne $uptime) {
      Write-Host "  已运行   $([int]$uptime.TotalHours) 小时 $($uptime.Minutes) 分"
    }
  }

  Write-Host "  域名     $(if ($settings.Domains.Count -gt 0) { $settings.Domains -join ', ' } else { '(未填写)' })"
  Write-Host "  监听     $(if (Test-PortBusy 443) { '443 ✅' } else { '443 未监听' })  $(if (Test-PortBusy 80) { '80 ✅' } else { '80 未监听' })"
  Write-Host "  日志     $CaddyErrLog"
}

function Show-Tail([string]$Path, [int]$Lines = 15) {
  if (-not (Test-Path $Path)) { return }
  Write-Host "--- $Path 末尾 $Lines 行 ---" -ForegroundColor DarkGray
  Get-Content $Path -Tail $Lines -Encoding UTF8 -ErrorAction SilentlyContinue |
    ForEach-Object { Write-Host "  $_" }
}

# ---------------------------------------------------------------- 入口

$code = switch ($Action) {
  'start' {
    $r = Start-Fdqr
    # QRFolder 起来了才轮到 Caddy —— 反代的目标都不在，先起 Caddy 只会得到 502
    if ($r -eq 0) { $r = Start-Caddy (Get-Settings) }
    $r
  }
  'stop' {
    $r = Stop-Fdqr
    Stop-Caddy | Out-Null
    $r
  }
  'restart' {
    $r = Stop-Fdqr
    Stop-Caddy | Out-Null
    if ($r -eq 0) {
      Start-Sleep -Milliseconds 500
      $r = Start-Fdqr
    }
    if ($r -eq 0) { $r = Start-Caddy (Get-Settings) }
    $r
  }
  'status' {
    Show-Status
    Show-CaddyStatus
    0
  }
}
exit $code
