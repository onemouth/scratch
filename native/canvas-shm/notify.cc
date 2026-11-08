// POSIX named semaphore wakeups. Data stays in SHM; callbacks carry no payload.
#include <node_api.h>
#include <semaphore.h>
#include <fcntl.h>
#include <cerrno>
#include <cstring>
#include <string>
#include <atomic>
#include <thread>
#include <system_error>
#include <mutex>
#include <unordered_set>

std::mutex receiverMutex;
std::unordered_set<std::string> receiverNames;
extern napi_value fail(napi_env, const char*, const std::string&);
extern bool nameArg(napi_env, napi_value, std::string&);
extern bool args(napi_env, napi_callback_info, size_t, napi_value*);

struct Signal {
  sem_t* sem = SEM_FAILED;
  bool owner = false, sender = false, cleanup = false, registered = false;
  std::string name;
  napi_env env = nullptr;
  napi_threadsafe_function callback = nullptr;
  std::thread thread;
  std::atomic<bool> closed{false};
};
const napi_type_tag SIGNAL_TAG = {0x531d543ab54f4351ULL, 0x9329fa3d5df42c22ULL};
void signalDispose(Signal* s) {
  if (s->closed.exchange(true)) return;
  // Wakes our own blocked thread on cancellation, or the receiver on owner close.
  sem_post(s->sem);
  if (s->thread.joinable()) s->thread.join();
  if (s->callback) { napi_release_threadsafe_function(s->callback, napi_tsfn_abort); s->callback = nullptr; }
  sem_close(s->sem);
  if (s->owner) sem_unlink(s->name.c_str());
  if (s->registered) {
    std::lock_guard<std::mutex> lock(receiverMutex); receiverNames.erase(s->name); s->registered = false;
  }
}
void signalEnvCleanup(void* data) {
  auto* s = static_cast<Signal*>(data); s->cleanup = false; signalDispose(s);
}
void signalFinalizer(napi_env, void* data, void*) {
  auto* s = static_cast<Signal*>(data);
  if (s->cleanup) { napi_remove_env_cleanup_hook(s->env, signalEnvCleanup, s); s->cleanup = false; }
  signalDispose(s); delete s;
}
Signal* signalHandle(napi_env env, napi_value value) {
  bool tagged = false; Signal* s = nullptr;
  if (napi_check_object_type_tag(env, value, &SIGNAL_TAG, &tagged) != napi_ok || !tagged ||
      napi_unwrap(env, value, reinterpret_cast<void**>(&s)) != napi_ok || !s) {
    fail(env, "SHM_ARGUMENT", "Expected a notification handle"); return nullptr;
  }
  return s;
}
void signalCallJs(napi_env env, napi_value callback, void*, void*) {
  if (!env || !callback) return;
  napi_value undefined, result; napi_get_undefined(env, &undefined);
  napi_call_function(env, undefined, callback, 0, nullptr, &result);
}
napi_value signalWrap(napi_env env, Signal* s) {
  napi_value result;
  if (napi_create_object(env, &result) != napi_ok || napi_type_tag_object(env, result, &SIGNAL_TAG) != napi_ok ||
      napi_wrap(env, result, s, signalFinalizer, nullptr, nullptr) != napi_ok) {
    signalDispose(s); delete s; return fail(env, "SHM_ALLOC", "Cannot wrap notification handle");
  }
  s->env = env;
  napi_add_env_cleanup_hook(env, signalEnvCleanup, s); s->cleanup = true;
  return result;
}
napi_value SignalCreate(napi_env env, napi_callback_info info) {
  napi_value a[1]; std::string name;
  if (!args(env, info, 1, a) || !nameArg(env, a[0], name)) return nullptr;
  sem_t* sem = sem_open(name.c_str(), O_CREAT | O_EXCL, 0600, 0);
  if (sem == SEM_FAILED) return fail(env, "SHM_SIGNAL", std::string("sem_open: ") + strerror(errno));
  auto* s = new Signal; s->sem = sem; s->name = name; s->owner = true; s->sender = true;
  return signalWrap(env, s);
}
napi_value SignalOpen(napi_env env, napi_callback_info info) {
  napi_value a[1]; std::string name;
  if (!args(env, info, 1, a) || !nameArg(env, a[0], name)) return nullptr;
  sem_t* sem = sem_open(name.c_str(), 0);
  if (sem == SEM_FAILED) return fail(env, "SHM_SIGNAL", strerror(errno));
  auto* s = new Signal; s->sem = sem; s->name = name; s->sender = true;
  return signalWrap(env, s);
}
napi_value SignalWatch(napi_env env, napi_callback_info info) {
  napi_value a[2]; std::string name; napi_valuetype type;
  if (!args(env, info, 2, a) || !nameArg(env, a[0], name)) return nullptr;
  if (napi_typeof(env, a[1], &type) != napi_ok || type != napi_function) return fail(env, "SHM_ARGUMENT", "Expected notification callback");
  sem_t* sem = sem_open(name.c_str(), 0);
  if (sem == SEM_FAILED) return fail(env, "SHM_SIGNAL", std::string("sem_open: ") + strerror(errno));
  auto* s = new Signal; s->sem = sem; s->name = name;
  // One receiver per process/channel, including worker-thread environments.
  // Otherwise a second receiver could steal the cancellation wakeup.
  {
    std::lock_guard<std::mutex> lock(receiverMutex);
    if (!receiverNames.insert(name).second) {
      sem_close(sem); delete s; return fail(env, "SHM_SIGNAL", "Notification channel already has a receiver in this process");
    }
    s->registered = true;
  }
  napi_value label; napi_create_string_utf8(env, "canvas-notify", NAPI_AUTO_LENGTH, &label);
  if (napi_create_threadsafe_function(env, a[1], nullptr, label, 1, 1, nullptr, nullptr, nullptr, signalCallJs, &s->callback) != napi_ok) {
    signalDispose(s); delete s; return fail(env, "SHM_SIGNAL", "Cannot create notification callback");
  }
  napi_unref_threadsafe_function(env, s->callback);
  try {
    s->thread = std::thread([s] {
      while (!s->closed.load()) {
        int result;
        do { result = sem_wait(s->sem); } while (result != 0 && errno == EINTR && !s->closed.load());
        if (s->closed.load() || result != 0) break;
        // Bounded coalescing; event cursors, not semaphore counts, track delivery.
        for (int i = 0; i < 64 && sem_trywait(s->sem) == 0; i++) {}
        const auto status = napi_call_threadsafe_function(s->callback, nullptr, napi_tsfn_nonblocking);
        if (status != napi_ok && status != napi_queue_full) break;
      }
    });
  } catch (const std::system_error& e) {
    signalDispose(s); delete s; return fail(env, "SHM_SIGNAL", e.what());
  }
  return signalWrap(env, s);
}
napi_value SignalPost(napi_env env, napi_callback_info info) {
  napi_value a[1]; if (!args(env, info, 1, a)) return nullptr;
  auto* s = signalHandle(env, a[0]); if (!s) return nullptr;
  if (s->closed.load()) return fail(env, "SHM_CLOSED", "Notification handle closed");
  if (!s->sender) return fail(env, "SHM_READ_ONLY", "Receiver cannot publish notifications");
  if (sem_post(s->sem) != 0 && errno != EOVERFLOW) return fail(env, "SHM_SIGNAL", strerror(errno));
  return a[0];
}
napi_value SignalClose(napi_env env, napi_callback_info info) {
  napi_value a[1]; if (!args(env, info, 1, a)) return nullptr;
  auto* s = signalHandle(env, a[0]); if (!s) return nullptr;
  if (s->cleanup) { napi_remove_env_cleanup_hook(env, signalEnvCleanup, s); s->cleanup = false; }
  signalDispose(s); return a[0];
}
napi_value SignalRemove(napi_env env, napi_callback_info info) {
  napi_value a[1]; std::string name;
  if (!args(env, info, 1, a) || !nameArg(env, a[0], name)) return nullptr;
  if (sem_unlink(name.c_str()) != 0 && errno != ENOENT) return fail(env, "SHM_SIGNAL", strerror(errno));
  return a[0];
}
void InitNotifications(napi_env env, napi_value exports) {
  const napi_property_descriptor methods[] = {
    {"signalCreate", nullptr, SignalCreate, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"signalOpen", nullptr, SignalOpen, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"signalWatch", nullptr, SignalWatch, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"signalPost", nullptr, SignalPost, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"signalClose", nullptr, SignalClose, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"signalRemove", nullptr, SignalRemove, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
}
