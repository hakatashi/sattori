// th06c(東方紅魔郷: Classic)用の最小限Steamworks APIスタブ。
//
// th06c.exeはsteam_api64.dllの9関数だけをインポートしており、SteamAPI_Init()が
// 成功しないと起動直後にexit(255)する(touhou-recorder reports/74)。Xvfb+wineの
// ヘッドレス環境ではSteamクライアントを常駐させられないため、本DLLを正規の
// steam_api64.dllの代わりにタイトル資産(games/th06c/)へ同梱し、Initを成功させる
// (upload-title-assets skill参照。録画パイプライン側での差し替え処理は不要)。
//
// ゲームが取得するインターフェースは、全スロットが0を返すダミーvtableを持つ
// フェイクオブジェクトとして返す。どのインターフェースの何番スロットが呼ばれたかは
// ログに残るので、0を返すと不都合なメソッドが見つかった場合はここで個別に
// 実装を足していく方針(touhou-recorder reports/74で実機確認済みの3インターフェース
// のみ個別対応が要った)。
//
// ビルド: x86_64-w64-mingw32-g++ -shared -O2 -static -o steam_api64.dll steam_api_stub.cpp

#include <windows.h>

#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstring>

#define S_API extern "C" __declspec(dllexport)

namespace {

FILE *g_log = nullptr;
CRITICAL_SECTION g_log_lock;
bool g_log_ready = false;

void LogOpen() {
  if (g_log_ready) return;
  InitializeCriticalSection(&g_log_lock);
  g_log = fopen("th06c_steam_stub.log", "w");
  g_log_ready = true;
}

void Log(const char *fmt, ...) {
  if (!g_log) return;
  EnterCriticalSection(&g_log_lock);
  va_list ap;
  va_start(ap, fmt);
  vfprintf(g_log, fmt, ap);
  va_end(ap);
  fputc('\n', g_log);
  fflush(g_log);
  LeaveCriticalSection(&g_log_lock);
}

// ---------------------------------------------------------------------------
// フェイクインターフェース
// ---------------------------------------------------------------------------

constexpr int kVtableSlots = 256;
constexpr int kMaxInterfaces = 64;

struct FakeInterface {
  void **vtable;
  char name[64];
};

FakeInterface g_ifaces[kMaxInterfaces];
int g_iface_count = 0;

const char *NameOf(void *self) {
  for (int i = 0; i < g_iface_count; ++i) {
    if (&g_ifaces[i] == self) return g_ifaces[i].name;
  }
  return "?";
}

// th06c.exeが埋め込んでいるSteam AppID(SteamAPI_RestartAppIfNecessaryの引数から判明、
// touhou-recorder reports/74)。
constexpr uint32_t kAppId = 4771400;

// 既定の戻り値0(false/NULL)では不都合なメソッドの個別対応。
// スロット番号はSteamworks SDKの各インターフェースのvtable順。
// 戻り値をNULLのまま返すとゲームが即座に逆参照してクラッシュするもの(文字列を
// 返すメソッド等)を、実機のクラッシュを見ながらここへ追加していく。
bool ResolveOverride(const char *name, int slot, uint64_t *out, const char **note) {
  if (strcmp(name, "STEAMAPPS_INTERFACE_VERSION009") == 0) {
    switch (slot) {
      case 0:  // BIsSubscribed()
        *out = 1;
        *note = "BIsSubscribed";
        return true;
      case 4:  // GetCurrentGameLanguage()
        *out = reinterpret_cast<uint64_t>("japanese");
        *note = "GetCurrentGameLanguage";
        return true;
      case 5:  // GetAvailableGameLanguages()
        *out = reinterpret_cast<uint64_t>("japanese");
        *note = "GetAvailableGameLanguages";
        return true;
    }
  }
  if (strcmp(name, "SteamUtils010") == 0) {
    switch (slot) {
      case 4:  // GetIPCountry()
        *out = reinterpret_cast<uint64_t>("JP");
        *note = "GetIPCountry";
        return true;
      case 9:  // GetAppID()
        *out = kAppId;
        *note = "GetAppID";
        return true;
    }
  }
  return false;
}

// 全メソッド共通のスタブ。MS x64 ABIでは呼び出し側がスタックを片付けるため、
// 実際の引数が何個あってもこのシグネチャで受けて無視して問題ない。
template <int Slot>
uint64_t StubMethod(void *self) {
  const char *name = NameOf(self);
  uint64_t value = 0;
  const char *note = nullptr;
  if (ResolveOverride(name, Slot, &value, &note)) {
    Log("[iface] %s::slot%d() [%s] -> 0x%llx", name, Slot, note,
        static_cast<unsigned long long>(value));
    return value;
  }
  Log("[iface] %s::slot%d() -> 0", name, Slot);
  return 0;
}

void *g_vtable[kVtableSlots];

template <int N>
struct VtableFiller {
  static void Fill() {
    g_vtable[N] = reinterpret_cast<void *>(&StubMethod<N>);
    VtableFiller<N - 1>::Fill();
  }
};

template <>
struct VtableFiller<-1> {
  static void Fill() {}
};

bool g_vtable_ready = false;

void EnsureVtable() {
  if (g_vtable_ready) return;
  VtableFiller<kVtableSlots - 1>::Fill();
  g_vtable_ready = true;
}

FakeInterface *GetOrCreateInterface(const char *version) {
  EnsureVtable();
  if (!version) version = "(null)";
  for (int i = 0; i < g_iface_count; ++i) {
    if (strcmp(g_ifaces[i].name, version) == 0) return &g_ifaces[i];
  }
  if (g_iface_count >= kMaxInterfaces) {
    Log("[warn] interface table full, reusing slot 0 for %s", version);
    return &g_ifaces[0];
  }
  FakeInterface *iface = &g_ifaces[g_iface_count++];
  iface->vtable = g_vtable;
  snprintf(iface->name, sizeof(iface->name), "%s", version);
  Log("[iface] created %s at %p", iface->name, (void *)iface);
  return iface;
}

// SteamInternal_ContextInit()に渡される構造体(steam_api_internal.hの
// s_CallbackCounterAndContext。void*[3] = {初期化関数, カウンタ, コンテキスト})。
struct ContextInitData {
  void(__cdecl *pFn)(void *);
  uintptr_t counter;
  void *ctx;
};

uintptr_t g_init_counter = 0;

}  // namespace

