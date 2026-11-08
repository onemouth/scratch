// MIT. POSIX shared-memory snapshots; no V8 API or externally exposed pointers.
// Supported targets: macOS/Linux, lock-free aligned 64-bit hardware atomics.
#include <node_api.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <time.h>
#include <cmath>
#include <cerrno>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

static_assert(__atomic_always_lock_free(8, nullptr), "64-bit lock-free atomics required");
constexpr uint64_t MAGIC = 0x5343415443483031ULL, ABI = 1;
constexpr size_t HEADER = 64, MAX_CAPACITY = 4 * 1024 * 1024;
constexpr uint64_t READY = 1, UNAVAILABLE = 2, CLOSED = 3;
// All shared accesses, including payload, use sequentially consistent atomic
// operations. This deliberately conservative prototype avoids plain memcpy races
// and process-private locks/futexes. A writer crash leaves an odd seq; readers
// never spin indefinitely. Do not replace with non-atomic payload copies.
enum Field { Magic, Version, Capacity, State, Sequence, Length, Heartbeat, Pid };
struct Region { void* ptr = MAP_FAILED; size_t size = 0; bool writer = false; std::string name; };
const napi_type_tag TAG = {0x163876a92474fe11ULL, 0x956e424dfdc839acULL};
uint64_t nowMs() {
  timespec ts{}; clock_gettime(CLOCK_MONOTONIC, &ts);
  return uint64_t(ts.tv_sec) * 1000 + uint64_t(ts.tv_nsec) / 1000000;
}
uint64_t load(const uint64_t* p) { return __atomic_load_n(p, __ATOMIC_SEQ_CST); }
void store(uint64_t* p, uint64_t v) { __atomic_store_n(p, v, __ATOMIC_SEQ_CST); }
uint64_t* words(Region* r) { return static_cast<uint64_t*>(r->ptr); }
napi_value fail(napi_env env, const char* code, const std::string& message) {
  napi_throw_error(env, code, message.c_str()); return nullptr;
}
void dispose(Region* r) {
  if (r->ptr == MAP_FAILED) return;
  if (r->writer) { store(words(r) + State, CLOSED); shm_unlink(r->name.c_str()); }
  munmap(r->ptr, r->size); r->ptr = MAP_FAILED;
}
void finalize(napi_env, void* data, void*) { auto* r = static_cast<Region*>(data); dispose(r); delete r; }
Region* region(napi_env env, napi_value value) {
  bool tagged = false;
  if (napi_check_object_type_tag(env, value, &TAG, &tagged) != napi_ok || !tagged) {
    fail(env, "SHM_ARGUMENT", "Expected a shared-memory handle"); return nullptr;
  }
  Region* r = nullptr;
  if (napi_unwrap(env, value, reinterpret_cast<void**>(&r)) != napi_ok || !r) {
    fail(env, "SHM_ARGUMENT", "Invalid shared-memory handle"); return nullptr;
  }
  return r;
}
bool nameArg(napi_env env, napi_value v, std::string& name) {
  size_t n = 0;
  if (napi_get_value_string_utf8(env, v, nullptr, 0, &n) != napi_ok || n < 6 || n > 30) {
    fail(env, "SHM_ARGUMENT", "Name must be /scsh- followed by 1-24 ASCII letters, digits or hyphens"); return false;
  }
  std::vector<char> b(n + 1);
  napi_get_value_string_utf8(env, v, b.data(), b.size(), &n); name.assign(b.data(), n);
  if (name.compare(0, 6, "/scsh-") != 0 || name.size() < 7) {
    fail(env, "SHM_ARGUMENT", "Invalid shared-memory namespace"); return false;
  }
  for (size_t i = 6; i < name.size(); i++) {
    const char c = name[i];
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-')) {
      fail(env, "SHM_ARGUMENT", "Invalid shared-memory name"); return false;
    }
  }
  return true;
}
napi_value wrap(napi_env env, Region* r) {
  napi_value obj;
  if (napi_create_object(env, &obj) != napi_ok || napi_type_tag_object(env, obj, &TAG) != napi_ok ||
      napi_wrap(env, obj, r, finalize, nullptr, nullptr) != napi_ok) {
    dispose(r); delete r; return fail(env, "SHM_ALLOC", "Cannot create shared-memory handle");
  }
  return obj;
}
bool args(napi_env env, napi_callback_info info, size_t count, napi_value* values) {
  size_t n = count;
  if (napi_get_cb_info(env, info, &n, values, nullptr, nullptr) != napi_ok || n != count) {
    fail(env, "SHM_ARGUMENT", "Missing arguments"); return false;
  }
  return true;
}
napi_value Create(napi_env env, napi_callback_info info) {
  napi_value a[2]; std::string name; double capacity;
  if (!args(env, info, 2, a) || !nameArg(env, a[0], name)) return nullptr;
  if (napi_get_value_double(env, a[1], &capacity) != napi_ok || !std::isfinite(capacity) ||
      std::floor(capacity) != capacity || capacity < 4096 || capacity > MAX_CAPACITY || uint64_t(capacity) % 8) {
    return fail(env, "SHM_ARGUMENT", "Capacity must be an integer multiple of 8, between 4096 and 4194304 bytes");
  }
  const size_t size = HEADER + size_t(capacity);
  const int fd = shm_open(name.c_str(), O_CREAT | O_EXCL | O_RDWR, 0600);
  if (fd < 0) return fail(env, errno == EEXIST ? "SHM_EXISTS" : "SHM_SYSTEM", std::string("shm_open: ") + strerror(errno));
  // Darwin shm descriptors do not support fchmod (EINVAL), and fstat reports
  // mode=0 there. Creation mode 0600, reduced only by umask, never grants peers.
  if (ftruncate(fd, off_t(size)) != 0) {
    const int e = errno; close(fd); shm_unlink(name.c_str()); return fail(env, "SHM_SYSTEM", strerror(e));
  }
  void* ptr = mmap(nullptr, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  const int e = errno; close(fd);
  if (ptr == MAP_FAILED) { shm_unlink(name.c_str()); return fail(env, "SHM_SYSTEM", strerror(e)); }
  auto* r = new Region{ptr, size, true, name}; auto* h = words(r);
  store(h + Magic, MAGIC); store(h + Version, ABI); store(h + Capacity, uint64_t(capacity));
  store(h + Heartbeat, nowMs()); store(h + Pid, uint64_t(getpid()));
  // First publish makes this ready; zero state/sequence/length mean not ready.
  return wrap(env, r);
}
napi_value Open(napi_env env, napi_callback_info info) {
  napi_value a[1]; std::string name;
  if (!args(env, info, 1, a) || !nameArg(env, a[0], name)) return nullptr;
  const int fd = shm_open(name.c_str(), O_RDONLY, 0);
  if (fd < 0) return fail(env, errno == ENOENT ? "SHM_MISSING" : "SHM_SYSTEM", strerror(errno));
  struct stat st{};
  if (fstat(fd, &st) != 0) { const int e = errno; close(fd); return fail(env, "SHM_SYSTEM", strerror(e)); }
  if (st.st_uid != getuid() || (st.st_mode & 0077) != 0) { close(fd); return fail(env, "SHM_PERMISSIONS", "Expected owner-only shared memory"); }
  const size_t page = size_t(getpagesize());
  const size_t maxMapping = ((HEADER + MAX_CAPACITY + page - 1) / page) * page;
  // Darwin reports a page-rounded st_size; the logical capacity lives in the
  // committed header, and must fit the mapping, not equal its padded length.
  if (st.st_size < off_t(HEADER + 4096) || st.st_size > off_t(maxMapping) || st.st_size % 8 != 0) {
    close(fd); return fail(env, "SHM_NOT_READY", "Shared-memory size is invalid or initialization is incomplete");
  }
  const size_t size = size_t(st.st_size);
  void* ptr = mmap(nullptr, size, PROT_READ, MAP_SHARED, fd, 0);
  const int e = errno; close(fd);
  if (ptr == MAP_FAILED) return fail(env, "SHM_SYSTEM", strerror(e));
  auto* r = new Region{ptr, size, false, name}; auto* h = words(r);
  const auto state = load(h + State);
  if (state == 0) { dispose(r); delete r; return fail(env, "SHM_NOT_READY", "No committed snapshot"); }
  const auto capacity = load(h + Capacity);
  if (load(h + Magic) != MAGIC || load(h + Version) != ABI || capacity < 4096 ||
      capacity > MAX_CAPACITY || capacity % 8 || capacity > size - HEADER) {
    dispose(r); delete r; return fail(env, "SHM_VERSION", "Incompatible shared-memory header");
  }
  return wrap(env, r);
}
napi_value Write(napi_env env, napi_callback_info info) {
  napi_value a[2]; if (!args(env, info, 2, a)) return nullptr;
  Region* r = region(env, a[0]); if (!r) return nullptr;
  if (r->ptr == MAP_FAILED) return fail(env, "SHM_CLOSED", "Handle is closed");
  if (!r->writer) return fail(env, "SHM_READ_ONLY", "Reader cannot publish");
  bool isBuffer = false; napi_is_buffer(env, a[1], &isBuffer);
  if (!isBuffer) return fail(env, "SHM_ARGUMENT", "Expected Buffer payload");
  void* data; size_t length; napi_get_buffer_info(env, a[1], &data, &length);
  auto* h = words(r);
  if (length == 0 || length > r->size - HEADER) {
    store(h + State, UNAVAILABLE); return fail(env, "SHM_CAPACITY", "Snapshot exceeds capacity or is empty; old snapshot invalidated");
  }
  const auto seq = load(h + Sequence);
  if (seq & 1) return fail(env, "SHM_BUSY", "Writer sequence is incomplete");
  store(h + Sequence, seq + 1);
  store(h + Length, length);
  auto* payload = h + HEADER / 8;
  for (size_t offset = 0; offset < length; offset += 8) {
    uint64_t value = 0; const size_t n = length - offset < 8 ? length - offset : 8;
    memcpy(&value, static_cast<char*>(data) + offset, n); store(payload + offset / 8, value);
  }
  store(h + Heartbeat, nowMs()); store(h + State, READY); store(h + Sequence, seq + 2);
  return a[0];
}
napi_value Read(napi_env env, napi_callback_info info) {
  napi_value a[1]; if (!args(env, info, 1, a)) return nullptr;
  Region* r = region(env, a[0]); if (!r) return nullptr;
  if (r->ptr == MAP_FAILED) return fail(env, "SHM_CLOSED", "Handle is closed");
  auto* h = words(r);
  for (int attempt = 0; attempt < 8; attempt++) {
    const auto state = load(h + State), heartbeat = load(h + Heartbeat), now = nowMs();
    if (state == CLOSED) return fail(env, "SHM_CLOSED", "Publisher closed this generation");
    if (state == UNAVAILABLE) return fail(env, "SHM_UNAVAILABLE", "Publisher invalidated its snapshot");
    if (state != READY) return fail(env, "SHM_NOT_READY", "No committed snapshot");
    if (heartbeat > now || now - heartbeat > 5000) return fail(env, "SHM_STALE", "Publisher heartbeat expired");
    const auto seq = load(h + Sequence); if (seq & 1) continue;
    const auto length = load(h + Length);
    if (length == 0 || length > load(h + Capacity) || length > r->size - HEADER) return fail(env, "SHM_CORRUPT", "Invalid payload length");
    std::vector<char> copy(length); auto* payload = h + HEADER / 8;
    for (size_t offset = 0; offset < length; offset += 8) {
      const auto value = load(payload + offset / 8); const size_t n = length - offset < 8 ? length - offset : 8;
      memcpy(copy.data() + offset, &value, n);
    }
    if (load(h + Sequence) != seq || load(h + State) != READY) continue;
    napi_value result;
    if (napi_create_buffer_copy(env, length, copy.data(), nullptr, &result) != napi_ok) return fail(env, "SHM_ALLOC", "Cannot copy snapshot");
    return result;
  }
  return fail(env, "SHM_BUSY", "Snapshot changed during bounded read; try again");
}
napi_value Touch(napi_env env, napi_callback_info info) {
  napi_value a[1]; if (!args(env, info, 1, a)) return nullptr;
  Region* r = region(env, a[0]); if (!r) return nullptr;
  if (r->ptr == MAP_FAILED) return fail(env, "SHM_CLOSED", "Handle is closed");
  if (!r->writer) return fail(env, "SHM_READ_ONLY", "Reader cannot heartbeat");
  store(words(r) + Heartbeat, nowMs()); return a[0];
}
napi_value Invalidate(napi_env env, napi_callback_info info) {
  napi_value a[1]; if (!args(env, info, 1, a)) return nullptr;
  Region* r = region(env, a[0]); if (!r) return nullptr;
  if (r->ptr == MAP_FAILED) return fail(env, "SHM_CLOSED", "Handle is closed");
  if (!r->writer) return fail(env, "SHM_READ_ONLY", "Reader cannot invalidate");
  store(words(r) + State, UNAVAILABLE); return a[0];
}
napi_value Close(napi_env env, napi_callback_info info) {
  napi_value a[1]; if (!args(env, info, 1, a)) return nullptr;
  Region* r = region(env, a[0]); if (!r) return nullptr;
  dispose(r); return a[0];
}
// Explicit orphan cleanup only; no startup scanning or automatic deletion of
// unknown generations. Existing mappings survive name removal.
napi_value Remove(napi_env env, napi_callback_info info) {
  napi_value a[1]; std::string name;
  if (!args(env, info, 1, a) || !nameArg(env, a[0], name)) return nullptr;
  if (shm_unlink(name.c_str()) != 0 && errno != ENOENT) return fail(env, "SHM_SYSTEM", strerror(errno));
  return a[0];
}
extern void InitNotifications(napi_env env, napi_value exports);
extern void InitQueues(napi_env env, napi_value exports);
napi_value Init(napi_env env, napi_value exports) {
  const napi_property_descriptor methods[] = {
    {"create", nullptr, Create, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"open", nullptr, Open, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"write", nullptr, Write, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"read", nullptr, Read, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"touch", nullptr, Touch, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"invalidate", nullptr, Invalidate, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"close", nullptr, Close, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"remove", nullptr, Remove, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
  InitNotifications(env, exports); InitQueues(env, exports); return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
