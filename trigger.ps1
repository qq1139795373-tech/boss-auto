$token = "ghp_你的token"
$repo = "qq1139795373-tech/boss-auto"
$workflow = "boss.yml"

$url = "https://api.github.com/repos/$repo/actions/workflows/$workflow/dispatches"
$headers = @{
    "Authorization" = "token $token"
    "Accept" = "application/vnd.github.v3+json"
}
$body = '{"ref":"master"}'

Invoke-RestMethod -Uri $url -Headers $headers -Method Post -Body $body
Write-Host "已触发boss workflow"
