$ErrorActionPreference = 'Stop'
$credentials = Import-Clixml (Join-Path $PSScriptRoot 'daraja.credential.xml')
$urls = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'callback-urls.private.txt') | ConvertFrom-StringData
foreach ($key in @('ValidationURL','ConfirmationURL')) {
    $uri = [Uri]$urls.$key
    if ($uri.Scheme -ne 'https' -or $uri.Host -ne 'sacco-services.top') { throw 'Unexpected callback destination' }
}
$basic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($credentials.UserName + ':' + $credentials.GetNetworkCredential().Password))
try {
    $auth = Invoke-RestMethod -Method Get -Uri 'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials' -Headers @{Authorization="Basic $basic"} -TimeoutSec 30
    if (!$auth.access_token) { throw 'No access token returned' }
    $body = @{ShortCode='4166285';ResponseType='Completed';ConfirmationURL=$urls.ConfirmationURL;ValidationURL=$urls.ValidationURL} | ConvertTo-Json
    $result = Invoke-RestMethod -Method Post -Uri 'https://api.safaricom.co.ke/mpesa/c2b/v2/registerurl' -Headers @{Authorization="Bearer $($auth.access_token)"} -ContentType 'application/json' -Body $body -TimeoutSec 30
    $summary = $result | Select-Object OriginatorCoversationID,OriginatorConversationID,ConversationID,ResponseCode,ResponseDescription,errorCode,errorMessage
    $summary | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'registration-result.private.txt')
    $summary | Format-List
} catch {
    if ($_.ErrorDetails.Message) {
        try {
            $failure = $_.ErrorDetails.Message | ConvertFrom-Json
            $failure | Select-Object requestId,errorCode,errorMessage | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'registration-result.private.txt')
            $failure | Select-Object requestId,errorCode,errorMessage | Format-List
        } catch { Write-Output 'Provider response could not be parsed. No secrets printed.' }
    } else { Write-Output 'Registration request failed without a provider response; do not assume registration succeeded.' }
    exit 1
} finally { $basic = $null; $auth = $null; $credentials = $null }
