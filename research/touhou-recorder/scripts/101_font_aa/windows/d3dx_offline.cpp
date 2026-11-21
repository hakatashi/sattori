// Phase 101 (Windows): re-run D3DXLoadSurfaceFromMemory(TRIANGLE) offline on D3DX_DUMP_DIR source dumps.
// Usage: d3dx_offline.exe <dll path> <src.bin> <out_dst.bin> <dstW> <dstH> <dstY> [filter=4] [fpu_preserve=0]
// Dump format: DWORD x4 (w, h, D3DFORMAT, bpp) + tightly packed rows (same as d3dx_filter_hook.cpp).
// The destination is a 512x512 A4R4G4B4 surface cleared to 0; dst rect = (0,dstY)-(dstW,dstY+dstH),
// matching the game's calls. Output = the dst rect read back, same dump format.
#include <windows.h>
#include <d3d9.h>
#include <stdio.h>
#include <vector>

typedef HRESULT(WINAPI* LoadFromMem_t)(IDirect3DSurface9*, const PALETTEENTRY*, const RECT*, LPCVOID,
                                       D3DFORMAT, UINT, const PALETTEENTRY*, const RECT*, DWORD, D3DCOLOR);

int main(int argc, char** argv) {
    if (argc < 7) { fprintf(stderr, "usage\n"); return 2; }
    HMODULE dll = LoadLibraryA(argv[1]);
    if (!dll) { fprintf(stderr, "LoadLibrary failed %lu\n", GetLastError()); return 1; }
    auto load = (LoadFromMem_t)GetProcAddress(dll, "D3DXLoadSurfaceFromMemory");
    UINT dw = atoi(argv[4]), dh = atoi(argv[5]), dy = atoi(argv[6]);
    DWORD filter = argc > 7 ? strtoul(argv[7], 0, 0) : 4;

    FILE* f = fopen(argv[2], "rb");
    if (!f) return 1;
    DWORD hdr[4]; fread(hdr, 4, 4, f);
    std::vector<BYTE> src(hdr[0] * hdr[1] * hdr[3]);
    fread(src.data(), 1, src.size(), f); fclose(f);

    IDirect3D9* d3d = Direct3DCreate9(D3D_SDK_VERSION);
    HWND wnd = CreateWindowA("STATIC", "x", WS_OVERLAPPEDWINDOW, 0, 0, 64, 64, 0, 0, 0, 0);
    D3DPRESENT_PARAMETERS pp = {}; pp.Windowed = TRUE; pp.SwapEffect = D3DSWAPEFFECT_DISCARD;
    pp.BackBufferFormat = D3DFMT_UNKNOWN; pp.hDeviceWindow = wnd;
    IDirect3DDevice9* dev = nullptr;
    HRESULT hr = d3d->CreateDevice(D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL, wnd,
                                   D3DCREATE_SOFTWARE_VERTEXPROCESSING | (argc > 8 && atoi(argv[8]) ? D3DCREATE_FPU_PRESERVE : 0), &pp, &dev);
    if (FAILED(hr)) { fprintf(stderr, "CreateDevice %08lx\n", hr); return 1; }
    IDirect3DSurface9* surf = nullptr;
    hr = dev->CreateOffscreenPlainSurface(512, 512, D3DFMT_A4R4G4B4, D3DPOOL_SYSTEMMEM, &surf, nullptr);
    if (FAILED(hr)) { fprintf(stderr, "CreateSurface %08lx\n", hr); return 1; }
    D3DLOCKED_RECT lr;
    surf->LockRect(&lr, nullptr, 0);
    for (int y = 0; y < 512; y++) memset((BYTE*)lr.pBits + y * lr.Pitch, 0, 512 * 2);
    surf->UnlockRect();

    RECT srect = {0, 0, (LONG)hdr[0], (LONG)hdr[1]};
    RECT drect = {0, (LONG)dy, (LONG)dw, (LONG)(dy + dh)};
    hr = load(surf, nullptr, &drect, src.data(), (D3DFORMAT)hdr[2], hdr[0] * hdr[3], nullptr, &srect,
              filter, 0);
    if (FAILED(hr)) { fprintf(stderr, "D3DXLoadSurfaceFromMemory %08lx\n", hr); return 1; }

    surf->LockRect(&lr, nullptr, D3DLOCK_READONLY);
    FILE* o = fopen(argv[3], "wb");
    DWORD oh[4] = {dw, dh, (DWORD)D3DFMT_A4R4G4B4, 2};
    fwrite(oh, 4, 4, o);
    for (UINT y = 0; y < dh; y++) fwrite((BYTE*)lr.pBits + (dy + y) * lr.Pitch, 2, dw, o);
    fclose(o);
    surf->UnlockRect();
    surf->Release(); dev->Release(); d3d->Release();
    return 0;
}
