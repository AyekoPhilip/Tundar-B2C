$ErrorActionPreference = 'Stop'
$session = New-PSSession -ComputerName 'maishabora-ventures.com' -Port 55986 -UseSSL -Credential (Import-Clixml (Join-Path $PSScriptRoot 'winrm.credential.xml'))
try {
    Invoke-Command -Session $session -ScriptBlock {
        $ErrorActionPreference = 'Stop'
        $root = 'C:\Apps\TundeMpesa'
        if (Test-Path $root) { throw 'Application directory already exists; inspect before updating.' }
        New-Item -ItemType Directory -Path $root | Out-Null
        & icacls.exe $root /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-20:(OI)(CI)RX' | Out-Null
        if ($LASTEXITCODE) { throw 'ACL setup failed' }
        New-Item -ItemType Directory -Path "$root\data" | Out-Null
        & icacls.exe "$root\data" /grant '*S-1-5-20:(OI)(CI)M' | Out-Null
        if ($LASTEXITCODE) { throw 'Data ACL setup failed' }
    }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'src') -Destination 'C:\Apps\TundeMpesa\src' -Recurse -ToSession $session
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'package.json') -Destination 'C:\Apps\TundeMpesa\package.json' -ToSession $session
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'package-lock.json') -Destination 'C:\Apps\TundeMpesa\package-lock.json' -ToSession $session
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'node_modules') -Destination 'C:\Apps\TundeMpesa\node_modules' -Recurse -ToSession $session
    Invoke-Command -Session $session -ScriptBlock {
        $ErrorActionPreference = 'Stop'
        Import-Module WebAdministration
        $root = 'C:\Apps\TundeMpesa'
        $bytes = New-Object byte[] 32
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        $rng.GetBytes($bytes)
        $rng.Dispose()
        $token = -join ($bytes | ForEach-Object { $_.ToString('x2') })
        @('HOST=127.0.0.1','PORT=3087','DB_PATH=./data/callbacks.sqlite',"CALLBACK_TOKEN=$token",'MPESA_SHORTCODE=4166285','ACCEPT_ALL_REFERENCES=true','NAV_FORWARDING_ENABLED=false','NAV_URL=','NAV_USERNAME=Philip','NAV_PASSWORD=') | Set-Content -LiteralPath "$root\.env" -Encoding ASCII
        $action = New-ScheduledTaskAction -Execute 'C:\Program Files\nodejs\node.exe' -Argument '--env-file=.env src/server.js' -WorkingDirectory $root
        $trigger = New-ScheduledTaskTrigger -AtStartup
        $principal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\NETWORK SERVICE' -LogonType ServiceAccount
        $settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
        Register-ScheduledTask -TaskName 'TundeMpesaCallbacks' -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
        Start-ScheduledTask -TaskName 'TundeMpesaCallbacks'
        $healthy = $false
        for ($attempt = 0; $attempt -lt 10; $attempt++) {
            try { $result = Invoke-RestMethod 'http://127.0.0.1:3087/healthz'; if ($result.status -eq 'ok') { $healthy = $true; break } } catch { Start-Sleep -Seconds 1 }
        }
        if (!$healthy) { throw 'Listener failed health check; IIS has not been changed.' }
        $configPath = 'C:\Apps\UnisaPortal\iis-sacco-root\web.config'
        Copy-Item -LiteralPath $configPath -Destination "$root\iis-web.config.before"
        Backup-WebConfiguration -Name ('BeforeTundeMpesa-' + (Get-Date -Format yyyyMMddHHmmss))
        # Exclude token-bearing callback paths from IIS access logging.
        Set-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Location 'SaccoServices/payments/c2b' -Filter 'system.webServer/httpLogging' -Name dontLog -Value $true
        [xml]$config = Get-Content -LiteralPath $configPath
        $rule = $config.CreateElement('rule')
        $rule.SetAttribute('name','Tunde C2B callbacks')
        $rule.SetAttribute('stopProcessing','true')
        $match = $config.CreateElement('match')
        $match.SetAttribute('url','^payments/c2b/([a-zA-Z0-9_-]{32,128})/(validation|confirmation)$')
        $rule.AppendChild($match) | Out-Null
        $actionNode = $config.CreateElement('action')
        $actionNode.SetAttribute('type','Rewrite')
        $actionNode.SetAttribute('url','http://127.0.0.1:3087/mpesa/c2b/{R:1}/{R:2}')
        $actionNode.SetAttribute('appendQueryString','false')
        $rule.AppendChild($actionNode) | Out-Null
        $rules = $config.configuration.'system.webServer'.rewrite.rules
        $rules.InsertAfter($rule,$rules.rule[0]) | Out-Null
        $config.Save($configPath)
        @("ValidationURL=https://sacco-services.top/payments/c2b/$token/validation","ConfirmationURL=https://sacco-services.top/payments/c2b/$token/confirmation") | Set-Content -LiteralPath "$root\callback-urls.private.txt" -Encoding ASCII
        Write-Output 'Listener healthy; IIS routes installed; NAV forwarding disabled.'
    }
    Copy-Item -FromSession $session -LiteralPath 'C:\Apps\TundeMpesa\callback-urls.private.txt' -Destination (Join-Path $PSScriptRoot 'callback-urls.private.txt')
} finally { Remove-PSSession $session }
