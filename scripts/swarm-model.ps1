param(
    [Parameter(Position = 0)]
    [string]$Command = '',
    [string]$ConfigPath = '',
    [string]$OpenCodeConfigPath = ''
)

$DefaultSwarmConfigPath = Join-Path $env:USERPROFILE '.config\opencode\opencode-swarm.json'
$DefaultOpenCodeConfigPath = Join-Path $env:USERPROFILE '.config\opencode\opencode.json'
if (-not $ConfigPath) { $ConfigPath = $DefaultSwarmConfigPath }
if (-not $OpenCodeConfigPath) { $OpenCodeConfigPath = $DefaultOpenCodeConfigPath }

function Read-SwarmConfig {
    $path = $args[0]
    if (-not (Test-Path -LiteralPath $path)) {
        Write-Host "配置文件不存在: $path" -ForegroundColor Yellow
        Write-Host "正在创建新配置文件..." -ForegroundColor DarkGray
        $dir = Split-Path -Parent $path
        if (-not (Test-Path -LiteralPath $dir)) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
        }
        $initial = @{ agents = @{} }
        $initial | ConvertTo-Json | Set-Content -LiteralPath $path -NoNewline
        Write-Host "已创建: $path" -ForegroundColor Green
        $raw = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
        return ($raw | ConvertFrom-Json)
    }
    try {
        $raw = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
    } catch {
        $raw = Get-Content -LiteralPath $path -Raw
    }
    return ($raw | ConvertFrom-Json)
}

function Write-SwarmConfig {
    $cfg = $args[0]
    $path = $args[1]
    if (Test-Path -LiteralPath $path) {
        $backupPath = $path + '.bak'
        $timestamp = Get-Date -Format 'yyyyMMddHHmmss'
        if (Test-Path -LiteralPath $backupPath) {
            $backupPath = $path + '.' + $timestamp + '.bak'
            # Guarantee uniqueness for multiple writes within the same second.
            $n = 1
            while (Test-Path -LiteralPath $backupPath) {
                $backupPath = $path + '.' + $timestamp + '-' + $n + '.bak'
                $n++
            }
        }
        Copy-Item -LiteralPath $path -Destination $backupPath
        Write-Host "已备份原配置: $backupPath" -ForegroundColor DarkGray
    }
    # -Depth 10: PowerShell's ConvertTo-Json defaults to depth 2, which would
    # serialize nested agent fields (fallback_models, reasoning, thinking) as
    # type-name strings and silently corrupt them on write.
    $json = $cfg | ConvertTo-Json -Depth 10
    Set-Content -LiteralPath $path -Value $json -NoNewline
}

function Get-OpenCodeProviders {
    $path = $args[0]
    if (-not (Test-Path -LiteralPath $path)) {
        return @{}
    }
    try {
        $raw = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
        $config = $raw | ConvertFrom-Json
    } catch {
        return @{}
    }
    if (-not $config -or -not $config.provider) {
        return @{}
    }
    $providers = @{}
    foreach ($prop in $config.provider.PSObject.Properties) {
        $provName = $prop.Name
        $provData = $prop.Value
        if ($provData.models) {
            $models = @($provData.models.PSObject.Properties.Name | Sort-Object)
            $providers[$provName] = $models
        }
    }
    return $providers
}

function Split-ModelName {
    $name = $args[0]
    if ($name -match '/') {
        $idx = $name.LastIndexOf('/')
        return @{ Provider = $name.Substring(0, $idx); Model = $name.Substring($idx + 1) }
    }
    return @{ Provider = ''; Model = $name }
}

