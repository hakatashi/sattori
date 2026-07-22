@echo off
setlocal
call "%~dp0..\common\setup_vcvars.bat" || exit /b 1

set "OUTDIR=%~dp0build"
if not exist "%OUTDIR%" mkdir "%OUTDIR%"

cl.exe /nologo /LD /EHsc /O2 /utf-8 ^
    /Fe:"%OUTDIR%\th08_hook.dll" /Fo:"%OUTDIR%\\" ^
    "%~dp0dllmain.cpp" ^
    "%~dp0..\common\dinput_hook.cpp" ^
    "%~dp0..\common\window_wait.cpp" ^
    "%~dp0..\common\logging.cpp" ^
    "%~dp0..\common\fps_monitor.cpp" ^
    user32.lib
if errorlevel 1 exit /b 1

echo Built %OUTDIR%\th08_hook.dll
