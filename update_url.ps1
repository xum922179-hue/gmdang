# 探测本机局域网 IP，生成/更新「连接游戏.url」快捷方式
# 优先取「有默认网关且已启用」的网卡地址 —— 也就是真正连路由器的那个网口。
# 否则会误选 VMware/Hyper-V 虚拟网卡（如 192.168.x.1），朋友根本连不上。
$ip = (Get-NetIPConfiguration -ErrorAction SilentlyContinue |
  Where-Object { $_.IPv4DefaultGateway -ne $null -and $_.NetAdapter.Status -eq 'Up' } |
  ForEach-Object { $_.IPv4Address.IPAddress } |
  Where-Object { $_ -and $_ -notlike '169.254.*' } |
  Select-Object -First 1)
if (-not $ip) {
  # 无默认网关（如离线交换机）时退回到「第一个非回环 IPv4」，并排除虚拟网卡
  $ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object {
    $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and
    $_.InterfaceAlias -notlike '*VMware*' -and $_.InterfaceAlias -notlike '*Virtual*' -and
    $_.InterfaceAlias -notlike '*Loopback*' -and $_.InterfaceAlias -notlike '*WSL*'
  } | Select-Object -First 1).IPAddress
}
if (-not $ip) { Write-Host '未检测到局域网 IP，请检查网络连接。'; exit 1 }
$url = 'http://' + $ip + ':8080/multiplayer.html?server=ws://' + $ip + ':8080'
$content = "[InternetShortcut]`r`nURL=$url`r`n"
$path = Join-Path (Get-Location) '连接游戏.url'
[IO.File]::WriteAllText($path, $content, (New-Object Text.UTF8Encoding $false))
Write-Host ("已更新 连接游戏.url -> " + $url)