#include "core/pe_iat.h"
#include <string.h>

namespace autoplay::iat {

namespace {

enum class DllMatch { Exact, Prefix };

// 一致したIATのスロットを fn に書き換える。byOrdinal なら序数、そうでなければ名前で探す。
bool HookImpl(HMODULE module, const char* dll, DllMatch dllMatch, const char* name, bool byOrdinal,
              WORD ordinal, void* fn, void** orig, const char** matchedDll) {
    BYTE* base = (BYTE*)(module ? module : GetModuleHandle(NULL));
    auto* dos = (IMAGE_DOS_HEADER*)base;
    auto* nt = (IMAGE_NT_HEADERS*)(base + dos->e_lfanew);
    auto& dir = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
    if (dir.VirtualAddress == 0) return false;
    const size_t prefixLen = dllMatch == DllMatch::Prefix ? strlen(dll) : 0;

    for (auto* imp = (IMAGE_IMPORT_DESCRIPTOR*)(base + dir.VirtualAddress); imp->Name; imp++) {
        const char* impName = (const char*)(base + imp->Name);
        bool dllOk = dllMatch == DllMatch::Prefix ? _strnicmp(impName, dll, prefixLen) == 0
                                                  : _stricmp(impName, dll) == 0;
        if (!dllOk) continue;

        if (!imp->OriginalFirstThunk) continue;
        auto* thunk = (IMAGE_THUNK_DATA*)(base + imp->FirstThunk);
        auto* ithunk = (IMAGE_THUNK_DATA*)(base + imp->OriginalFirstThunk);
        for (; thunk->u1.Function; thunk++, ithunk++) {
            if (byOrdinal) {
                if (!IMAGE_SNAP_BY_ORDINAL(ithunk->u1.Ordinal)) continue;
                if (IMAGE_ORDINAL(ithunk->u1.Ordinal) != ordinal) continue;
            } else {
                if (IMAGE_SNAP_BY_ORDINAL(ithunk->u1.Ordinal)) continue;
                auto* byName = (IMAGE_IMPORT_BY_NAME*)(base + ithunk->u1.AddressOfData);
                if (_stricmp((const char*)byName->Name, name) != 0) continue;
            }

            if ((void*)thunk->u1.Function == fn) {
                if (matchedDll) *matchedDll = impName;
                return true;
            }
            DWORD oldProt;
            VirtualProtect(&thunk->u1.Function, sizeof(void*), PAGE_EXECUTE_READWRITE, &oldProt);
            if (orig && !*orig) *orig = (void*)thunk->u1.Function;
            thunk->u1.Function = (ULONG_PTR)fn;
            VirtualProtect(&thunk->u1.Function, sizeof(void*), oldProt, &oldProt);
            if (matchedDll) *matchedDll = impName;
            return true;
        }
    }
    return false;
}

}  // namespace

bool Hook(HMODULE module, const char* dll, const char* name, void* fn, void** orig) {
    return HookImpl(module, dll, DllMatch::Exact, name, false, 0, fn, orig, nullptr);
}

bool Hook(HMODULE module, const char* dll, Ordinal ordinal, void* fn, void** orig) {
    return HookImpl(module, dll, DllMatch::Exact, nullptr, true, ordinal.value, fn, orig, nullptr);
}

bool Hook(HMODULE module, DllPrefix dll, const char* name, void* fn, void** orig,
          const char** matchedDll) {
    return HookImpl(module, dll.value, DllMatch::Prefix, name, false, 0, fn, orig, matchedDll);
}

}  // namespace autoplay::iat

namespace autoplay::procaddr {

namespace {

struct Entry {
    const char* name;
    Wrap wrap;
    bool evenIfNull;
};
constexpr int kMaxEntries = 32;
Entry g_entries[kMaxEntries];
int g_numEntries = 0;

typedef FARPROC(WINAPI* GetProcAddress_t)(HMODULE, LPCSTR);
GetProcAddress_t g_origGetProcAddress = nullptr;

FARPROC WINAPI MyGetProcAddress(HMODULE hModule, LPCSTR lpProcName) {
    FARPROC real = g_origGetProcAddress(hModule, lpProcName);
    // 序数指定(HIWORDが0)の場合は名前を持たないのでそのまま返す
    if (!lpProcName || ((ULONG_PTR)lpProcName >> 16) == 0) return real;

    void* result = (void*)real;
    for (int i = 0; i < g_numEntries; i++) {
        const Entry& e = g_entries[i];
        if (strcmp(lpProcName, e.name) != 0) continue;
        if (!result && !e.evenIfNull) continue;
        result = e.wrap(result);
    }
    return (FARPROC)result;
}

}  // namespace

void Override(const char* name, Wrap wrap, bool evenIfNull) {
    // DllMain(単一スレッド)からだけ登録する前提。上限を超えたら黙って捨てずに気づけるよう、
    // 呼び出し側の数を kMaxEntries 未満に保つこと。
    if (g_numEntries >= kMaxEntries) return;
    g_entries[g_numEntries++] = Entry{name, wrap, evenIfNull};
}

bool Install(HMODULE module) {
    if (g_origGetProcAddress) return true;
    return iat::HookTyped(module, "KERNEL32.dll", "GetProcAddress", &MyGetProcAddress,
                          &g_origGetProcAddress);
}

}  // namespace autoplay::procaddr
