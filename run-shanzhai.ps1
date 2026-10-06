param([Parameter(Mandatory=$true)][int]$Idx)

$map = @{ 2='coldwind8'; 3='coldwind0'; 4='coldwind1'; 5='coldwind2' }
if (-not $map.ContainsKey($Idx)) { Write-Output "bad idx"; exit 1 }

$env:GAME_ACCOUNT = $map[$Idx]
$env:GAME_PASSWORD = 'a12345678'

cmd /c "node shanzhai.js > shanzhai-acc$Idx.log 2>&1"
Write-Output "acc$Idx done rc=$LASTEXITCODE"
