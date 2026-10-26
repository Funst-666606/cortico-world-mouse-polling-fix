@echo off
setlocal
cd /d "%~dp0"
echo ============================================================
echo  Publish cortico-world-mouse-polling-fix as npm user funst
echo  Author: funst (QQ 2674459204)  License: MIT
echo ============================================================
echo.
echo Step 1/2: npm login (browser will open; sign in as funst)
call npm login --auth-type=web
if errorlevel 1 goto failed
echo.
echo Step 2/2: npm publish (enter the 6-digit OTP if asked)
call npm publish --access public
if errorlevel 1 goto failed
echo.
echo ============================================================
echo  Published. Tell the assistant "published" and it will open
echo  the [sync] issue for the Cortico extension market.
echo ============================================================
pause
exit /b 0

:failed
echo.
echo Publish did not finish. If npm asked for OTP, run this file again
echo and enter the current 6-digit code. If it asked for a token,
echo create a Granular token with Publish: Direct and Bypass 2FA.
pause
exit /b 1
