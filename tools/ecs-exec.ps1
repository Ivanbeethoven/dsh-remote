# Run a shell script on the ECS instance through Cloud Assistant (no SSH needed).
#
#   .\tools\ecs-exec.ps1 -ScriptFile .\tools\recon.sh
#   "uname -a" | .\tools\ecs-exec.ps1
#
# Prints the remote stdout/stderr and exits non-zero when the command fails.

param(
  [string]$ScriptFile,
  [string]$Script,
  [string]$InstanceId = 'i-REPLACE_WITH_YOUR_INSTANCE_ID',
  [string]$RegionId = 'cn-heyuan',
  [int]$TimeoutSec = 120
)

$ErrorActionPreference = 'Stop'
$env:Path += ';C:\Users\HXY\AppData\Local\Microsoft\WinGet\Packages\Alibaba.AlibabaCloudCLI_Microsoft.Winget.Source_8wekyb3d8bbwe'

if ($ScriptFile) { $Script = Get-Content -Path $ScriptFile -Raw }
elseif (-not $Script -and $input) { $Script = ($input | Out-String) }
if (-not $Script) { throw 'ecs-exec: pass -ScriptFile, -Script, or pipe the script in.' }

$encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Script))

$created = (aliyun ecs RunCommand `
  --RegionId $RegionId `
  --InstanceId.1 $InstanceId `
  --Type RunShellScript `
  --ContentEncoding Base64 `
  --Timeout $TimeoutSec `
  --Name 'dsh-relay-exec' `
  --CommandContent $encoded | Out-String)

$invokeId = ($created | ConvertFrom-Json).InvokeId
if (-not $invokeId) { throw "ecs-exec: RunCommand did not return an InvokeId. Raw: $created" }

$deadline = (Get-Date).AddSeconds($TimeoutSec + 30)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 1500
  $poll = (aliyun ecs DescribeInvocationResults --RegionId $RegionId --InvokeId $invokeId | Out-String)
  $result = ($poll | ConvertFrom-Json).Invocation.InvocationResults.InvocationResult | Select-Object -First 1
  if (-not $result) { continue }
  if ($result.InvocationStatus -in @('Success', 'Failed', 'Timeout')) {
    if ($result.Output) {
      [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($result.Output))
    }
    if ($result.InvocationStatus -ne 'Success') {
      Write-Error "ecs-exec: $($result.InvocationStatus) (exit $($result.ExitCode))" -ErrorAction Continue
      exit 1
    }
    exit 0
  }
}
Write-Error 'ecs-exec: timed out waiting for the invocation result' -ErrorAction Continue
exit 1