function Get-AllModels {
    $config = $args[0]
    $models = @{}
    foreach ($prop in $config.agents.PSObject.Properties) {
        $agent = $prop.Value
        if ($agent.model) {
            $parts = Split-ModelName $agent.model
            $key = $parts.Provider + '/' + $parts.Model
            if (-not $models.Contains($key)) { $models[$key] = $parts }
        }
        if ($agent.fallback_models) {
            foreach ($fb in $agent.fallback_models) {
                $parts = Split-ModelName $fb
                $key = $parts.Provider + '/' + $parts.Model
                if (-not $models.Contains($key)) { $models[$key] = $parts }
            }
        }
    }
    return $models
}

function Get-Providers {
    $allModels = $args[0]
    $providers = @{}
    foreach ($entry in $allModels.Values) {
        if ($entry.Provider -and -not $providers.ContainsKey($entry.Provider)) {
            $providers[$entry.Provider] = @()
        }
    }
    foreach ($entry in $allModels.Values) {
        if ($entry.Provider) {
            $providers[$entry.Provider] = $providers[$entry.Provider] + $entry.Model
        }
    }
    foreach ($key in @($providers.Keys)) {
        $providers[$key] = @($providers[$key] | Sort-Object -Unique)
    }
    return $providers
}

function Merge-ProviderModels {
    param(
        [object]$SwarmProviders,
        [object]$OpenCodeProviders
    )
    $merged = @{}
    foreach ($key in $SwarmProviders.Keys) {
        $merged[$key] = $SwarmProviders[$key]
    }
    foreach ($key in $OpenCodeProviders.Keys) {
        if ($merged.ContainsKey($key)) {
            $combined = @($merged[$key] + $OpenCodeProviders[$key])
            $merged[$key] = @($combined | Sort-Object -Unique)
        } else {
            $merged[$key] = $OpenCodeProviders[$key]
        }
    }
    return $merged
}

function Select-FromList {
    param([string]$Title, [array]$Labels, [array]$Values, [bool]$AllowQuit = $true)
    if ($AllowQuit) {
        $Labels = $Labels + '[quit/退出]'
        $Values = $Values + '__quit__'
    }
    Write-Host ""
    Write-Host $Title -ForegroundColor Cyan
    Write-Host ("-" * 60) -ForegroundColor DarkGray
    for ($i = 0; $i -lt $Labels.Count; $i++) {
        Write-Host ("  [{0}] {1}" -f ($i + 1), $Labels[$i])
    }
    Write-Host ""
    $idx = 0
    while ($true) {
        $inputVal = Read-Host "请选择 (1-$($Labels.Count))"
        $idx = 0
        if ([int]::TryParse($inputVal, [ref]$idx)) { $idx = $idx - 1 }
        if ($idx -ge 0 -and $idx -lt $Labels.Count) { break }
        Write-Host "请输入有效编号" -ForegroundColor Yellow
    }
    return $Values[$idx]
}

function Show-List {
    $config = $args[0]
    $agents = $config.agents.PSObject.Properties | Sort-Object Name
    Write-Host ""
    Write-Host "Swarm Agent 模型配置" -ForegroundColor Cyan
    Write-Host ("=" * 70) -ForegroundColor DarkGray
    Write-Host ("{0,-28} {1,-35} {2}" -f 'Agent', 'Model', 'Temp') -ForegroundColor White
    Write-Host ("-" * 70) -ForegroundColor DarkGray
    foreach ($prop in $agents) {
        $name = $prop.Name
        $agent = $prop.Value
        $temp = ''
        if ($null -ne $agent.temperature) { $temp = $agent.temperature.ToString() }
        Write-Host ("{0,-28} {1,-35} {2}" -f $name, $agent.model, $temp)
    }
    Write-Host ""
}

