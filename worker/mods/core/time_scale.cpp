#include "core/time_scale.h"

namespace autoplay::time_scale {

namespace {
MenuSleepHandler g_menuSleepHandler = nullptr;
}  // namespace

void SetMenuSleepHandler(MenuSleepHandler handler) { g_menuSleepHandler = handler; }

void MenuSleep(unsigned long baseMs) {
    if (g_menuSleepHandler) {
        g_menuSleepHandler(baseMs);
        return;
    }
    Sleep((DWORD)(baseMs * Menu()));
}

}  // namespace autoplay::time_scale
