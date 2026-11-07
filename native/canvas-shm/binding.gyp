{
  "targets": [{
    "target_name": "canvas_shm",
    "sources": ["canvas-shm.cc"],
    "defines": ["NAPI_VERSION=8"],
    "cflags_cc": ["-std=c++17", "-Wall", "-Wextra"],
    "xcode_settings": {"CLANG_CXX_LANGUAGE_STANDARD": "c++17", "MACOSX_DEPLOYMENT_TARGET": "11.0"},
    "conditions": [["OS=='linux'", {"libraries": ["-lrt"]}]]
  }]
}
