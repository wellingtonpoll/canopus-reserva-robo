@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
title Canopus Reserva Robo - Instalador

REM ============================================================================
REM CONFIGURACAO — substituida pelo pack.sh
REM ============================================================================
set "EXTENSION_ID=EXTENSION_ID_PLACEHOLDER"
set "UPDATE_URL=https://github.com/wellingtonpoll/canopus-reserva-robo/releases/latest/download/update_manifest.xml"
set "REG_KEY=HKLM\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist"
set "REG_NAME=1"
set "REG_VALUE=%EXTENSION_ID%;%UPDATE_URL%"

REM ============================================================================
REM Auto-elevacao — relanca como Admin se nao estiver
REM ============================================================================
net session >nul 2>&1
if %errorLevel% NEQ 0 (
    echo.
    echo [ Solicitando permissoes de Administrador... ]
    echo.
    echo Uma janela do UAC vai aparecer. Clique em "Sim" para continuar.
    echo.
    timeout /t 2 >nul
    powershell -NoProfile -Command "Start-Process '%~f0' -Verb RunAs" >nul 2>&1
    if errorlevel 1 (
        echo.
        echo [X] Falha ao solicitar elevacao via PowerShell.
        echo.
        echo SOLUCAO:
        echo   1. Click DIREITO neste arquivo install.bat
        echo   2. Escolha "Executar como administrador"
        echo   3. Confirme o UAC ^(Sim^)
        echo.
        pause
        exit /b 1
    )
    exit /b 0
)

REM ============================================================================
REM Banner
REM ============================================================================
cls
echo.
echo  ============================================================
echo            CANOPUS RESERVA ROBO - INSTALADOR
echo  ============================================================
echo.
echo   Extensao Chrome MV3 para monitoramento e reserva automatica
echo   de cotas no Portal Parceiros Canopus.
echo.
echo  ------------------------------------------------------------
echo.

REM Validar placeholder
if "%EXTENSION_ID%"=="EXTENSION_ID_PLACEHOLDER" (
    echo [X] ERRO: instalador nao foi compilado corretamente.
    echo     EXTENSION_ID ainda esta com placeholder.
    echo     Contate o desenvolvedor.
    echo.
    pause
    exit /b 1
)

echo  [1/4] Verificando ambiente...
echo.

REM Detectar Chrome
set "CHROME_FOUND="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME_FOUND=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME_FOUND=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "CHROME_FOUND=%LocalAppData%\Google\Chrome\Application\chrome.exe"

if "%CHROME_FOUND%"=="" (
    echo  [!] Google Chrome nao encontrado nos caminhos padrao.
    echo      Instale o Chrome antes ^(https://chrome.google.com^).
    echo.
    pause
    exit /b 1
)

echo  [OK] Chrome encontrado.
echo.
echo  [2/4] Aplicando politica de instalacao forcada...
echo.

REM Escrever chave
reg add "%REG_KEY%" /v "%REG_NAME%" /t REG_SZ /d "%REG_VALUE%" /f >nul 2>&1
if errorlevel 1 (
    echo  [X] ERRO ao escrever no registro do Windows.
    echo.
    echo  Possiveis causas:
    echo.
    echo    1. PC corporativo com GPO bloqueando policies de usuario.
    echo       =^> Verifique em chrome://policy. Se aparecer "Managed by
    echo          your organization", precisa pedir ao IT da empresa
    echo          para adicionar a extensao no force-list deles.
    echo.
    echo    2. Antivirus bloqueando edicao de policies do Chrome.
    echo       =^> Desabilite temporariamente o antivirus e tente de novo.
    echo.
    echo    3. Conta sem privilegio Admin real ^(UAC limitado^).
    echo       =^> Tente em conta com privilegio Admin completo.
    echo.
    pause
    exit /b 1
)

echo  [OK] Politica aplicada com sucesso.
echo.
echo  [3/4] Verificando configuracao...
echo.

REM Confirmar leitura
reg query "%REG_KEY%" /v "%REG_NAME%" >nul 2>&1
if errorlevel 1 (
    echo  [X] ERRO: chave gravada mas nao pode ser lida de volta.
    echo.
    pause
    exit /b 1
)

echo  [OK] Configuracao confirmada.
echo  [OK] Extension ID: %EXTENSION_ID%
echo.
echo  [4/4] Instalacao concluida!
echo.
echo  ------------------------------------------------------------
echo.
echo   PROXIMOS PASSOS:
echo   1. Feche o Chrome se estiver aberto
echo   2. Abra o Chrome novamente
echo   3. A extensao sera instalada automaticamente em ate 1 min
echo   4. Procure pelo icone do robo na barra de extensoes
echo.
echo   Diagnostico: chrome://policy =^> confirme ExtensionInstallForcelist
echo                com o ID acima.
echo.
echo  ------------------------------------------------------------
echo.

set /p "ABRIR=Deseja abrir o Chrome agora? (S/N): "
if /i "%ABRIR%"=="S" (
    echo.
    echo  Abrindo Chrome...
    start "" "%CHROME_FOUND%" 2>nul
)

echo.
echo  Instalacao finalizada. Obrigado!
echo.
timeout /t 5 >nul
exit /b 0
