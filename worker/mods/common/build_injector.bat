@echo off
setlocal
call "%~dp0setup_vcvars.bat" || exit /b 1

set "OUTDIR=%~dp0build"
if not exist "%OUTDIR%" mkdir "%OUTDIR%"

cl.exe /nologo /EHsc /O2 /utf-8 /Fe:"%OUTDIR%\injector.exe" /Fo:"%OUTDIR%\\" "%~dp0injector.cpp"
if errorlevel 1 exit /b 1

echo Built %OUTDIR%\injector.exe
