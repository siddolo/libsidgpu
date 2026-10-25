add_executable(sidgpu-wav ../common/wav.c)
target_compile_definitions(sidgpu-wav PRIVATE SIDGPU_OPENGL_ES)
target_link_libraries(sidgpu-wav PRIVATE sidgpu PkgConfig::EGL PkgConfig::GLES)
