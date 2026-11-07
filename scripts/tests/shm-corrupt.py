# Test-only corruption of a fresh fixture-owned POSIX object. Never scans names.
import ctypes
import os
import sys

mode, name = sys.argv[1:3]
assert name.startswith('/scsh-')
lib = ctypes.CDLL(None, use_errno=True)
# shm_open is variadic on Darwin arm64: only declare its two fixed arguments
# so libffi passes mode_t in the correct variadic location.
lib.shm_open.argtypes = [ctypes.c_char_p, ctypes.c_int]
lib.shm_open.restype = ctypes.c_int
lib.mmap.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_longlong]
lib.mmap.restype = ctypes.c_void_p
lib.munmap.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
if mode == 'empty':
    fd = lib.shm_open(name.encode(), os.O_CREAT | os.O_EXCL | os.O_RDWR, ctypes.c_uint(0o600))
    assert fd >= 0, ctypes.get_errno()
    # Darwin may reject reopening a never-sized object outright. Size only the
    # header to simulate interrupted initialization on both platforms.
    os.ftruncate(fd, 64)
    os.close(fd)
else:
    fd = lib.shm_open(name.encode(), os.O_RDWR, ctypes.c_uint(0))
    assert fd >= 0, ctypes.get_errno()
    ptr = lib.mmap(None, 64, 3, 1, fd, 0)  # PROT_READ|PROT_WRITE, MAP_SHARED
    os.close(fd)
    assert ptr != ctypes.c_void_p(-1).value, ctypes.get_errno()
    field, value = int(sys.argv[3]), int(sys.argv[4])
    assert field in (1, 4, 5)
    ctypes.c_uint64.from_address(ptr + field * 8).value = value
    lib.munmap(ptr, 64)
