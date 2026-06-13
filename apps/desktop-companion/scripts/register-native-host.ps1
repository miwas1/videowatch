param(
  [Parameter(Mandatory = $true)]
  [string]$HostPath,

  [Parameter(Mandatory = $true)]
  [string]$ExtensionId
)

$resolved = Resolve-Path -LiteralPath $HostPath
$manifestDir = Join-Path $env:LOCALAPPDATA "DescribeOps"
$manifestPath = Join-Path $manifestDir "com.describeops.native.json"
New-Item -ItemType Directory -Path $manifestDir -Force | Out-Null

$manifest = @{
  name = "com.describeops.native"
  description = "DescribeOps native companion"
  path = $resolved.Path
  type = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
}

$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

$key = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.describeops.native"
New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name "(default)" -Value $manifestPath
Write-Host "Registered DescribeOps native host at $manifestPath"
