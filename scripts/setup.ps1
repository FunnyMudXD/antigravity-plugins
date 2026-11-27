<#
.SYNOPSIS
    一键初始化 Antigravity 多插件仓库：安装依赖、构建前端产物并注册到全局 plugins.json。
.DESCRIPTION
    适用于在新设备克隆本仓库后快速启用所有插件。脚本会自动保留用户原有的 plugins.json 配置，仅在缺失时追加本仓库的 plugins 目录。
.PARAMETER SkipBuild
    跳过 codex-bridge 的 npm 依赖安装与 UI 构建步骤。
.PARAMETER SkipRegister
    跳过写入 ~/.gemini/config/plugins.json 的注册步骤。
#>
param(
    [switch]$SkipBuild,
    [switch]$SkipRegister
)

$ErrorActionPreference = "Stop"

# 计算仓库根目录与 plugins 目录的绝对路径
$repoRoot = Split-Path -Parent $PSScriptRoot
$pluginsDir = Join-Path $repoRoot "plugins"
$pluginsDirPosix = $pluginsDir -replace "\\", "/"

Write-Host "仓库根目录: $repoRoot" -ForegroundColor Cyan

# 1. 构建 codex-bridge 前端资源
if (-not $SkipBuild) {
    $codexDir = Join-Path $pluginsDir "codex-bridge"
    if (Test-Path (Join-Path $codexDir "package.json")) {
        if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
            throw "未检测到 npm，请先安装 Node.js 后重试，或使用 -SkipBuild 跳过前端构建。"
        }

        Write-Host "`n[1/2] 正在安装 codex-bridge 依赖并构建 UI..." -ForegroundColor Yellow
        Push-Location $codexDir
        try {
            if (Test-Path "package-lock.json") {
                npm ci
            } else {
                npm install
            }
            if ($LASTEXITCODE -ne 0) {
                throw "codex-bridge 依赖安装失败（退出码：$LASTEXITCODE）。"
            }

            npm run build:ui
            if ($LASTEXITCODE -ne 0) {
                throw "codex-bridge 前端构建失败（退出码：$LASTEXITCODE）。"
            }
        } finally {
            Pop-Location
        }
        Write-Host "codex-bridge 构建完成。" -ForegroundColor Green
    }
}

# 2. 注册到 ~/.gemini/config/plugins.json
if (-not $SkipRegister) {
    Write-Host "`n[2/2] 正在注册插件目录到 ~/.gemini/config/plugins.json..." -ForegroundColor Yellow
    $configDir = Join-Path $HOME ".gemini\config"
    $pluginsJsonPath = Join-Path $configDir "plugins.json"

    if (-not (Test-Path $configDir)) {
        New-Item -ItemType Directory -Force -Path $configDir | Out-Null
    }

    # 读取已有配置，避免覆盖用户原有的 entries 或 inherits（兼容空文件）
    $configObj = [PSCustomObject]@{}
    if (Test-Path $pluginsJsonPath) {
        $rawContent = Get-Content -Path $pluginsJsonPath -Raw -Encoding UTF8
        if (-not [string]::IsNullOrWhiteSpace($rawContent)) {
            $configObj = $rawContent | ConvertFrom-Json
        }
    }

    [System.Collections.ArrayList]$entriesList = @()
    if ($null -ne $configObj.entries) {
        foreach ($item in @($configObj.entries)) {
            [void]$entriesList.Add($item)
        }
    }

    # 统一斜杠与大小写进行去重判断
    $exists = $false
    foreach ($entry in $entriesList) {
        if ($null -eq $entry.path) { continue }
        $existingNormalized = ($entry.path -replace "\\", "/").TrimEnd("/")
        if ($existingNormalized.Equals($pluginsDirPosix.TrimEnd("/"), [System.StringComparison]::OrdinalIgnoreCase)) {
            $exists = $true
            break
        }
    }

    if (-not $exists) {
        [void]$entriesList.Add([PSCustomObject]@{ path = $pluginsDirPosix })
        # 显式转为 [object[]] 确保单元素时也始终序列化为 JSON 数组
        $entriesArray = [object[]]$entriesList.ToArray()
        if ($configObj.PSObject.Properties["entries"]) {
            $configObj.entries = $entriesArray
        } else {
            $configObj | Add-Member -MemberType NoteProperty -Name "entries" -Value $entriesArray
        }
        $jsonText = $configObj | ConvertTo-Json -Depth 10
        [System.IO.File]::WriteAllText($pluginsJsonPath, $jsonText + "`n", [System.Text.UTF8Encoding]::new($false))
        Write-Host "已将 $pluginsDirPosix 写入 $pluginsJsonPath" -ForegroundColor Green
    } else {
        Write-Host "plugins.json 中已存在该路径，无需重复添加。" -ForegroundColor Green
    }
}

Write-Host "`n初始化完成！Antigravity 会自动发现仓库中的插件。" -ForegroundColor Cyan
