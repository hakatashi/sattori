#include "core/code_patch.h"
#include <string.h>

namespace autoplay::code_patch {

BYTE* At(ULONG_PTR rva) { return (BYTE*)GetModuleHandle(NULL) + rva; }

bool Matches(ULONG_PTR rva, const BYTE* expected, size_t len) {
    return memcmp(At(rva), expected, len) == 0;
}

BYTE* AllocCave(size_t size) {
    return (BYTE*)VirtualAlloc(NULL, size, MEM_COMMIT | MEM_RESERVE, PAGE_EXECUTE_READWRITE);
}

BYTE* EmitJmp(BYTE* p, const BYTE* target) {
    *p++ = 0xe9;
    LONG rel = (LONG)(target - (p + 4));
    memcpy(p, &rel, 4);
    return p + 4;
}

void RedirectTo(BYTE* site, size_t len, const BYTE* target) {
    DWORD oldProt;
    VirtualProtect(site, len, PAGE_EXECUTE_READWRITE, &oldProt);
    EmitJmp(site, target);
    for (size_t i = 5; i < len; i++) site[i] = 0x90;
    VirtualProtect(site, len, oldProt, &oldProt);
    FlushInstructionCache(GetCurrentProcess(), site, len);
}

}  // namespace autoplay::code_patch
