{
  "targets": [{
    "target_name": "canvas_shm",
    "sources": ["canvas-shm.cc", "notify.cc"],
    "defines": ["NAPI_VERSION=8"],
    "cflags_cc!": ["-fno-exceptions"],
    "cflags_cc": ["-std=c++17", "-Wall", "-Wextra", "-pthread"],
    "xcode_settings": {"CLANG_CXX_LANGUAGE_STANDARD": "c++17", "MACOSX_DEPLOYMENT_TARGET": "11.0", "GCC_ENABLE_CPP_EXCEPTIONS": "YES"},
    "conditions": [["OS=='linux'", {"libraries": ["-lrt", "-pthread"]}]]
  }]
}
