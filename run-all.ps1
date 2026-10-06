param([Parameter(Mandatory=$true)][int]$Idx)

$map = @{ 1='coldwind6'; 2='coldwind8'; 3='coldwind0'; 4='coldwind1'; 5='coldwind2' }
if (-not $map.ContainsKey($Idx)) { Write-Output "bad idx"; exit 1 }

$env:GAME_ACCOUNT = $map[$Idx]
$env:GAME_PASSWORD = 'a12345678'

Write-Output "=== acc$Idx ($($map[$Idx])) fish start $(Get-Date -Format 'HH:mm:ss') ==="
cmd /c "node fish.js > run-acc$Idx-fish.log 2>&1"
Write-Output "=== acc$Idx fish done $(Get-Date -Format 'HH:mm:ss') rc=$LASTEXITCODE ==="

Write-Output "=== acc$Idx dungeon start $(Get-Date -Format 'HH:mm:ss') ==="
cmd /c "node dungeon.js > run-acc$Idx-dungeon.log 2>&1"
Write-Output "=== acc$Idx dungeon done $(Get-Date -Format 'HH:mm:ss') rc=$LASTEXITCODE ==="
