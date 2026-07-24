param(
    [string]$Output = "$env:USERPROFILE\Desktop\mprotocol-rng-trace.jsonl"
)

$ws = [Net.WebSockets.ClientWebSocket]::new()
$uri = [Uri]"ws://127.0.0.1:43501/ws"
$ws.ConnectAsync($uri, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
$hello = '{"type":"hello","protocol":"1","subscribe":["match.random_seed","stage.btargets.remaining","frame","menu.major","player.1.entity.action_state","player.1.entity.action_frame","player.2.entity.action_state","player.2.entity.action_frame","player.3.entity.action_state","player.3.entity.action_frame","player.4.entity.action_state","player.4.entity.action_frame"]}'
$bytes = [Text.Encoding]::UTF8.GetBytes($hello)
$ws.SendAsync([ArraySegment[byte]]::new($bytes),
              [Net.WebSockets.WebSocketMessageType]::Text, $true,
              [Threading.CancellationToken]::None).GetAwaiter().GetResult()

$writer = [IO.StreamWriter]::new($Output, $false, [Text.UTF8Encoding]::new($false))
$writer.AutoFlush = $true
try {
    while ($ws.State -eq [Net.WebSockets.WebSocketState]::Open) {
        $buffer = New-Object byte[] 65536
        $segment = [ArraySegment[byte]]::new($buffer)
        $result = $ws.ReceiveAsync($segment,
            [Threading.CancellationToken]::None).GetAwaiter().GetResult()
        if ($result.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Close) { break }
        $message = [Text.Encoding]::UTF8.GetString($buffer, 0, $result.Count).Trim()
        if ($message) {
            $writer.WriteLine((Get-Date -Format o) + "\t" + $message)
        }
    }
}
finally {
    $writer.Dispose()
    $ws.Dispose()
}
