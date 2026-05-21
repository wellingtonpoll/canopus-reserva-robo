# ============================================================================
# Canopus Reserva Robô — Instalador PowerShell
# ============================================================================
# Aplica política `ExtensionInstallForcelist` no Chrome para instalar a extensão
# automaticamente em até 1 minuto. Substitui o install.bat (que dependia de cmd).
#
# Uso:
#   1. Click direito → "Executar com PowerShell"
#      (PowerShell vai pedir UAC automaticamente — escolher Sim)
#   2. OU: PowerShell admin → cd Downloads → .\install.ps1
#
# Substituído pelo pack.sh antes da release.
# ============================================================================

# ─── Configuração (substituída pelo pack.sh) ────────────────────────────────
$ExtensionId = "EXTENSION_ID_PLACEHOLDER"
$UpdateUrl   = "https://github.com/wellingtonpoll/canopus-reserva-robo/releases/latest/download/update_manifest.xml"
$RegKey      = "HKLM:\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist"
$RegName     = "1"
$RegValue    = "$ExtensionId;$UpdateUrl"

# ─── Função pra desenhar banner ──────────────────────────────────────────────
function Show-Banner {
    Clear-Host
    Write-Host ""
    Write-Host "  ============================================================" -ForegroundColor Cyan
    Write-Host "            CANOPUS RESERVA ROBÔ - INSTALADOR" -ForegroundColor Yellow
    Write-Host "  ============================================================" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "   Extensão Chrome MV3 para monitoramento e reserva automática" -ForegroundColor White
    Write-Host "   de cotas no Portal Parceiros Canopus." -ForegroundColor White
    Write-Host ""
    Write-Host "  ------------------------------------------------------------" -ForegroundColor DarkGray
    Write-Host ""
}

# ─── Validar placeholder ─────────────────────────────────────────────────────
if ($ExtensionId -eq "EXTENSION_ID_PLACEHOLDER") {
    Show-Banner
    Write-Host "  [X] ERRO: instalador não foi compilado corretamente." -ForegroundColor Red
    Write-Host "      EXTENSION_ID ainda está com placeholder." -ForegroundColor Red
    Write-Host "      Contate o desenvolvedor." -ForegroundColor Red
    Write-Host ""
    Read-Host "Pressione Enter para fechar"
    exit 1
}

