param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('v1', 'v2', 'v3', 'v4')]
  [string] $Tag,

  [Parameter(Mandatory = $true)]
  [ValidateSet(3001, 3002)]
  [int] $Port,

  [Parameter(Mandatory = $true)]
  [string] $DbPath
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not [System.IO.Path]::IsPathRooted($DbPath)) {
  throw 'DbPath must be an absolute path shared by both instances.'
}

$worktreeRoot = Join-Path $root 'data\worktrees'
$worktree = Join-Path $worktreeRoot $Tag
New-Item -ItemType Directory -Path $worktreeRoot -Force | Out-Null

if (Test-Path -LiteralPath $worktree) {
  $actualTag = (& git -C $worktree describe --tags --exact-match HEAD 2>$null)
  if ($LASTEXITCODE -ne 0 -or $actualTag.Trim() -ne $Tag) {
    throw "Existing worktree $worktree is not checked out at $Tag."
  }
} else {
  & git -C $root worktree add --detach $worktree $Tag
  if ($LASTEXITCODE -ne 0) { throw "Could not create worktree for $Tag." }
}

Write-Host "Starting $Tag on port $Port with shared database $DbPath"
Write-Host 'Stop this instance with Ctrl+C before replacing it with another tag.'
Push-Location $worktree
$oldDbPath = $env:DB_PATH
$oldPort = $env:PORT
try {
  $env:DB_PATH = $DbPath
  $env:PORT = [string] $Port
  & npm start
} finally {
  Pop-Location
  $env:DB_PATH = $oldDbPath
  $env:PORT = $oldPort
}
