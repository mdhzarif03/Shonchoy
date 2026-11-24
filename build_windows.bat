@echo off
REM ---------------------------------------------------------------
REM  Shonchoy - Windows build script
REM  Produces dist\Shonchoy.exe : a single portable file, no installer.
REM  Requires Python 3.9+ on PATH.
REM ---------------------------------------------------------------
setlocal
cd /d "%~dp0"

echo [1/3] Installing build tool (PyInstaller)...
python -m pip install --upgrade pyinstaller || goto :error

echo [2/3] Generating logo assets...
python tools\make_icon.py || goto :error

echo [3/3] Building Shonchoy.exe...
python -m PyInstaller --noconfirm --clean --onefile --windowed ^
  --name Shonchoy ^
  --icon assets\shonchoy.ico ^
  --add-data "assets;assets" ^
  run_shonchoy.py || goto :error

echo.
echo Build complete: dist\Shonchoy.exe
pause
exit /b 0

:error
echo.
echo Build failed. Check the messages above.
pause
exit /b 1
