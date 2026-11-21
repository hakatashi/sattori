# 録画用MOD(thNN_hook.dll)・injector・Steamworks APIスタブのクロスビルド(mingw-w64)。
# 手順と注意点は .claude/skills/build-mods/SKILL.md、ソースの構成は worker/docs/mods.md。
#
# タイトルは下の「タイトルの宣言」に ARCH(32/64)・使うモジュール・-static の有無を書くだけで、
# 規則はパターンから組み立てる(Issue #393)。

CXX32 ?= i686-w64-mingw32-g++
CXX64 ?= x86_64-w64-mingw32-g++
OBJDUMP32 ?= i686-w64-mingw32-objdump
OBJDUMP64 ?= x86_64-w64-mingw32-objdump
HOSTCXX ?= g++

# -MMD -MP: ヘッダの変更でも該当オブジェクトが再ビルドされるよう、依存関係(.d)を自動生成する。
# -s: シンボルを落としてDLLを小さくする。-Werror: 警告を残さない(Issue #392)。
# -Wno-cast-function-type: GetProcAddress(FARPROC)との相互キャストはWin32フックの定石で避けられない。
# -I.: ソースは "core/log.h" のように mods/ からのパスで include する。
WARN_FLAGS      := -Wall -Wextra -Wno-cast-function-type -Werror
CXXFLAGS_COMMON := -O2 -std=c++20 $(WARN_FLAGS) -MMD -MP -I.
LDFLAGS_COMMON  := -s -static-libgcc -static-libstdc++
DLL_FLAGS       := -shared $(LDFLAGS_COMMON) -luser32

# オブジェクトはアーキテクチャごと(32/64)に1回だけコンパイルし、タイトル間で共有する。
OBJ_DIR := obj

# ---------------------------------------------------------------------------
# モジュール(ディレクトリの構成は worker/docs/mods.md)
# ---------------------------------------------------------------------------
MOD_core        := core/log.cpp core/pe_iat.cpp core/runtime_config.cpp
MOD_code_patch  := core/code_patch.cpp
MOD_dinput      := input/dinput.cpp
MOD_window_wait := autoplay/window_wait.cpp
MOD_speed_hack  := clock/speed_hack.cpp
MOD_fps_display := clock/fps_display.cpp
MOD_present     := present/bus.cpp present/limiter.cpp present/d3d8.cpp present/d3d9.cpp
MOD_dsound      := audio/dsound.cpp audio/sync_marker.cpp
MOD_wasapi      := audio/wasapi.cpp audio/sync_marker.cpp
MOD_score       := monitor/score_monitor.cpp
MOD_d3dx_filter := texture/d3dx_filter.cpp
MOD_bc7         := texture/d3d11_bc7.cpp
# th06c/th06nc(DXライブラリ)の共通部。DirectSoundもCoCreateInstance経由でフックするので dsound を含む。
MOD_dxlib       := autoplay/dxlib_common.cpp input/dxlib_input.cpp $(MOD_dsound) $(MOD_wasapi) \
                   $(MOD_speed_hack) $(MOD_window_wait)

# ビルドはするがどのタイトルにも組み込んでいないソース(-Werror で壊れていないかだけ確かめる)。
# present/dxgi.cpp は #388(フレーム同期)で使う予定。
CHECK_ONLY_SRCS_64 := present/dxgi.cpp

# 倍速録画(Issue #288)のQPC偽装・音声周波数スケールとA/V同期マーカー・スコア監視は、
# 全32bitタイトル共通で組み込む。
BASE32 := core dinput window_wait speed_hack dsound score

# ---------------------------------------------------------------------------
# タイトルの宣言
#   <t>_ARCH: 32 / 64、<t>_MODS: 使うモジュール、<t>_STATIC: 1 なら -static、<t>_LIBS: 追加のライブラリ
#   出力は <t>_replay_autoplay/build/<t>_hook.dll(タイトル資産の配置と同じ。変えないこと)。
# ---------------------------------------------------------------------------
TITLES := th06 th06c th06nc th07 th08 th09 th10 th11 th12 th13 th15 th20 th128

