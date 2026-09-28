@echo off
setlocal
rem Rubo launcher. Lives on PATH so `rubo` works from any directory.
rem Settings (user environment variables, e.g. setx RUBO_REPO D:\rubo):
rem   RUBO_REPO      the checkout; default: two levels above this script, if it is one
rem   RUBO_VPS       user@host running the gateway; needed only for pull/push/vps/logs
rem   RUBO_VPS_HOME  state directory there (default ~/.rubo)
rem   RUBO_VPS_UNIT  systemd user unit there (default rubo-gateway)
if not defined RUBO_REPO if exist "%~dp0..\..\src\index.tsx" set "RUBO_REPO=%~dp0..\.."
if not defined RUBO_VPS_HOME set "RUBO_VPS_HOME=~/.rubo"
if not defined RUBO_VPS_UNIT set "RUBO_VPS_UNIT=rubo-gateway"

if not exist "%RUBO_REPO%\src\index.tsx" (
  echo [rubo] No Rubo checkout found. Set RUBO_REPO to it, e.g.:  setx RUBO_REPO D:\rubo
  exit /b 1
)
set "NEEDS_VPS="
for %%c in (pull push vps logs) do if /i "%~1"=="%%c" set "NEEDS_VPS=1"
if defined NEEDS_VPS if not defined RUBO_VPS (
  echo [rubo] "%~1" talks to your server. Set RUBO_VPS first, e.g.:  setx RUBO_VPS user@your-server
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
  if exist "%RUBO_HOME%\rebalance" scp -qr "%RUBO_HOME%\rebalance" "%RUBO_VPS%:%RUBO_VPS_HOME%/"
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