function Show-Help {
    Write-Host ""
    Write-Host "swarm-model.ps1 - Swarm Agent 模型配置工具" -ForegroundColor Cyan
    Write-Host ("=" * 50) -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "用法:"
    Write-Host "  .\scripts\swarm-model.ps1              交互式修改 agent 模型"
    Write-Host "  .\scripts\swarm-model.ps1 list         列出所有 agent 及模型"
    Write-Host "  .\scripts\swarm-model.ps1 help         显示帮助"
    Write-Host ""
    Write-Host "参数:"
    Write-Host "  -ConfigPath <路径>            指定 swarm 配置文件路径"
    Write-Host "  -OpenCodeConfigPath <路径>    指定 opencode 配置文件路径"
    Write-Host ""
    Write-Host "说明:"
    Write-Host "  脚本会从 opencode.json 读取所有可用 provider 和模型"
    Write-Host "  从 opencode-swarm.json 读取当前 agent 配置"
    Write-Host ""
}

function Run-Interactive {
    $running = $true
    while ($running) {
        $config = Read-SwarmConfig $ConfigPath
        $swarmModels = Get-AllModels $config
        $swarmProviders = Get-Providers $swarmModels
        $openCodeProviders = Get-OpenCodeProviders $OpenCodeConfigPath
        $allProviders = Merge-ProviderModels $swarmProviders $openCodeProviders
        $agentNames = @($config.agents.PSObject.Properties.Name | Sort-Object)
        if ($agentNames.Count -eq 0) {
            Write-Host "没有可配置的 agent" -ForegroundColor Red
            exit 1
        }

        # Show available providers info
        Write-Host ""
        Write-Host "=== Swarm Model 配置工具 ===" -ForegroundColor Cyan
        $provCount = $allProviders.Count
        Write-Host "检测到 $provCount 个 provider ($( ($allProviders.Keys -join ', ') ))" -ForegroundColor DarkGray

        # Step 1: Select agent
        $agentLabels = @()
        foreach ($name in $agentNames) {
            $agent = $config.agents.$name
            $agentLabels += "$name | $($agent.model) | temp=$($agent.temperature)"
        }
        $selectedAgent = Select-FromList -Title "Step 1: 选择要修改的 Agent" -Labels $agentLabels -Values $agentNames
        if ($selectedAgent -eq '__quit__') { break }
        $currentAgent = $config.agents.$selectedAgent
        $currentParts = Split-ModelName $currentAgent.model
        $currentProvider = $currentParts.Provider
        $currentModelName = $currentParts.Model
        Write-Host ""
        Write-Host "当前: $selectedAgent = $($currentAgent.model) (temp=$($currentAgent.temperature))" -ForegroundColor Green

        # Step 2: Select provider
        $providerNames = @($allProviders.Keys | Sort-Object)
        $providerLabels = @()
        foreach ($p in $providerNames) {
            $count = $allProviders[$p].Count
            $marker = ''
            if ($p -eq $currentProvider) { $marker = ' [当前]' }
            $providerLabels += "$p ($count 个模型)$marker"
        }
        $providerLabels += '[自定义 provider...]'
        $providerValues = $providerNames + '__custom__'
        $selectedProvider = Select-FromList -Title "Step 2: 选择 Provider (模型服务商)" -Labels $providerLabels -Values $providerValues
        if ($selectedProvider -eq '__quit__') { break }
        if ($selectedProvider -eq '__custom__') {
            $selectedProvider = ''
            while ($true) {
                $selectedProvider = Read-Host "输入 Provider 名称"
                if ([string]::IsNullOrWhiteSpace($selectedProvider)) {
                    Write-Host "Provider 名称不能为空" -ForegroundColor Red
                } else {
                    break
                }
            }
        }

        # Step 3: Select model
        $providerModels = @()
        if ($allProviders.ContainsKey($selectedProvider)) {
            $providerModels = $allProviders[$selectedProvider]
        }
        if ($providerModels.Count -eq 0) {
            $selectedModel = ''
            while ($true) {
                $selectedModel = Read-Host "该 Provider 下没有已有模型，输入模型名"
                if ([string]::IsNullOrWhiteSpace($selectedModel)) {
                    Write-Host "模型名称不能为空" -ForegroundColor Red
                } else {
                    break
                }
            }
        } else {
            $modelLabels = @()
            foreach ($m in $providerModels) {
                $marker = ''
                if ($m -eq $currentModelName -and $selectedProvider -eq $currentProvider) { $marker = ' [当前]' }
                $modelLabels += "$selectedProvider/$m$marker"
            }
            $modelLabels += '[自定义 model...]'
            $modelValues = $providerModels + '__custom__'
            $selectedModel = Select-FromList -Title "Step 3: 选择模型 ($selectedProvider)" -Labels $modelLabels -Values $modelValues
            if ($selectedModel -eq '__quit__') { break }
            if ($selectedModel -eq '__custom__') {
                $selectedModel = ''
                while ($true) {
                    $selectedModel = Read-Host "输入模型名称"
                    if ([string]::IsNullOrWhiteSpace($selectedModel)) {
                        Write-Host "模型名称不能为空" -ForegroundColor Red
                    } else {
                        break
                    }
                }
            }
        }
        if ($selectedProvider) {
            $fullModel = "$selectedProvider/$selectedModel"
        } else {
            $fullModel = $selectedModel
        }

        # Step 4: Temperature
        Write-Host ""
        Write-Host "Step 4: Temperature 设置" -ForegroundColor Cyan
        Write-Host "当前温度: $($currentAgent.temperature)" -ForegroundColor DarkGray
        $tempPrompt = '新温度值 (0.0-2.0, 回车保持当前值 [' + $currentAgent.temperature + '])'
        $tempInput = Read-Host $tempPrompt
        $newTemp = $currentAgent.temperature
        if ($tempInput -and $tempInput.Trim() -ne '') {
            $tempNum = 0
            if ([double]::TryParse($tempInput.Trim(), [ref]$tempNum)) {
                if ($tempNum -lt 0 -or $tempNum -gt 2) {
                    Write-Host "温度必须在 0.0 到 2.0 之间，保持当前值" -ForegroundColor Yellow
                } else {
                    $newTemp = $tempNum
                }
            } else {
                Write-Host "无效数值，保持当前值" -ForegroundColor Yellow
            }
        }

        # Step 5: Confirm
        Write-Host ""
        Write-Host "=== 确认变更 ===" -ForegroundColor Cyan
        Write-Host ("-" * 50) -ForegroundColor DarkGray
        Write-Host "  Agent:       $selectedAgent" -ForegroundColor White
        Write-Host "  Model:       $($currentAgent.model) -> $fullModel" -ForegroundColor White
        Write-Host "  Temperature: $($currentAgent.temperature) -> $newTemp" -ForegroundColor White
        Write-Host ""
        $confirm = Read-Host "确认修改? ([Y]/n)"
        if ($confirm -match '^[nN]') {
            Write-Host "已取消" -ForegroundColor Yellow
            continue
        }
        $config.agents.$selectedAgent.model = $fullModel
        $config.agents.$selectedAgent.temperature = $newTemp
        Write-SwarmConfig $config $ConfigPath
        Write-Host ""
        Write-Host "配置已更新!" -ForegroundColor Green
        Write-Host "  $selectedAgent = $fullModel (temp=$newTemp)" -ForegroundColor Green
        Write-Host "提示: 修改后需要重启 opencode/swarm 会话才能生效" -ForegroundColor Yellow
        Write-Host ""

        # Continue or quit
        $contLabel = @('继续修改其他 agent', 'quit/退出')
        $contValue = @('continue', '__quit__')
        $choice = Select-FromList -Title "下一步" -Labels $contLabel -Values $contValue -AllowQuit $false
        if ($choice -eq '__quit__') {
            Write-Host "再见!" -ForegroundColor Cyan
            $running = $false
        }
    }
}

# ---------- Main dispatch ----------

if ($Command -eq 'list') {
    $config = Read-SwarmConfig $ConfigPath
    Show-List $config
} elseif ($Command -in 'help', '--help', '-h', '/?') {
    Show-Help
} else {
    Run-Interactive
}