# th06: vpatch＋fps表示補正のtimeGetTime版(touhou-recorder reports/90)
th06_ARCH := 32
th06_MODS := $(BASE32) fps_display
# th06c: 64bit(PE32+)。DXライブラリなので入力・音声はGetProcAddress経由
th06c_ARCH   := 64
th06c_MODS   := core dxlib score
th06c_STATIC := 1
# th06nc: th06cに加えてCPU描画用のBC7展開(D3D11_DECODE_BC7=1のときだけ有効、reports/96)。-ldxguidが要る
th06nc_ARCH   := 64
th06nc_MODS   := core dxlib score bc7
th06nc_STATIC := 1
th06nc_LIBS   := -ldxguid
th07_ARCH := 32
th07_MODS := $(BASE32)
# th08: fps表示補正(timeGetTime版)
th08_ARCH := 32
th08_MODS := $(BASE32) fps_display
# th09: D3D8のPresentの上限・fps表示補正
th09_ARCH := 32
th09_MODS := $(BASE32) present fps_display
# th10・th11・th12・th13・th128: 文字の縮小フィルタ補完(touhou-recorder reports/101・102)
th10_ARCH := 32
th10_MODS := $(BASE32) present d3dx_filter
th11_ARCH := 32
th11_MODS := $(BASE32) d3dx_filter
# th12: 倍速時のfps表示をコードケーブで補正する(core/code_patch)
th12_ARCH := 32
th12_MODS := $(BASE32) present d3dx_filter code_patch
# th13: th128と同じ構成(VsyncPatchは使わない、touhou-recorder reports/100)
th13_ARCH := 32
th13_MODS := $(BASE32) present d3dx_filter
# th15: GetDeviceState方式・Presentの上限・fps表示補正(ViaCaller)、-static(touhou-recorder reports/82)
th15_ARCH   := 32
th15_MODS   := $(BASE32) present fps_display
th15_STATIC := 1
# th20: Presentの上限・fps表示補正、-static(wine実行時にlibgcc_s等が見つからず注入に失敗した、reports/44)
th20_ARCH   := 32
th20_MODS   := $(BASE32) present fps_display
th20_STATIC := 1
th128_ARCH := 32
th128_MODS := $(BASE32) present d3dx_filter

# ---------------------------------------------------------------------------
# ツール(出力パスはタイトル資産の配置と同じ。変えないこと)
# ---------------------------------------------------------------------------
TARGET_INJECTOR32   := common/build/injector.exe
TARGET_INJECTOR64   := common/build/injector64.exe
TARGET_STEAM_API    := th06c_steam_stub/build/steam_api64.dll
TARGET_STEAM_API_NC := th06nc_steam_stub/build/steam_api64.dll
STEAM_STUB_SRC      := tools/steam_stub.cpp

title_dll = $(1)_replay_autoplay/build/$(1)_hook.dll
TITLE_DLLS := $(foreach t,$(TITLES),$(call title_dll,$(t)))
ALL_TARGETS := $(TARGET_INJECTOR32) $(TARGET_INJECTOR64) $(TARGET_STEAM_API) $(TARGET_STEAM_API_NC) \
               $(TITLE_DLLS)

.PHONY: all clean check check-compile check-imports test \
	injector injector64 steam_api64 steam_api64_th06nc $(TITLES)

all: $(ALL_TARGETS)

injector: $(TARGET_INJECTOR32)
injector64: $(TARGET_INJECTOR64)
steam_api64: $(TARGET_STEAM_API)
steam_api64_th06nc: $(TARGET_STEAM_API_NC)

CLEAN_DIRS := $(OBJ_DIR) common/build th06c_steam_stub/build th06nc_steam_stub/build \
              $(foreach t,$(TITLES),$(t)_replay_autoplay/build)
clean:
	rm -rf $(CLEAN_DIRS)

# ---------------------------------------------------------------------------
# コンパイル規則(アーキテクチャごとに1回だけ。-MMDで生成した.dを取り込む)
# ---------------------------------------------------------------------------
objs = $(patsubst %.cpp,$(OBJ_DIR)/$(1)/%.o,$(filter %.cpp,$(2)))

$(OBJ_DIR)/32/%.o: %.cpp
	@mkdir -p $(@D)
	$(CXX32) $(CXXFLAGS_COMMON) -c -o $@ $<

$(OBJ_DIR)/64/%.o: %.cpp
	@mkdir -p $(@D)
	$(CXX64) $(CXXFLAGS_COMMON) -c -o $@ $<

