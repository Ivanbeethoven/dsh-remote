# Link this repository's skills into the DSH user skill root.
#
# The skill provider scans <dshHome>/skills by default and watches it, so linked skills
# appear in the next session without touching any profile config — and without risking
# the bundled skill directories that a `customSkillDirs` override would replace.
#
#   .\tools\install-skills.ps1
#   .\tools\install-skills.ps1 -Remove

param(
  [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$SkillsHome = (Join-Path $env:USERPROFILE '.dsh\skills'),
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$source = Join-Path $RepoRoot 'skills'

if (-not (Test-Path $source)) { throw "install-skills: no skills directory at $source" }

$names = Get-ChildItem $source -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'SKILL.md') } | Select-Object -ExpandProperty Name
if ($names.Count -eq 0) { throw "install-skills: no <name>/SKILL.md bundles under $source" }

New-Item -ItemType Directory -Force -Path $SkillsHome | Out-Null

foreach ($name in $names) {
  $link = Join-Path $SkillsHome $name
  if ($Remove) {
    if (Test-Path $link) { (Get-Item $link).Delete(); Write-Host "removed  $name" }
    continue
  }
  if (Test-Path $link) {
    Write-Host "present  $name  -> $((Get-Item $link).Target)"
    continue
  }
  New-Item -ItemType Junction -Path $link -Target (Join-Path $source $name) | Out-Null
  Write-Host "linked   $name  -> $(Join-Path $source $name)"
}

Write-Host ""
Write-Host "skills live in: $SkillsHome"
Write-Host "They appear in the next session's skill catalog. On Linux/macOS use: ln -s <repo>/skills/<name> ~/.dsh/skills/<name>"
