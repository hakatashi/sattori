@echo off
rem Sets up the 32bit (x86) MSVC build environment.
rem Called via `call setup_vcvars.bat` from other build.bat scripts.
rem No-op if already run from an x86 Native Tools Command Prompt.

if defined VCINSTALLDIR goto :eof

set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
    echo [setup_vcvars] vswhere.exe not found. Run this from an x86 Native Tools Command Prompt for VS.
    exit /b 1
)

for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do (
    set "VSINSTALL=%%i"
)

if not defined VSINSTALL (
    echo [setup_vcvars] Visual Studio with C++ x86/x64 tools not found.
    exit /b 1
)

call "%VSINSTALL%\VC\Auxiliary\Build\vcvars32.bat" >nul
if errorlevel 1 (
    echo [setup_vcvars] vcvars32.bat failed.
    exit /b 1
)

goto :eof
