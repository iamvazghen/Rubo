@echo off
setlocal
rem Rubo launcher. Lives on PATH so `rubo` works from any directory.
rem Override the checkout location with:  set RUBO_REPO=D:\path\to\rubo
if not defined RUBO_REPO set "RUBO_REPO=C:\Users\iamva\dexter"
if not defined RUBO_VPS  set "RUBO_VPS=openclaw@100.107.141.83"
rem The VPS still runs the pre-rename names (unit antoine-gateway, state ~/.antoine).
if not defined RUBO_VPS_HOME set "RUBO_VPS_HOME=~/.antoine"
if not defined RUBO_VPS_UNIT set "RUBO_VPS_UNIT=antoine-gateway"

if not exist "%RUBO_REPO%\package.json" (
  echo [rubo] No checkout at "%RUBO_REPO%".
  echo [rubo] Set RUBO_REPO to the repository path and try again.
  exit /b 1
)

rem Pin the state directory to the checkout so memory, portfolio, scores and
rem cron jobs are the same set no matter which directory you launch from.
if not defined RUBO_HOME set "RUBO_HOME=%RUBO_REPO%\.rubo"

pushd "%RUBO_REPO%"

if /i "%~1"=="gateway" (
  rem Telegram + scheduled reviews. Normally the VPS owns this; running it here
  rem too would make two processes poll the same bot token and fight over updates.
  shift
  call bun run gateway %1 %2 %3 %4 %5 %6 %7 %8 %9
  goto :done
)
if /i "%~1"=="health" (
  call bun run health
  goto :done
)
if /i "%~1"=="test" (
  call bun test
  goto :done
)
if /i "%~1"=="pull" (
  rem The VPS is authoritative: Telegram conversations and the scheduled reviews
  rem all write there. This copies its memory and score ledger down so the local
  rem CLI sees the same history instead of a second, diverging brain.
  echo [rubo] pulling memory, scores and sessions from %RUBO_VPS%
  scp -q "%RUBO_VPS%:%RUBO_VPS_HOME%/memory/MEMORY.md" "%RUBO_HOME%\memory\MEMORY.md"
  rem No trailing backslash before the closing quote - cmd treats it as an escape
  rem and scp receives a mangled destination path.
  scp -qr "%RUBO_VPS%:%RUBO_VPS_HOME%/scores" "%RUBO_HOME%"
  rem Telegram sessions live on the VPS; copy them so /resume telegram:... works here.
  if not exist "%RUBO_HOME%\sessions" mkdir "%RUBO_HOME%\sessions"
  scp -q "%RUBO_VPS%:%RUBO_VPS_HOME%/sessions/*_*.json" "%RUBO_HOME%\sessions" 2>nul || echo [rubo] no sessions on the VPS yet
  rem Holdings, income plan, tax profile and targets: the VPS sends the reminders, so it holds the truth.
  scp -q "%RUBO_VPS%:%RUBO_VPS_HOME%/portfolio.json" "%RUBO_HOME%" 2>nul
  scp -qr "%RUBO_VPS%:%RUBO_VPS_HOME%/income" "%RUBO_HOME%" 2>nul
  scp -qr "%RUBO_VPS%:%RUBO_VPS_HOME%/rebalance" "%RUBO_HOME%" 2>nul
  echo [rubo] done
  goto :done
)
if /i "%~1"=="push" (
  echo [rubo] pushing local memory and sessions to %RUBO_VPS%
  scp -q "%RUBO_HOME%\memory\MEMORY.md" "%RUBO_VPS%:%RUBO_VPS_HOME%/memory/MEMORY.md"
  rem CLI sessions, so Telegram can /resume cli:... - the copy pushed last wins.
  ssh %RUBO_VPS% "mkdir -p %RUBO_VPS_HOME%/sessions"
  for %%f in ("%RUBO_HOME%\sessions\*_*.json") do scp -q "%%f" "%RUBO_VPS%:%RUBO_VPS_HOME%/sessions/"
  rem Holdings and income settings changed here must reach the VPS for reminders.
  if exist "%RUBO_HOME%\portfolio.json" scp -q "%RUBO_HOME%\portfolio.json" "%RUBO_VPS%:%RUBO_VPS_HOME%/"
  if exist "%RUBO_HOME%\income" scp -qr "%RUBO_HOME%\income" "%RUBO_VPS%:%RUBO_VPS_HOME%/"
  if exist "%RUBO_HOME%ebalance" scp -qr "%RUBO_HOME%ebalance" "%RUBO_VPS%:%RUBO_VPS_HOME%/"
  echo [rubo] done - restart the gateway there if it should pick it up now
  goto :done
)
if /i "%~1"=="vps" (
  rem Service control on the box that actually runs 24/7.
  ssh %RUBO_VPS% "systemctl --user %2 %RUBO_VPS_UNIT%; systemctl --user is-active %RUBO_VPS_UNIT%"
  goto :done
)
if /i "%~1"=="logs" (
  ssh %RUBO_VPS% "tail -n 40 %RUBO_VPS_HOME%/gateway.log"
  goto :done
)

rem Node, not Bun: Bun on Windows never reports terminal resizes.
call node --import tsx src/index.tsx %*

:done
set "EXITCODE=%ERRORLEVEL%"
popd
exit /b %EXITCODE%
