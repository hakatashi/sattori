// 汎用 DLL インジェクター (x86)
//
// CreateProcess(CREATE_SUSPENDED) でゲームを起動し、メインスレッドが
// 一切実行されないうちに WriteProcessMemory + CreateRemoteThread(LoadLibraryA)
// でフックDLLを注入、注入完了を確認してからメインスレッドを再開する。
//
// この順序により、フックDLLの DllMain (DLL_PROCESS_ATTACH) で行う IAT フックが
// ゲームの初期化コード (DirectInput8Create の呼び出し) より確実に先に完了する。
//
// 使い方: injector.exe <target.exe> <hook.dll>
//   ワーキングディレクトリは target.exe と同じフォルダに自動設定する
//   (ゲームがデータファイルを相対パスで探すため)。

#include <windows.h>
#include <cstdio>
#include <cstring>

static void GetDirName(const char* path, char* outDir, size_t outDirSize) {
    const char* lastSlash = strrchr(path, '\\');
    if (!lastSlash) lastSlash = strrchr(path, '/');
    if (!lastSlash) {
        _snprintf_s(outDir, outDirSize, _TRUNCATE, ".");
        return;
    }
    size_t len = (size_t)(lastSlash - path);
    if (len >= outDirSize) len = outDirSize - 1;
    memcpy(outDir, path, len);
    outDir[len] = '\0';
}

int main(int argc, char** argv) {
    if (argc < 3) {
        printf("Usage: injector.exe <target.exe> <hook.dll>\n");
        return 1;
    }

    char exeFull[MAX_PATH] = {0};
    char dllFull[MAX_PATH] = {0};
    if (!GetFullPathNameA(argv[1], MAX_PATH, exeFull, NULL)) {
        printf("Invalid target exe path: %s\n", argv[1]);
        return 1;
    }
    if (!GetFullPathNameA(argv[2], MAX_PATH, dllFull, NULL)) {
        printf("Invalid dll path: %s\n", argv[2]);
        return 1;
    }

    if (GetFileAttributesA(exeFull) == INVALID_FILE_ATTRIBUTES) {
        printf("Target exe not found: %s\n", exeFull);
        return 1;
    }
    if (GetFileAttributesA(dllFull) == INVALID_FILE_ATTRIBUTES) {
        printf("Hook DLL not found: %s\n", dllFull);
        return 1;
    }

    char workDir[MAX_PATH] = {0};
    GetDirName(exeFull, workDir, MAX_PATH);

    char cmdLine[MAX_PATH + 4] = {0};
    _snprintf_s(cmdLine, sizeof(cmdLine), _TRUNCATE, "\"%s\"", exeFull);

    STARTUPINFOA si;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    PROCESS_INFORMATION pi;
    ZeroMemory(&pi, sizeof(pi));

    printf("Launching (suspended): %s\n  workdir: %s\n", exeFull, workDir);
    if (!CreateProcessA(exeFull, cmdLine, NULL, NULL, FALSE, CREATE_SUSPENDED, NULL,
                         workDir, &si, &pi)) {
        printf("CreateProcess failed: %lu\n", GetLastError());
        return 1;
    }
    printf("Process created. PID=%lu\n", pi.dwProcessId);

    size_t dllPathLen = strlen(dllFull) + 1;
    LPVOID remoteMem =
        VirtualAllocEx(pi.hProcess, NULL, dllPathLen, MEM_COMMIT, PAGE_READWRITE);
    if (!remoteMem) {
        printf("VirtualAllocEx failed: %lu\n", GetLastError());
        TerminateProcess(pi.hProcess, 1);
        return 1;
    }

    if (!WriteProcessMemory(pi.hProcess, remoteMem, dllFull, dllPathLen, NULL)) {
        printf("WriteProcessMemory failed: %lu\n", GetLastError());
        TerminateProcess(pi.hProcess, 1);
        return 1;
    }

    HMODULE hKernel32 = GetModuleHandleA("kernel32.dll");
    LPTHREAD_START_ROUTINE loadLibAddr =
        (LPTHREAD_START_ROUTINE)GetProcAddress(hKernel32, "LoadLibraryA");

    HANDLE hRemoteThread =
        CreateRemoteThread(pi.hProcess, NULL, 0, loadLibAddr, remoteMem, 0, NULL);
    if (!hRemoteThread) {
        printf("CreateRemoteThread failed: %lu\n", GetLastError());
        TerminateProcess(pi.hProcess, 1);
        return 1;
    }

    WaitForSingleObject(hRemoteThread, 10000);
    DWORD exitCode = 0;
    GetExitCodeThread(hRemoteThread, &exitCode);
    CloseHandle(hRemoteThread);
    VirtualFreeEx(pi.hProcess, remoteMem, 0, MEM_RELEASE);

    if (exitCode == 0) {
        printf("DLL injection failed (LoadLibraryA returned NULL in target process)\n");
        TerminateProcess(pi.hProcess, 1);
        return 1;
    }
    printf("DLL injected. Module base in target = 0x%lx\n", exitCode);

    printf("Resuming main thread...\n");
    ResumeThread(pi.hThread);

    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    printf("Done.\n");
    return 0;
}
