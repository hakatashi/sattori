#include "present/bus.h"

namespace autoplay::present {

namespace {

constexpr int kMaxHandlers = 8;

template <typename F>
struct HandlerList {
    F fn[kMaxHandlers] = {};
    int priority[kMaxHandlers] = {};
    int n = 0;

    // 優先度の昇順を保って挿入する(同じ優先度なら登録順)。同じハンドラは1回だけ。
    void Add(F f, int prio) {
        for (int i = 0; i < n; i++)
            if (fn[i] == f) return;
        if (n >= kMaxHandlers) return;
        int pos = n;
        while (pos > 0 && priority[pos - 1] > prio) {
            fn[pos] = fn[pos - 1];
            priority[pos] = priority[pos - 1];
            pos--;
        }
        fn[pos] = f;
        priority[pos] = prio;
        n++;
    }
};

HandlerList<PreHandler> g_pre;
HandlerList<PostHandler> g_post;
HandlerList<DeviceHandler> g_device;

}  // namespace

void AddPreHandler(PreHandler handler, int priority) { g_pre.Add(handler, priority); }
void AddPostHandler(PostHandler handler, int priority) { g_post.Add(handler, priority); }
void AddDeviceHandler(DeviceHandler handler) { g_device.Add(handler, 0); }

unsigned DispatchPre(const Frame& frame) {
    unsigned flags = kThrottle;
    for (int i = 0; i < g_pre.n; i++) g_pre.fn[i](frame, flags);
    return flags;
}

void DispatchPost(const Frame& frame, unsigned flags, HRESULT hr) {
    for (int i = 0; i < g_post.n; i++) g_post.fn[i](frame, flags, hr);
}

void DispatchDevice(Api api, void* target) {
    for (int i = 0; i < g_device.n; i++) g_device.fn[i](api, target);
}

}  // namespace autoplay::present
