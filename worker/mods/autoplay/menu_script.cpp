#include "autoplay/menu_script.h"

#include "core/log.h"
#include "core/time_scale.h"
#include "present/capture/frame_sync.h"

namespace autoplay {

bool RunMenuScript(const char* gameId, std::span<const MenuStep> steps, int firstStep, PressFn press) {
    int stepNo = firstStep;
    for (const MenuStep& step : steps) {
        if (step.custom) {
            if (!step.custom(stepNo)) return false;
        } else {
            LogStep(stepNo, "%s", step.label);
            DWORD wait = step.waitMs;
            if (step.waitMsFrameSync != 0 && frame_sync::Active()) wait = step.waitMsFrameSync;
            for (int i = 0; i < step.repeat; i++) {
                press(step.key);
                time_scale::MenuSleep(wait);
            }
        }
        stepNo++;
    }

    frame_sync::SetUnthrottled(true);
    LogSequenceComplete(gameId);
    return true;
}

}  // namespace autoplay
