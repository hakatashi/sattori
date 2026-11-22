#pragma once
#include <stdint.h>

// バックバッファ画素形式から ffmpeg rawvideo 形式・bpp への純粋変換(Linux/Windows共用)。

namespace autoplay::present::capture {

inline constexpr uint32_t kD3DFMT_R8G8B8 = 20;
inline constexpr uint32_t kD3DFMT_A8R8G8B8 = 21;
inline constexpr uint32_t kD3DFMT_X8R8G8B8 = 22;
inline constexpr uint32_t kD3DFMT_R5G6B5 = 23;
inline constexpr uint32_t kD3DFMT_X1R5G5B5 = 24;

inline constexpr uint32_t kDXGI_FORMAT_R8G8B8A8_UNORM = 28;
inline constexpr uint32_t kDXGI_FORMAT_R8G8B8A8_UNORM_SRGB = 29;
inline constexpr uint32_t kDXGI_FORMAT_B8G8R8A8_UNORM = 87;
inline constexpr uint32_t kDXGI_FORMAT_B8G8R8X8_UNORM = 88;
inline constexpr uint32_t kDXGI_FORMAT_B8G8R8A8_UNORM_SRGB = 91;

inline const char* D3dPixFmtName(uint32_t fmt) {
    switch (fmt) {
        case kD3DFMT_R8G8B8:
            return "bgr24";
        case kD3DFMT_A8R8G8B8:
        case kD3DFMT_X8R8G8B8:
            return "bgr0";
        case kD3DFMT_R5G6B5:
            return "rgb565le";
        case kD3DFMT_X1R5G5B5:
            return "rgb555le";
        default:
            return nullptr;
    }
}

inline uint32_t D3dBytesPerPixel(uint32_t fmt) {
    switch (fmt) {
        case kD3DFMT_R8G8B8:
            return 3;
        case kD3DFMT_R5G6B5:
        case kD3DFMT_X1R5G5B5:
            return 2;
        default:
            return 4;
    }
}

inline const char* DxgiPixFmtName(uint32_t fmt) {
    switch (fmt) {
        case kDXGI_FORMAT_R8G8B8A8_UNORM:
        case kDXGI_FORMAT_R8G8B8A8_UNORM_SRGB:
            return "rgb0";
        case kDXGI_FORMAT_B8G8R8A8_UNORM:
        case kDXGI_FORMAT_B8G8R8X8_UNORM:
        case kDXGI_FORMAT_B8G8R8A8_UNORM_SRGB:
            return "bgr0";
        default:
            return nullptr;
    }
}

inline uint32_t DxgiBytesPerPixel(uint32_t /*fmt*/) { return 4; }

}  // namespace autoplay::present::capture
