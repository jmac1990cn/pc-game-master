@echo off
rem PC Game Master 1.0.0 - push to GitHub (double-click to run)
rem Auto-locate git.exe if it is not in PATH
where git >nul 2>&1
if errorlevel 1 (
  if exist "C:\Program Files\Git\bin\git.exe" set "PATH=%PATH%;C:\Program Files\Git\bin"
  if exist "C:\Program Files (x86)\Git\bin\git.exe" set "PATH=%PATH%;C:\Program Files (x86)\Git\bin"
  if exist "C:\Program Files\Git\cmd\git.exe" set "PATH=%PATH%;C:\Program Files\Git\cmd"
  if exist "%LOCALAPPDATA%\Programs\Git\bin\git.exe" set "PATH=%PATH%;%LOCALAPPDATA%\Programs\Git\bin"
)
where git >nul 2>&1
if errorlevel 1 (
  echo ERROR: git not found.
  echo Install Git for Windows first: https://git-scm.com/download/win
  echo (choose default options so git is added to PATH)
  pause
  goto end
)
cd /d "%~dp0"
echo Configuring remote origin...
git remote get-url origin >nul 2>&1
if errorlevel 1 (
  git remote add origin https://github.com/jmac1990cn/pc-game-master.git
) else (
  git remote set-url origin https://github.com/jmac1990cn/pc-game-master.git
)
git branch -M main
echo Pushing main branch (enter GitHub username + PAT when prompted)...
git push -u origin main
if errorlevel 1 goto fail
git tag v1.0.0
git push origin v1.0.0
if errorlevel 1 goto fail
echo.
echo SUCCESS. Check releases at https://github.com/jmac1990cn/pc-game-master/releases
pause
goto end
:fail
echo.
echo PUSH FAILED. Make sure you used a PAT (not login password) and the repo exists.
pause
:end
