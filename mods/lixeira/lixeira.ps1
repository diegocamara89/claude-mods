# Manda arquivos e pastas para a Lixeira do Windows (dá para restaurar), em vez de apagar de vez.
# Uso: powershell -NoProfile -ExecutionPolicy Bypass -File lixeira.ps1 "caminho1" "caminho2" ...
Add-Type -AssemblyName Microsoft.VisualBasic
$falhas = 0
foreach ($p in $args) {
    $c = $p -replace '^/([a-zA-Z])/', '$1:/'
    if (-not (Test-Path -LiteralPath $c)) { Write-Output "não existe: $c"; continue }
    $abs = (Resolve-Path -LiteralPath $c).Path
    try {
        if (Test-Path -LiteralPath $abs -PathType Container) {
            [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($abs, 'OnlyErrorDialogs', 'SendToRecycleBin')
        } else {
            [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($abs, 'OnlyErrorDialogs', 'SendToRecycleBin')
        }
        Write-Output "na lixeira: $abs"
    } catch {
        Write-Output "falhou: $abs ($($_.Exception.Message))"
        $falhas++
    }
}
exit $falhas
