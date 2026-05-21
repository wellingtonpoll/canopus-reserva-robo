@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
title Canopus Reserva Robo - Instalador

REM ============================================================================
REM CONFIGURACAO — substituir EXTENSION_ID e UPDATE_URL antes de distribuir
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
    powershell -Command "Start-Process '%~f0' -Verb RunAs" >nul 2>&1
    if errorlevel 1 (
        echo.
        echo [X] Falha ao solicitar elevacao.
        echo     Clique com o botao direito no install.bat e escolha "Executar como administrador".
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
echo   Extensao Chrome para monitoramento e reserva automatica
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

echo  [1/3] Aplicando politica de instalacao forcada no Chrome...
echo.

REM ============================================================================
REM Escrever chave de registro
REM ============================================================================
reg add "%REG_KEY%" /v "%REG_NAME%" /t REG_SZ /d "%REG_VALUE%" /f >nul 2>&1
if errorlevel 1 (
    echo  [X] ERRO ao escrever no registro do Windows.
    echo      Detalhes: a chave HKLM nao pode ser modificada.
    echo      Verifique se o Chrome esta instalado e tente novamente.
    echo.
    pause
    exit /b 1
)

echo  [OK] Politica aplicada com sucesso.
echo.
echo  [2/3] Verificando configuracao...
echo.

REM Confirmar leitura
reg query "%REG_KEY%" /v "%REG_NAME%" >nul 2>&1
if errorlevel 1 (
    echo  [X] ERRO: chave foi gravada mas nao pode ser lida de volta.
    echo.
    pause
    exit /b 1
)

echo  [OK] Configuracao confirmada.
echo  [OK] Extension ID: %EXTENSION_ID%
echo.
echo  [3/3] Instalacao concluida!
echo.
echo  ------------------------------------------------------------
echo.
echo   PROXIMO PASSO:
echo   1. Abra o Google Chrome
echo   2. A extensao sera instalada automaticamente em ate 1 min
echo   3. Procure pelo icone do robo na barra de extensoes
echo.
echo  ------------------------------------------------------------
echo.

set /p "ABRIR=Deseja abrir o Chrome agora? (S/N): "
if /i "%ABRIR%"=="S" (
    echo.
    echo  Abrindo Chrome...
    start "" "chrome.exe" 2>nul
    if errorlevel 1 (
        REM Fallback: tentar caminhos padrao
        if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
            start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
        ) else if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" (
            start "" "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
        ) else (
            echo  [!] Chrome nao encontrado nos caminhos padrao.
            echo      Abra manualmente.
        )
    )
)

echo.
echo  Instalacao finalizada. Obrigado!
echo.
timeout /t 5 >nul
exit /b 0