// ---------------------------------------------------------------------------
// エクスポート
// ---------------------------------------------------------------------------

// SteamAPI_RestartAppIfNecessary: Steam経由での再起動は不要(false)。
S_API bool SteamAPI_RestartAppIfNecessary(uint32_t unOwnAppID) {
  LogOpen();
  Log("SteamAPI_RestartAppIfNecessary(appid=%u) -> false", unOwnAppID);
  return false;
}

// SteamInternal_SteamAPI_Init: 0 == k_ESteamAPIInitResult_OK。
S_API int SteamInternal_SteamAPI_Init(const char *pszInternalCheckInterfaceVersions,
                                      char *pOutErrMsg) {
  LogOpen();
  Log("SteamInternal_SteamAPI_Init(versions=%s) -> OK",
      pszInternalCheckInterfaceVersions ? pszInternalCheckInterfaceVersions : "(null)");
  if (pOutErrMsg) pOutErrMsg[0] = '\0';
  g_init_counter++;
  return 0;
}

S_API void SteamAPI_Shutdown() { Log("SteamAPI_Shutdown()"); }

S_API void SteamAPI_RunCallbacks() { /* 毎フレーム呼ばれるのでログしない */ }

S_API int SteamAPI_GetHSteamUser() { return 1; }

S_API void SteamAPI_RegisterCallback(void *pCallback, int iCallback) {
  Log("SteamAPI_RegisterCallback(cb=%p, id=%d)", pCallback, iCallback);
}

S_API void SteamAPI_UnregisterCallback(void *pCallback) {
  Log("SteamAPI_UnregisterCallback(cb=%p)", pCallback);
}

S_API void *SteamInternal_FindOrCreateUserInterface(int hSteamUser, const char *pszVersion) {
  LogOpen();
  Log("SteamInternal_FindOrCreateUserInterface(user=%d, version=%s)", hSteamUser,
      pszVersion ? pszVersion : "(null)");
  return GetOrCreateInterface(pszVersion);
}

S_API void *SteamInternal_ContextInit(void *pContextInitData) {
  ContextInitData *p = static_cast<ContextInitData *>(pContextInitData);
  if (p->counter != g_init_counter) {
    p->pFn(&p->ctx);
    p->counter = g_init_counter;
  }
  return &p->ctx;
}
