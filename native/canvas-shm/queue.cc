// Bounded POSIX SPSC queues. One claimed producer and consumer per generation.
// Payload bytes are atomic words; publish tail only after the entire slot commits.
#include <node_api.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
#include <fcntl.h>
#include <cerrno>
#include <cstring>
#include <string>
#include <vector>
#include <cstdint>

extern napi_value fail(napi_env, const char*, const std::string&);
extern bool nameArg(napi_env, napi_value, std::string&);
extern bool args(napi_env, napi_callback_info, size_t, napi_value*);
namespace {
constexpr uint64_t MAGIC = 0x5343534851554531ULL, VERSION = 1, SLOTS = 16, MAX_SEQ = 9007199254740991ULL;
constexpr size_t HEADER = 128;
enum Field { Magic, Version, Bytes, State, Head, Tail, Producer, Consumer };
static_assert(__atomic_always_lock_free(8, nullptr), "Shared queues require lock-free 64-bit atomics");
struct Queue { void* ptr; size_t size; bool owner, producer; std::string name; uint64_t bytes; };
const napi_type_tag TAG = {0xb323e29ddfd749a1ULL, 0xaba3d51c0e9002ecULL};
uint64_t load(uint64_t* p) { return __atomic_load_n(p, __ATOMIC_SEQ_CST); }
void store(uint64_t* p, uint64_t v) { __atomic_store_n(p, v, __ATOMIC_SEQ_CST); }
uint64_t* words(Queue* q) { return static_cast<uint64_t*>(q->ptr); }
void dispose(Queue* q) {
  if (q->ptr == MAP_FAILED) return;
  auto* h = words(q);
  // Closing either endpoint fences this process generation. Pi context changes
  // do not close endpoints; the process-scoped broker rebinds delivery instead.
  store(h + State, 2);
  if (q->owner) shm_unlink(q->name.c_str());
  munmap(q->ptr, q->size); q->ptr = MAP_FAILED;
}
void finalize(napi_env, void* data, void*) { auto* q = static_cast<Queue*>(data); dispose(q); delete q; }
napi_value wrap(napi_env env, Queue* q) {
  napi_value out;
  if (napi_create_object(env, &out) != napi_ok || napi_type_tag_object(env, out, &TAG) != napi_ok ||
      napi_wrap(env, out, q, finalize, nullptr, nullptr) != napi_ok) {
    dispose(q); delete q; return fail(env, "SHM_ALLOC", "Cannot wrap queue");
  }
  return out;
}
bool role(napi_env env, napi_value value, bool& producer) {
  char text[16]; size_t n = 0;
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string ||
      napi_get_value_string_utf8(env, value, text, sizeof(text), &n) != napi_ok ||
      (std::string(text, n) != "producer" && std::string(text, n) != "consumer")) {
    fail(env, "SHM_ARGUMENT", "Queue role must be producer or consumer"); return false;
  }
  producer = std::string(text, n) == "producer"; return true;
}
Queue* handle(napi_env env, napi_value value, int required = -1) {
  bool tagged = false; Queue* q = nullptr;
  if (napi_check_object_type_tag(env, value, &TAG, &tagged) != napi_ok || !tagged ||
      napi_unwrap(env, value, reinterpret_cast<void**>(&q)) != napi_ok || !q) {
    fail(env, "SHM_ARGUMENT", "Expected queue handle"); return nullptr;
  }
  if (q->ptr == MAP_FAILED || load(words(q) + State) != 1) { fail(env, "SHM_CLOSED", "Queue generation closed"); return nullptr; }
  if (load(words(q) + Magic) != MAGIC || load(words(q) + Version) != VERSION || load(words(q) + Bytes) != q->bytes) { fail(env, "SHM_CORRUPT", "Queue header changed"); return nullptr; }
  if (required >= 0 && int(q->producer) != required) { fail(env, "SHM_READ_ONLY", "Wrong queue role"); return nullptr; }
  return q;
}
bool counters(napi_env env, Queue* q, uint64_t& head, uint64_t& tail) {
  // Consumer can advance while producer reads, so sample head first.
  head = load(words(q) + Head); tail = load(words(q) + Tail);
  if (head > tail || tail > MAX_SEQ || tail - head > SLOTS) { fail(env, "SHM_CORRUPT", "Invalid queue counters"); return false; }
  return true;
}
uint64_t* slot(Queue* q, uint64_t seq) {
  return words(q) + HEADER / 8 + (seq % SLOTS) * (1 + q->bytes / 8);
}
napi_value number(napi_env env, uint64_t value) {
  napi_value out;
  if (napi_create_double(env, double(value), &out) != napi_ok) return fail(env, "SHM_ALLOC", "Cannot allocate queue sequence");
  return out;
}
}
napi_value QueueCreate(napi_env env, napi_callback_info info) {
  napi_value a[3]; std::string name; bool producer; double bytes;
  if (!args(env, info, 3, a) || !nameArg(env, a[0], name) || !role(env, a[1], producer)) return nullptr;
  if (napi_get_value_double(env, a[2], &bytes) != napi_ok || (bytes != 1024 && bytes != 16384)) return fail(env, "SHM_ARGUMENT", "Queue slot size must be 1024 or 16384");
  size_t size = HEADER + SLOTS * (8 + size_t(bytes));
  int fd = shm_open(name.c_str(), O_CREAT | O_EXCL | O_RDWR, 0600);
  if (fd < 0) return fail(env, errno == EEXIST ? "SHM_EXISTS" : "SHM_SYSTEM", strerror(errno));
  if (ftruncate(fd, off_t(size)) != 0) { int e = errno; close(fd); shm_unlink(name.c_str()); return fail(env, "SHM_SYSTEM", strerror(e)); }
  void* ptr = mmap(nullptr, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  int e = errno; close(fd);
  if (ptr == MAP_FAILED) { shm_unlink(name.c_str()); return fail(env, "SHM_SYSTEM", strerror(e)); }
  auto* q = new Queue{ptr, size, true, producer, name, uint64_t(bytes)}; auto* h = words(q);
  store(h + Magic, MAGIC); store(h + Version, VERSION); store(h + Bytes, uint64_t(bytes));
  store(h + (producer ? Producer : Consumer), uint64_t(getpid())); store(h + State, 1);
  return wrap(env, q);
}
napi_value QueueOpen(napi_env env, napi_callback_info info) {
  napi_value a[2]; std::string name; bool producer;
  if (!args(env, info, 2, a) || !nameArg(env, a[0], name) || !role(env, a[1], producer)) return nullptr;
  int fd = shm_open(name.c_str(), O_RDWR, 0);
  if (fd < 0) return fail(env, errno == ENOENT ? "SHM_MISSING" : "SHM_SYSTEM", strerror(errno));
  struct stat st{};
  if (fstat(fd, &st) != 0) { int e = errno; close(fd); return fail(env, "SHM_SYSTEM", strerror(e)); }
  size_t page = size_t(getpagesize()), maxSize = ((HEADER + SLOTS * (8 + 16384) + page - 1) / page) * page;
  if (st.st_uid != getuid() || (st.st_mode & 0077)) { close(fd); return fail(env, "SHM_PERMISSIONS", "Expected owner-only queue"); }
  if (st.st_size < off_t(HEADER + SLOTS * (8 + 1024)) || st.st_size > off_t(maxSize) || st.st_size % 8) {
    close(fd); return fail(env, "SHM_VERSION", "Invalid queue mapping size");
  }
  size_t size = size_t(st.st_size);
  void* ptr = mmap(nullptr, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  int e = errno; close(fd);
  if (ptr == MAP_FAILED) return fail(env, "SHM_SYSTEM", strerror(e));
  auto* q = new Queue{ptr, size, false, producer, name, 0}; auto* h = words(q);
  uint64_t bytes = load(h + Bytes), state = load(h + State);
  if (state != 1) {
    munmap(ptr, size); delete q;
    return fail(env, state == 2 ? "SHM_CLOSED" : "SHM_NOT_READY", "Queue generation closed or not initialized");
  }
  if (load(h + Magic) != MAGIC || load(h + Version) != VERSION ||
      (bytes != 1024 && bytes != 16384) || HEADER + SLOTS * (8 + bytes) > size) {
    munmap(ptr, size); delete q; return fail(env, "SHM_VERSION", "Incompatible or closed queue");
  }
  q->bytes = bytes;
  uint64_t zero = 0;
  if (!__atomic_compare_exchange_n(h + (producer ? Producer : Consumer), &zero, uint64_t(getpid()), false, __ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST)) {
    munmap(ptr, size); delete q; return fail(env, "SHM_BUSY", "Queue role already claimed");
  }
  return wrap(env, q);
}
napi_value QueuePush(napi_env env, napi_callback_info info) {
  napi_value a[2]; if (!args(env, info, 2, a)) return nullptr;
  auto* q = handle(env, a[0], 1); if (!q) return nullptr;
  bool buffer = false; napi_is_buffer(env, a[1], &buffer);
  if (!buffer) return fail(env, "SHM_ARGUMENT", "Expected Buffer");
  void* data; size_t length; napi_get_buffer_info(env, a[1], &data, &length);
  if (!length || length > q->bytes) return fail(env, "SHM_CAPACITY", "Message exceeds queue slot capacity");
  uint64_t head, tail; if (!counters(env, q, head, tail)) return nullptr;
  if (tail - head == SLOTS) return fail(env, "SHM_QUEUE_FULL", "Queue full; nothing was enqueued");
  if (tail == MAX_SEQ) return fail(env, "SHM_CAPACITY", "Queue sequence exhausted");
  // Allocate the JS result before commit: no fallible work after publishing tail.
  napi_value result = number(env, tail); if (!result) return nullptr;
  auto* s = slot(q, tail); store(s, length);
  for (size_t offset = 0; offset < length; offset += 8) {
    uint64_t value = 0; size_t n = length - offset < 8 ? length - offset : 8;
    memcpy(&value, static_cast<char*>(data) + offset, n); store(s + 1 + offset / 8, value);
  }
  store(words(q) + Tail, tail + 1); return result;
}
napi_value QueuePeek(napi_env env, napi_callback_info info) {
  napi_value a[1]; if (!args(env, info, 1, a)) return nullptr;
  auto* q = handle(env, a[0], 0); if (!q) return nullptr;
  uint64_t head, tail; if (!counters(env, q, head, tail)) return nullptr;
  if (head == tail) { napi_value out; napi_get_null(env, &out); return out; }
  auto* s = slot(q, head); uint64_t length = load(s);
  if (!length || length > q->bytes) return fail(env, "SHM_CORRUPT", "Invalid queue message length");
  std::vector<char> copy(length);
  for (size_t offset = 0; offset < length; offset += 8) {
    uint64_t value = load(s + 1 + offset / 8); size_t n = length - offset < 8 ? length - offset : 8;
    memcpy(copy.data() + offset, &value, n);
  }
  napi_value out, payload;
  if (napi_create_object(env, &out) != napi_ok) return fail(env, "SHM_ALLOC", "Cannot allocate queue result");
  if (napi_create_buffer_copy(env, length, copy.data(), nullptr, &payload) != napi_ok) return fail(env, "SHM_ALLOC", "Cannot copy queue message");
  napi_value sequence = number(env, head); if (!sequence) return nullptr;
  if (napi_set_named_property(env, out, "sequence", sequence) != napi_ok || napi_set_named_property(env, out, "payload", payload) != napi_ok) return fail(env, "SHM_ALLOC", "Cannot construct queue result");
  return out;
}
napi_value QueueShift(napi_env env, napi_callback_info info) {
  napi_value a[2]; if (!args(env, info, 2, a)) return nullptr;
  auto* q = handle(env, a[0], 0); if (!q) return nullptr;
  uint64_t head, tail; if (!counters(env, q, head, tail)) return nullptr;
  double expected;
  if (napi_get_value_double(env, a[1], &expected) != napi_ok || expected != double(head) || head == tail) return fail(env, "SHM_ARGUMENT", "Expected current nonempty queue sequence");
  store(words(q) + Head, head + 1); return a[0];
}
napi_value QueueState(napi_env env, napi_callback_info info) {
  napi_value a[1]; if (!args(env, info, 1, a)) return nullptr;
  auto* q = handle(env, a[0]); if (!q) return nullptr;
  uint64_t head, tail; if (!counters(env, q, head, tail)) return nullptr;
  napi_value out, used = number(env, tail - head); if (!used) return nullptr;
  napi_value capacity = number(env, SLOTS); if (!capacity) return nullptr;
  if (napi_create_object(env, &out) != napi_ok || napi_set_named_property(env, out, "used", used) != napi_ok ||
      napi_set_named_property(env, out, "capacity", capacity) != napi_ok) return fail(env, "SHM_ALLOC", "Cannot construct queue state");
  return out;
}
napi_value QueueClose(napi_env env, napi_callback_info info) {
  napi_value a[1]; if (!args(env, info, 1, a)) return nullptr;
  bool tagged = false; Queue* q = nullptr;
  if (napi_check_object_type_tag(env, a[0], &TAG, &tagged) != napi_ok || !tagged || napi_unwrap(env, a[0], reinterpret_cast<void**>(&q)) != napi_ok || !q) return fail(env, "SHM_ARGUMENT", "Expected queue handle");
  dispose(q); return a[0];
}
void InitQueues(napi_env env, napi_value exports) {
  const napi_property_descriptor methods[] = {
    {"queueCreate", nullptr, QueueCreate, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"queueOpen", nullptr, QueueOpen, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"queuePush", nullptr, QueuePush, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"queuePeek", nullptr, QueuePeek, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"queueShift", nullptr, QueueShift, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"queueState", nullptr, QueueState, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"queueClose", nullptr, QueueClose, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
}
