# Isolated native queue fixtures only. No filesystem-backed mmap or name scans.
import ctypes
import os
import sys
name, field, value = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
assert name.startswith('/scsh-') and field in (2, 5, 16, 17)
lib = ctypes.CDLL(None, use_errno=True)
lib.shm_open.argtypes = [ctypes.c_char_p, ctypes.c_int]
lib.shm_open.restype = ctypes.c_int
lib.mmap.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_longlong]
lib.mmap.restype = ctypes.c_void_p
lib.munmap.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
fd = lib.shm_open(name.encode(), os.O_RDWR, ctypes.c_uint(0))
assert fd >= 0, ctypes.get_errno()
ptr = lib.mmap(None, 256, 3, 1, fd, 0)
os.close(fd)
assert ptr != ctypes.c_void_p(-1).value, ctypes.get_errno()
ctypes.c_uint64.from_address(ptr + field * 8).value = value
lib.munmap(ptr, 256)