-include $(shell find $(OBJ_DIR) -name '*.d' 2>/dev/null)

# タイトルのDLL。モジュールのソースは重複を除いて(sort)リンクする。
define TITLE_RULE
$(1)_SRCS := $(1)_replay_autoplay/dllmain.cpp $$(sort $$(foreach m,$$($(1)_MODS),$$(MOD_$$(m))))
$(call title_dll,$(1)): $$(call objs,$$($(1)_ARCH),$$($(1)_SRCS))
	@mkdir -p $$(@D)
	$$(CXX$$($(1)_ARCH)) $$(DLL_FLAGS) $$(if $$($(1)_STATIC),-static) -o $$@ $$^ $$($(1)_LIBS)
$(1): $(call title_dll,$(1))
endef
$(foreach t,$(TITLES),$(eval $(call TITLE_RULE,$(t))))

# injector(32bit / 64bit)
$(TARGET_INJECTOR32): $(call objs,32,tools/injector.cpp)
	@mkdir -p $(@D)
	$(CXX32) $(LDFLAGS_COMMON) -o $@ $^

$(TARGET_INJECTOR64): $(call objs,64,tools/injector.cpp)
	@mkdir -p $(@D)
	$(CXX64) $(LDFLAGS_COMMON) -static -o $@ $^

# Steamworks APIスタブ(64bit。th06c・th06ncで同じソースを使い、AppIDとログ名だけ変える)。
# スタブは-Werrorの対象外にしたいのでobj/を経由せず直接ビルドする。
$(TARGET_STEAM_API): $(STEAM_STUB_SRC)
	@mkdir -p $(@D)
	$(CXX64) -O2 -std=c++20 $(DLL_FLAGS) -static -DAPP_ID=4771400 -DLOG_NAME='"th06c_steam_stub.log"' -o $@ $<

$(TARGET_STEAM_API_NC): $(STEAM_STUB_SRC)
	@mkdir -p $(@D)
	$(CXX64) -O2 -std=c++20 $(DLL_FLAGS) -static -DAPP_ID=4763590 -DLOG_NAME='"th06nc_steam_stub.log"' -o $@ $<

# ---------------------------------------------------------------------------
# 検査(CI の mods-build-smoketest が実行する)
# ---------------------------------------------------------------------------
check: check-compile check-imports test

# どのタイトルにも組み込んでいないソースもコンパイルだけはする。
check-compile: $(call objs,64,$(CHECK_ONLY_SRCS_64))

# DLL・EXEのインポートに、Wineのプレフィックスに無いMinGWのランタイム(libgcc_s・libstdc++・
# libwinpthread)が出ていないか。出ていると注入に失敗する(th20、touhou-recorder reports/44)。
FORBIDDEN_IMPORTS := libgcc_s|libstdc\+\+|libwinpthread
check-imports: $(ALL_TARGETS)
	@fail=0; for f in $(ALL_TARGETS); do \
	  case $$f in *64.exe|*steam_api64.dll|th06c_*|th06nc_*) od=$(OBJDUMP64);; *) od=$(OBJDUMP32);; esac; \
	  bad=$$($$od -p $$f | grep -E 'DLL Name:' | grep -iE '$(FORBIDDEN_IMPORTS)'); \
	  if [ -n "$$bad" ]; then echo "NG $$f:$$bad"; fail=1; fi; \
	done; \
	if [ $$fail -ne 0 ]; then exit 1; fi; echo "check-imports: OK ($(words $(ALL_TARGETS)) files)"

# Win32 に依存しないロジックの単体テスト(ホストの g++)。テストは mods/tests/test_*.cpp。
HOST_TEST_SRCS := $(wildcard tests/test_*.cpp)
HOST_TEST_BIN  := $(OBJ_DIR)/host/mod_tests
$(HOST_TEST_BIN): $(HOST_TEST_SRCS) tests/test_main.cpp
	@mkdir -p $(@D)
	$(HOSTCXX) -O1 -std=c++20 $(WARN_FLAGS) -MMD -MP -I. -o $@ $(filter %.cpp,$^)

test: $(HOST_TEST_BIN)
	cd tests && ../$(HOST_TEST_BIN)