# ─── Auto-elevação ───────────────────────────────────────────────────────────
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$isAdmin = $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Show-Banner
    Write-Host "  [ Solicitando permissões de Administrador... ]" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  Uma janela do UAC vai aparecer. Clique em 'Sim' para continuar." -ForegroundColor White
    Write-Host ""
    Start-Sleep -Seconds 2

    try {
        # Relança como Admin
        Start-Process -FilePath "powershell.exe" `
            -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" `
            -Verb RunAs `
            -ErrorAction Stop
        exit 0
    } catch {
        Write-Host ""
        Write-Host "  [X] Você cancelou a elevação ou não tem permissão de Admin." -ForegroundColor Red
        Write-Host "      Click direito no install.ps1 → 'Executar com PowerShell'" -ForegroundColor White
        Write-Host "      e aceite o pedido de Administrador." -ForegroundColor White
        Write-Host ""
        Read-Host "Pressione Enter para fechar"
        exit 1
    }
}

# ─── A partir daqui rodando como Admin ───────────────────────────────────────
Show-Banner

Write-Host "  [1/4] Verificando ambiente..." -ForegroundColor Cyan
Write-Host ""

# Detectar Chrome instalado
$chromePaths = @(
    "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "${env:LocalAppData}\Google\Chrome\Application\chrome.exe"
)
$chromeFound = $chromePaths | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $chromeFound) {
    Write-Host "  [!] Google Chrome não encontrado nos caminhos padrão." -ForegroundColor Yellow
    Write-Host "      Você precisa instalar o Chrome antes (https://chrome.google.com)." -ForegroundColor White
    Write-Host ""
    Read-Host "Pressione Enter para fechar"
    exit 1
}

Write-Host "  [OK] Chrome encontrado em: $chromeFound" -ForegroundColor Green
Write-Host ""

# Detectar Chrome managed (GPO/Empresa)
$managedKey = "HKLM:\SOFTWARE\Policies\Google\Chrome"
if (Test-Path $managedKey) {
    $existingPolicies = (Get-Item $managedKey).Property
    if ($existingPolicies -and $existingPolicies.Count -gt 0) {
        Write-Host "  [!] Chrome já tem políticas configuradas (provavelmente sua empresa)." -ForegroundColor Yellow
        Write-Host "      Vou tentar adicionar a extensão sem conflitar." -ForegroundColor White
        Write-Host ""
    }
}

# ─── Limpar instalação anterior (se houver conflito) ──────────────────────────
Write-Host "  [2/4] Aplicando política de instalação..." -ForegroundColor Cyan
Write-Host ""

# Verificar se chave já existe e remover entrada antiga conflitante
if (Test-Path $RegKey) {
    $existing = Get-ItemProperty -Path $RegKey -ErrorAction SilentlyContinue
    if ($existing -and $existing.$RegName) {
        if ($existing.$RegName -notlike "$ExtensionId*") {
            Write-Host "      Removendo entrada antiga conflitante..." -ForegroundColor DarkGray
        }
    }
}

# Escrever política
try {
    if (-not (Test-Path $RegKey)) {
        New-Item -Path $RegKey -Force -ErrorAction Stop | Out-Null
    }
    Set-ItemProperty -Path $RegKey -Name $RegName -Value $RegValue -Type String -Force -ErrorAction Stop
    Write-Host "  [OK] Política aplicada." -ForegroundColor Green
} catch {
    Write-Host "  [X] ERRO ao escrever no registro do Windows:" -ForegroundColor Red
    Write-Host "      $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
    Write-Host "  Possíveis causas:" -ForegroundColor Yellow
    Write-Host "    1. PC corporativo com GPO bloqueando policies de usuário" -ForegroundColor White
    Write-Host "       → Verifique chrome://policy. Se mostrar 'Managed by your" -ForegroundColor White
    Write-Host "         organization', precisa pedir ao IT da empresa." -ForegroundColor White
    Write-Host ""
    Write-Host "    2. Antivírus bloqueando edição de policies do Chrome" -ForegroundColor White
    Write-Host "       → Desabilite temporariamente o antivírus e tente de novo." -ForegroundColor White
    Write-Host ""
    Write-Host "    3. Conta sem privilégio Admin real (UAC limitado)" -ForegroundColor White
    Write-Host "       → Tente em conta com privilégio Admin completo." -ForegroundColor White
    Write-Host ""
    Read-Host "Pressione Enter para fechar"
    exit 1
}

Write-Host ""
Write-Host "  [3/4] Verificando configuração..." -ForegroundColor Cyan
Write-Host ""

# Confirmar leitura
try {
    $saved = (Get-ItemProperty -Path $RegKey -Name $RegName -ErrorAction Stop).$RegName
    if ($saved -ne $RegValue) {
        throw "Valor lido não bate com escrito."
    }
    Write-Host "  [OK] Configuração confirmada." -ForegroundColor Green
    Write-Host "  [OK] Extension ID: $ExtensionId" -ForegroundColor Green
} catch {
    Write-Host "  [X] ERRO: política gravada mas não pode ser lida de volta." -ForegroundColor Red
    Read-Host "Pressione Enter para fechar"
    exit 1
}

Write-Host ""
Write-Host "  [4/4] Instalação concluída!" -ForegroundColor Green
Write-Host ""
Write-Host "  ------------------------------------------------------------" -ForegroundColor DarkGray
Write-Host ""
Write-Host "   PRÓXIMOS PASSOS:" -ForegroundColor Yellow
Write-Host "   1. Feche o Chrome se estiver aberto" -ForegroundColor White
Write-Host "   2. Abra o Chrome novamente" -ForegroundColor White
Write-Host "   3. A extensão será instalada automaticamente em até 1 min" -ForegroundColor White
Write-Host "   4. Procure pelo ícone do robô na barra de extensões" -ForegroundColor White
Write-Host ""
Write-Host "   Diagnóstico: chrome://policy → confirme que aparece" -ForegroundColor DarkGray
Write-Host "                ExtensionInstallForcelist com o ID acima." -ForegroundColor DarkGray
Write-Host ""
Write-Host "  ------------------------------------------------------------" -ForegroundColor DarkGray
Write-Host ""

$abrir = Read-Host "Deseja abrir o Chrome agora? (S/N)"
if ($abrir -match "^[Ss]") {
    Write-Host ""
    Write-Host "  Abrindo Chrome..." -ForegroundColor Cyan
    Start-Process -FilePath $chromeFound -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "  Instalação finalizada. Obrigado!" -ForegroundColor Green
Write-Host ""
Start-Sleep -Seconds 3
