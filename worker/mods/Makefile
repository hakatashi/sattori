CXX32 ?= i686-w64-mingw32-g++
CXX64 ?= x86_64-w64-mingw32-g++

COMMON_FLAGS := -O2 -static-libgcc -static-libstdc++
DLL_FLAGS    := -shared $(COMMON_FLAGS) -luser32

# 共通ソースファイル
COMMON_DIR   := common
SRC_LOGGING  := $(COMMON_DIR)/logging.cpp
SRC_SCORE    := $(COMMON_DIR)/score_monitor.cpp
SRC_DINPUT   := $(COMMON_DIR)/dinput_hook.cpp
SRC_WAIT     := $(COMMON_DIR)/window_wait.cpp
SRC_FPS      := $(COMMON_DIR)/fps_monitor.cpp
SRC_FPS_D3D8 := $(COMMON_DIR)/fps_limiter_hook_d3d8.cpp
SRC_DSOUND   := $(COMMON_DIR)/dsound_hook.cpp
SRC_FPS_DISP := $(COMMON_DIR)/fps_display_hook.cpp
SRC_FPS_LIM  := $(COMMON_DIR)/fps_limiter_hook.cpp

# 共通ソース組み合わせ
SRCS_BASE_HOOK := $(SRC_DINPUT) $(SRC_WAIT) $(SRC_LOGGING) $(SRC_SCORE)
SRCS_FPS_HOOK  := $(SRCS_BASE_HOOK) $(SRC_FPS)

# ターゲット出力ファイル
TARGET_INJECTOR32 := common/build/injector.exe
TARGET_INJECTOR64 := common/build/injector64.exe
TARGET_STEAM_API  := th06c_steam_stub/build/steam_api64.dll
TARGET_TH06       := th06_replay_autoplay/build/th06_hook.dll
TARGET_TH06C      := th06c_replay_autoplay/build/th06c_hook.dll
TARGET_TH07       := th07_replay_autoplay/build/th07_hook.dll
TARGET_TH08       := th08_replay_autoplay/build/th08_hook.dll
TARGET_TH09       := th09_replay_autoplay/build/th09_hook.dll
TARGET_TH10       := th10_replay_autoplay/build/th10_hook.dll
TARGET_TH11       := th11_replay_autoplay/build/th11_hook.dll
TARGET_TH12       := th12_replay_autoplay/build/th12_hook.dll
TARGET_TH20       := th20_replay_autoplay/build/th20_hook.dll

ALL_TARGETS := \
	$(TARGET_INJECTOR32) \
	$(TARGET_INJECTOR64) \
	$(TARGET_STEAM_API) \
	$(TARGET_TH06) \
	$(TARGET_TH06C) \
	$(TARGET_TH07) \
	$(TARGET_TH08) \
	$(TARGET_TH09) \
	$(TARGET_TH10) \
	$(TARGET_TH11) \
	$(TARGET_TH12) \
	$(TARGET_TH20)

.PHONY: all clean \
	injector injector64 steam_api64 \
	th06 th06c th07 th08 th09 th10 th11 th12 th20

all: $(ALL_TARGETS)

# 個別ショートカットターゲット
injector: $(TARGET_INJECTOR32)
injector64: $(TARGET_INJECTOR64)
steam_api64: $(TARGET_STEAM_API)
th06: $(TARGET_TH06)
th06c: $(TARGET_TH06C)
th07: $(TARGET_TH07)
th08: $(TARGET_TH08)
th09: $(TARGET_TH09)
th10: $(TARGET_TH10)
th11: $(TARGET_TH11)
th12: $(TARGET_TH12)
th20: $(TARGET_TH20)

clean:
	rm -rf common/build
	rm -rf th06_replay_autoplay/build
	rm -rf th06c_replay_autoplay/build
	rm -rf th06c_steam_stub/build
	rm -rf th07_replay_autoplay/build
	rm -rf th08_replay_autoplay/build
	rm -rf th09_replay_autoplay/build
	rm -rf th10_replay_autoplay/build
	rm -rf th11_replay_autoplay/build
	rm -rf th12_replay_autoplay/build
	rm -rf th20_replay_autoplay/build

# 1. injector（32bit / 64bit）
$(TARGET_INJECTOR32): common/injector.cpp
	@mkdir -p $(@D)
	$(CXX32) $(COMMON_FLAGS) -o $@ $<

$(TARGET_INJECTOR64): common/injector.cpp
	@mkdir -p $(@D)
	$(CXX64) $(COMMON_FLAGS) -static -o $@ $<

# 2. Steamworks API stub for th06c（64bit）
$(TARGET_STEAM_API): th06c_steam_stub/steam_api_stub.cpp
	@mkdir -p $(@D)
	$(CXX64) $(DLL_FLAGS) -static -o $@ $<

# 3. th06c hook（64bit、UTF-8/UTF-16LE、-static）
$(TARGET_TH06C): th06c_replay_autoplay/dllmain.cpp $(SRC_LOGGING) $(SRC_SCORE)
	@mkdir -p $(@D)
	$(CXX64) $(DLL_FLAGS) -static \
		-finput-charset=UTF-8 -fexec-charset=UTF-8 -fwide-exec-charset=UTF-16LE \
		-o $@ $^

# 4. 標準的な32bitフックDLL（fps_monitor なし）
$(TARGET_TH06): th06_replay_autoplay/dllmain.cpp $(SRCS_BASE_HOOK)
	@mkdir -p $(@D)
	$(CXX32) $(DLL_FLAGS) -o $@ $^

$(TARGET_TH07): th07_replay_autoplay/dllmain.cpp $(SRCS_BASE_HOOK)
	@mkdir -p $(@D)
	$(CXX32) $(DLL_FLAGS) -o $@ $^

# 5. 標準的な32bitフックDLL（fps_monitor あり）
$(TARGET_TH08): th08_replay_autoplay/dllmain.cpp $(SRCS_FPS_HOOK)
	@mkdir -p $(@D)
	$(CXX32) $(DLL_FLAGS) -o $@ $^

$(TARGET_TH10): th10_replay_autoplay/dllmain.cpp $(SRCS_FPS_HOOK)
	@mkdir -p $(@D)
	$(CXX32) $(DLL_FLAGS) -o $@ $^

$(TARGET_TH11): th11_replay_autoplay/dllmain.cpp $(SRCS_FPS_HOOK)
	@mkdir -p $(@D)
	$(CXX32) $(DLL_FLAGS) -o $@ $^

$(TARGET_TH12): th12_replay_autoplay/dllmain.cpp $(SRCS_FPS_HOOK)
	@mkdir -p $(@D)
	$(CXX32) $(DLL_FLAGS) -o $@ $^

# 6. th09 hook（32bit、D3D8フレームレート制限・DirectSound周波数・fps表示補正フック）
$(TARGET_TH09): th09_replay_autoplay/dllmain.cpp $(SRCS_FPS_HOOK) $(SRC_FPS_D3D8) $(SRC_DSOUND) $(SRC_FPS_DISP)
	@mkdir -p $(@D)
	$(CXX32) $(DLL_FLAGS) -o $@ $^

# 7. th20 hook（32bit、D3D9フレームレート制限・DirectSound周波数・fps表示補正フック、-static）
$(TARGET_TH20): th20_replay_autoplay/dllmain.cpp $(SRCS_FPS_HOOK) $(SRC_FPS_LIM) $(SRC_DSOUND) $(SRC_FPS_DISP)
	@mkdir -p $(@D)
	$(CXX32) $(DLL_FLAGS) -static -o $@ $^
